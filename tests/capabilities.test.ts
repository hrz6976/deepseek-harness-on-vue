import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilities, capabilityHealth, recordCapabilityContribution, validateCapabilityManifest } from '@/kernel/capabilities';
import { mountPlugin } from '@/kernel/host';
import { capabilityPackagePath, persistCapabilityPackage, readCapabilityPackage } from '@/kernel/capability-package';
import { TrustedCapabilityHost } from '@/extension/capability-host';
import { reactive, ref } from 'vue';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';
import toolsPlugin, { type ToolsRuntime } from '@/plugins/tools';
import promptPlugin from '@/plugins/prompt';
import uiPlugin from '@/kernel/ui';
import { createSystemPlugin, runtime } from '@/kernel/cordis';
import { principalForContext } from '@/kernel/broker';
import fsPlugin from '@/plugins/fs';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';

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

test('runtime inventory owns contributions and Fiber disposal clears the registry', async () => {
  await mountPlugin('temporary-tool', { apply() { } });
  const entry = capabilities.get('temporary-tool')!;
  const dispose = recordCapabilityContribution('temporary-tool', 'tools', 'task_search');
  assert.deepEqual(entry.contributions.tools, ['task_search']);
  assert.equal('contributes' in entry.manifest, false);
  assert.equal(capabilityHealth(entry).state, 'healthy');
  dispose();
  assert.deepEqual(entry.contributions.tools, []);
  assert.equal(capabilityHealth(entry).state, 'healthy');
  await entry.fiber?.dispose();
  assert.equal(capabilities.has('temporary-tool'), false);
});

test('disposing a replaced registration leaves the current tool, prompt, panel and inventory intact', async () => {
  await applyTestPlugin(toolsPlugin);
  await applyTestPlugin(promptPlugin);
  await applyTestPlugin(uiPlugin);
  const oldDisposers: Array<() => Promise<void>> = [];
  const newDisposers: Array<() => Promise<void>> = [];
  const entry = await mountPlugin('replacing', {
    inject: ['tools', 'prompt', 'ui'],
    apply(ctx) {
      for (const [revision, disposers] of [['old', oldDisposers], ['new', newDisposers]] as const) {
        disposers.push(ctx.tools.register({ name: 'sample', description: revision, parameters: z.object({}), run: () => revision }));
        disposers.push(ctx.prompt.register({ name: 'sample', text: revision }));
        disposers.push(ctx.ui.register({ name: 'sample', region: 'main', component: { template: `<div>${revision}</div>` } }));
      }
    },
  }, { builtin: true });
  await entry.fiber?.await();
  for (const dispose of oldDisposers) await dispose();
  assert.equal(await runtime.tools.call('sample', {}), 'new');
  assert.equal(runtime.prompt.assemble(), 'new');
  assert.deepEqual(entry.contributions.tools, ['sample']);
  assert.deepEqual(entry.contributions.prompts, ['sample']);
  assert.deepEqual(entry.contributions.panels, ['sample']);
  assert.equal(capabilityHealth(entry).state, 'healthy');
  for (const dispose of newDisposers) await dispose();
  assert.deepEqual(runtime.tools.schemas(), []);
  assert.equal(runtime.prompt.assemble(), '');
  assert.deepEqual(entry.contributions.tools, []);
  assert.deepEqual(entry.contributions.prompts, []);
  assert.deepEqual(entry.contributions.panels, []);
});

test('legacy contribution declarations do not create a second runtime inventory', async () => {
  await mountPlugin('declared', { apply() { } }, {
    manifest: {
      id: 'declared', version: '1.0.0', title: 'Declared', scope: 'workspace',
      contributes: { tools: ['expected'] }, requires: {}, permissions: [],
    },
  });
  const entry = capabilities.get('declared')!;
  recordCapabilityContribution('declared', 'tools', 'surprise');
  const health = capabilityHealth(entry);
  assert.equal(health.state, 'healthy');
  assert.deepEqual(entry.contributions.tools, ['surprise']);
  assert.equal('contributes' in entry.manifest, false);
});

test('capability packages commit manifest and live source in one package revision', async () => {
  const files = reactive(new Map<string, string>());
  const fs = {
    files, ready: Promise.resolve(), read: (path: string) => files.get(path) ?? null, list: () => [...files.keys()],
    async write(path: string, content: string) { files.set(path, content); },
    async remove(path: string) { files.delete(path); },
  };
  await mountPlugin('package-demo', { apply() { } });
  const entry = capabilities.get('package-demo')!;
  recordCapabilityContribution('package-demo', 'tools', 'package_tool');
  const source = 'export default { setup() { return () => null } }';
  await persistCapabilityPackage(fs, entry, source);
  assert.equal(readCapabilityPackage(fs, 'package-demo')?.source, source);
  assert.doesNotMatch(fs.read(capabilityPackagePath('package-demo'))!, /"package_tool"/);
  assert.deepEqual(fs.list(), [capabilityPackagePath('package-demo')]);
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

test('workspace service blocks protected plugin paths for capability callers but permits kernel maintenance', async () => {
  await applyTestPlugin(createSystemPlugin('workspace', fsPlugin));
  let capabilityWrite!: (path: string, content: string) => Promise<void>;
  let capabilityRead!: (path: string) => string | null;
  const writer = await mountPlugin('workspace-writer', {
    inject: ['fs'],
    apply(ctx) {
      capabilityWrite = (path, content) => ctx.fs.write(path, content);
      capabilityRead = path => ctx.fs.read(path);
    },
  }, {
    manifest: {
      id: 'workspace-writer', version: '1.0.0', title: 'Workspace writer', scope: 'global',
      contributes: {}, requires: { providers: ['workspace'] }, permissions: [{ id: 'workspace.read' }, { id: 'workspace.write' }],
    },
  });
  await writer.fiber?.await();

  await assert.rejects(() => capabilityWrite('.plugins/page.js', 'tampered'), /source\/package is locked/);
  await assert.rejects(() => capabilityWrite('/.plugins//page.js/', 'tampered'), /source\/package is locked/);
  await assert.rejects(() => capabilityWrite('.harness/capabilities/mcp/index.js', 'tampered'), /internal state is manager-owned/);
  await assert.rejects(() => capabilityWrite('.harness/tasks/index.json', 'tampered'), /internal state is manager-owned/);
  await capabilityWrite('.plugins/run-js.js', 'editable');
  assert.equal(capabilityRead('.plugins/run-js.js'), 'editable');

  let kernelWrite!: (path: string, content: string) => Promise<void>;
  await applyTestPlugin(createSystemPlugin('manager', {
    inject: ['fs'],
    apply(ctx) { kernelWrite = (path, content) => ctx.fs.write(path, content); },
  }));
  await kernelWrite('.plugins/page.js', 'trusted');
  assert.equal(capabilityRead('.plugins/page.js'), 'trusted');
});

test('task-scoped Fiber is owned by the active task scope', async () => {
  const task = { id: 'task-1', capabilityIds: ['task-tool'] };
  let taskScope!: Context;
  const scopeFiber = await applyTestPlugin({ name: 'task:task-1', apply(ctx) { taskScope = ctx; } });
  await provideTestService('task', { activeTask: () => task, activeTaskId: ref('task-1'), scope: () => taskScope });
  await applyTestPlugin(toolsPlugin);
  const entry = await mountPlugin('task-tool', {
    inject: ['tools'],
    apply(ctx) {
      ctx.tools.register({ name: 'only_here', description: '', parameters: z.object({}), run: () => 'ok' });
    },
  }, {
    parent: taskScope,
    manifest: {
      id: 'task-tool', version: '1.0.0', title: 'Task tool', scope: 'task',
      contributes: { tools: ['only_here'] }, requires: {}, permissions: [],
    },
  });
  await entry.fiber?.await();
  const tools = runtime.reflect.get('tools') as ToolsRuntime;
  assert.deepEqual(tools.schemas().map(tool => tool.name), ['only_here']);
  await scopeFiber.dispose();
  assert.deepEqual(tools.schemas(), []);
  assert.equal(capabilities.has('task-tool'), false);
});

test('nested Cordis plugins inherit capability identity and contribution ownership', async () => {
  let systemScope!: Context;
  await applyTestPlugin(createSystemPlugin('manager', { apply(ctx) { systemScope = ctx; } }));
  await applyTestPlugin(toolsPlugin);
  let nestedId = '';
  const entry = await mountPlugin('composed', {
    inject: ['tools'],
    async apply(ctx) {
      await ctx.plugin({
        name: 'composed-child', inject: ['tools'],
        apply(child) {
          nestedId = principalForContext(child).id;
          child.tools.register({ name: 'nested_tool', description: '', parameters: z.object({}), run: () => 'ok' });
        },
      });
    },
  }, {
    parent: systemScope,
    manifest: {
      id: 'composed', version: '1.0.0', title: 'Composed', scope: 'global',
      contributes: { tools: ['nested_tool'] }, requires: { providers: ['workspace'] },
      permissions: [{ id: 'workspace.read' }],
    },
  });
  await entry.fiber?.await();
  assert.equal(nestedId, 'composed');
  assert.deepEqual(entry.contributions.tools, ['nested_tool']);
});
