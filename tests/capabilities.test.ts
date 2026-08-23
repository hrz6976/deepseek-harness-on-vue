import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilities, capabilityHealth, recordCapabilityContribution, validateCapabilityManifest } from '../src/kernel/capabilities';
import { mountPlugin, plugins, unmountPlugin } from '../src/kernel/host';
import { capabilityIndexPath, capabilityManifestPath, capabilityVersionPath, persistCapabilityPackage, readCapabilityManifest } from '../src/kernel/capability-package';
import { TrustedCapabilityHost } from '../src/extension/capability-host';
import { reactive, ref } from 'vue';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';
import { toolsPlugin, type ToolsRuntime } from '../src/plugins/tools';
import { cordis } from '../src/kernel/cordis';
import { z } from 'zod';

afterEach(async () => { await cleanupTestRuntime(); });

test('capability manifests validate identity, version, provider and unique permissions', () => {
  const valid = validateCapabilityManifest({
    id: 'research-panel', version: '1.2.0', title: 'Research panel', scope: 'task',
    contributes: { tools: ['search'] }, requires: { providers: ['mcp'] },
    permissions: [{ id: 'mcp.read' }],
  }, 'research-panel');
  assert.equal(valid.id, 'research-panel');
  assert.throws(() => validateCapabilityManifest({ ...valid, id: 'other' }, 'research-panel'), /must match plugin name/);
  assert.throws(() => validateCapabilityManifest({ ...valid, version: 'latest' }), /semantic version/);
  assert.throws(() => validateCapabilityManifest({ ...valid, requires: { providers: ['shell' as never] } }), /unknown capability provider/);
  assert.throws(() => validateCapabilityManifest({ ...valid, permissions: [{ id: 'mcp.read' }, { id: 'mcp.read' }] }), /must be unique/);
});

test('generated manifests learn observed contributions and unmount clears the registry', async () => {
  await mountPlugin('temporary-tool', { apply() {} });
  const entry = capabilities.get('temporary-tool')!;
  const dispose = recordCapabilityContribution('temporary-tool', 'tools', 'task_search');
  assert.deepEqual(entry.contributions.tools, ['task_search']);
  assert.deepEqual(entry.manifest.contributes.tools, ['task_search']);
  assert.equal(capabilityHealth(entry).state, 'healthy');
  dispose();
  assert.deepEqual(entry.contributions.tools, []);
  assert.equal(capabilityHealth(entry).state, 'degraded');
  assert.equal(await unmountPlugin('temporary-tool'), true);
  assert.equal(capabilities.has('temporary-tool'), false);
});

test('declared manifests expose missing and undeclared runtime contributions', async () => {
  await mountPlugin('declared', { apply() {} }, {
    manifest: {
      id: 'declared', version: '1.0.0', title: 'Declared', scope: 'workspace',
      contributes: { tools: ['expected'] }, requires: {}, permissions: [],
    },
  });
  const entry = capabilities.get('declared')!;
  recordCapabilityContribution('declared', 'tools', 'surprise');
  const health = capabilityHealth(entry);
  assert.equal(health.state, 'degraded');
  assert.deepEqual(health.missing.tools, ['expected']);
  assert.deepEqual(health.undeclared.tools, ['surprise']);
});

test('capability packages persist manifest, live source and a version snapshot', async () => {
  const files = reactive(new Map<string, string>());
  const fs = {
    files, ready: Promise.resolve(), read: (path: string) => files.get(path) ?? null, list: () => [...files.keys()],
    async write(path: string, content: string) { files.set(path, content); },
    async remove(path: string) { files.delete(path); },
  };
  await mountPlugin('package-demo', { apply() {} });
  const entry = capabilities.get('package-demo')!;
  recordCapabilityContribution('package-demo', 'tools', 'package_tool');
  const source = 'export default { setup() { return () => null } }';
  await persistCapabilityPackage(fs, entry, source);
  assert.equal(fs.read(capabilityIndexPath('package-demo')), source);
  assert.equal(fs.read(capabilityVersionPath('package-demo', '0.1.0')), source);
  assert.match(fs.read(capabilityManifestPath('package-demo'))!, /"package_tool"/);
  assert.equal(readCapabilityManifest(fs, 'package-demo', false)?.source, 'generated');
});

test('trusted providers enforce declared provider, permission, and task identity', async () => {
  const host = new TrustedCapabilityHost();
  host.register('page', { request: async () => ({ ok: true }) });
  const request = { provider: 'page', action: 'command', input: { command: { type: 'page/snapshot' } } } as const;
  const base = {
    kind: 'capability' as const,
    id: 'reader',
    fiberId: 'reader:1',
    scope: 'task' as const,
    providers: ['page'] as const,
    permissions: ['page.read'],
  };

  await assert.rejects(() => host.request(request, { tabId: 1, principal: base }), /no active task identity/);
  await assert.rejects(() => host.request(request, {
    tabId: 1,
    principal: { ...base, scope: 'global', providers: [] },
  }), /did not declare provider/);
  await assert.rejects(() => host.request(request, {
    tabId: 1,
    principal: { ...base, scope: 'global', permissions: [] },
  }), /lacks permission/);
  assert.deepEqual(await host.request(request, {
    tabId: 1,
    principal: { ...base, taskId: 'task-1' },
  }), { ok: true });
});

test('task-scoped contributions are visible only on tasks that attach the capability', async () => {
  const task = { id: 'task-1', capabilityIds: [] as string[] };
  await provideTestService('task', { activeTask: () => task, activeTaskId: ref('task-1') });
  await applyTestPlugin(toolsPlugin);
  const entry = await mountPlugin('task-tool', {
    inject: ['tools'],
    apply(ctx) {
      ctx.tools.register({ name: 'only_here', description: '', parameters: z.object({}), run: () => 'ok' });
    },
  }, {
    manifest: {
      id: 'task-tool', version: '1.0.0', title: 'Task tool', scope: 'task',
      contributes: { tools: ['only_here'] }, requires: {}, permissions: [],
    },
  });
  await entry.fiber?.await();
  const tools = cordis.reflect.get('tools') as ToolsRuntime;
  assert.deepEqual(tools.schemas().map(tool => tool.name), []);
  task.capabilityIds.push('task-tool');
  assert.deepEqual(tools.schemas().map(tool => tool.name), ['only_here']);
});
