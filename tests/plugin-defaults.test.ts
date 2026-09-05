import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundlePlugin } from '../scripts/plugin-bundle';
import { BUILTIN_CAPABILITIES } from '@/kernel/builtin-plugins';
import { modules } from '@/kernel/modules';
import { compilePlugin } from '@/kernel/compile';
import { legacyCapabilityManifest } from '@/kernel/capabilities';
import {
  assertWorkspaceMutationAllowed, lockedPluginNameFromPath, pluginPolicy,
} from '@/kernel/plugin-policy';
import { systemPluginNameFromPath } from '@/kernel/system-plugin-names';
import { createBrokerPlugin } from '@/kernel/broker';
import { createSystemPlugin, runtime } from '@/kernel/cordis';
import { mountPlugin, unmountPlugin } from '@/kernel/host';
import toolsPlugin from '@/plugins/tools';
import promptPlugin from '@/plugins/prompt';
import { assertPrincipalAuthorized } from '@/shared/capability-policy';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';
import uiPlugin from '@/kernel/ui';
import fsPlugin from '@/plugins/fs';
import { ref } from 'vue';
import { ModelConnection } from '@/entries/standalone/model-connection';

test('reserved system plugin paths cannot be mistaken for editable capabilities', () => {
  assert.equal(systemPluginNameFromPath('.plugins/loop.js'), 'loop');
  assert.equal(systemPluginNameFromPath('.plugins/page.js'), null);
  assert.equal(systemPluginNameFromPath('nested/.plugins/loop.js'), null);
});

test('every catalog entry has one native definition with the same identity', async () => {
  for (const [name, definition] of Object.entries(BUILTIN_CAPABILITIES)) {
    const { default: plugin } = await import(pathToFileURL(resolve(definition.entry)).href);
    assert.equal(plugin?.name, name, definition.entry);
    assert.equal(typeof plugin.apply, 'function', name);
    assert.equal(new Set(plugin.inject ?? []).size, (plugin.inject ?? []).length, name);
  }
});

test('the model-facing create_plugin example actually loads and contributes a working tool and panel', async () => {
  globalThis.__harness = Object.freeze({ modules });
  try {
    await applyTestPlugin(toolsPlugin);
    await applyTestPlugin(promptPlugin);
    await applyTestPlugin(uiPlugin);
    await provideTestService('manager', {});
    const { source } = await bundlePlugin(resolve(BUILTIN_CAPABILITIES['create-plugin']!.entry));
    const author = await mountPlugin('create-plugin', await compilePlugin('create-plugin', source), { builtin: true });
    await author.fiber?.await();
    const guidance = runtime.prompt.assemble();
    const example = guidance.slice(guidance.indexOf("import { z }"), guidance.indexOf('\nRules:'));
    const entry = await mountPlugin('dice-example', await compilePlugin('dice-example', example), { builtin: true });
    await entry.fiber?.await();
    assert.equal(await runtime.tools.call('dice', { sides: 1 }), '1');
    assert.deepEqual(entry.contributions.tools, ['dice']);
    assert.deepEqual(entry.contributions.panels, ['dice-panel']);
  } finally {
    await cleanupTestRuntime();
  }
});

test('standalone restores its connection without settings and settings activation does not reconnect', async () => {
  globalThis.__harness = Object.freeze({ modules });
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map([['harness.autoconnect', '1'], ['harness.mock', '1']]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  });
  try {
    const calls: unknown[] = [];
    let failMount = false;
    await provideTestService('manager', {
      async mount(name: string, config: unknown) { calls.push({ name, config }); return failMount ? 'Error: connection rejected' : 'mounted'; },
    });
    await applyTestPlugin({ name: 'test-connection', apply(ctx) { new ModelConnection(ctx); } });
    await runtime.modelConnection.restore();
    assert.equal(calls.length, 1);
    await applyTestPlugin(uiPlugin);
    const { source } = await bundlePlugin(resolve(BUILTIN_CAPABILITIES.settings!.entry));
    const entry = await mountPlugin('settings', await compilePlugin('settings', source), { builtin: true });
    await entry.fiber?.await();
    assert.deepEqual(calls, [{ name: 'llm', config: { cfg: { baseURL: '/proxy', model: 'deepseek-v4-flash', apiKey: '', mock: true } } }]);
    assert.deepEqual(entry.contributions.panels, ['settings']);
    await unmountPlugin('settings');
    failMount = true;
    await assert.rejects(runtime.modelConnection.connect({ ...runtime.modelConnection.config, model: 'rejected-model' }), /connection rejected/);
    assert.equal(storage.get('harness.model'), 'deepseek-v4-flash');
    assert.equal(runtime.modelConnection.config.model, 'deepseek-v4-flash');
  } finally {
    await cleanupTestRuntime();
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('both workspace editors use the service authority boundary for protected and ordinary files', async () => {
  globalThis.__harness = Object.freeze({ modules });
  try {
    await applyTestPlugin(createSystemPlugin('workspace', fsPlugin));
    await applyTestPlugin(createSystemPlugin('shell', {
      inject: ['fs'],
      async apply(ctx) {
        await Promise.all([
          ctx.fs.write('.plugins/page.js', 'original plugin'),
          ctx.fs.write('.harness/tasks/index.json', 'original tasks'),
        ]);
      },
    }));
    await applyTestPlugin(toolsPlugin);
    await applyTestPlugin(promptPlugin);
    await provideTestService('task', { activeTaskId: ref('task-1') });
    for (const name of ['file-editor', 'workspace-tools']) {
      const { source } = await bundlePlugin(resolve(BUILTIN_CAPABILITIES[name]!.entry));
      const entry = await mountPlugin(name, await compilePlugin(name, source), { builtin: true });
      await entry.fiber?.await();
    }
    assert.equal(runtime.tools.load('workspace.advanced'), true);
    assert.equal(await runtime.tools.call('file_editor', { command: 'write', path: 'demo.txt', content: 'a' }), 'wrote demo.txt (1 chars)');
    assert.equal(await runtime.tools.call('workspace_write', { path: 'demo.txt', content: 'b' }), 'wrote demo.txt (1 chars)');
    for (const path of ['.plugins/page.js', '/.plugins//page.js/', '.harness/tasks/index.json']) {
      assert.match(String(await runtime.tools.call('file_editor', { command: 'write', path, content: 'blocked' })), /locked|manager-owned/);
      assert.match(String(await runtime.tools.call('workspace_write', { path, content: 'blocked' })), /locked|manager-owned/);
      if (!path.startsWith('/')) {
        assert.match(String(await runtime.tools.call('workspace_remove', { path })), /locked|manager-owned/);
      }
    }
    assert.equal(await runtime.tools.call('file_editor', { command: 'view', path: '.plugins/page.js' }), 'original plugin');
    assert.equal(await runtime.tools.call('file_editor', { command: 'view', path: '.harness/tasks/index.json' }), 'original tasks');
  } finally {
    await cleanupTestRuntime();
  }
});

test('bundled page modules preserve caller identity, tools, and effect disposal', async () => {
  globalThis.__harness = Object.freeze({ modules });
  const { source, files } = await bundlePlugin(resolve(BUILTIN_CAPABILITIES.page!.entry));
  assert.ok(files.some(file => file.replaceAll('\\', '/').endsWith('/page/inspection.ts')));
  const calls: string[] = [];
  try {
    await applyTestPlugin(toolsPlugin);
    await applyTestPlugin(promptPlugin);
    await applyTestPlugin(createSystemPlugin('broker', createBrokerPlugin({
      async request(principal, request) {
        assert.equal(principal.kind, 'capability');
        assert.equal(principal.id, 'page');
        assertPrincipalAuthorized(principal, request);
        calls.push(request.provider);
        return { ok: true };
      },
      async *stream() { },
    })));
    const entry = await mountPlugin('page', await compilePlugin('page', source), { builtin: true });
    await entry.fiber?.await();
    assert.equal(runtime.tools.schemas().length, 19);
    assert.match(runtime.prompt.assemble(), /page_style_inspect/);
    assert.equal(await runtime.tools.call('page_query', { selector: 'main' }), '{"ok":true}');
    assert.deepEqual(calls, ['page']);
    await unmountPlugin('page');
    assert.deepEqual(runtime.tools.schemas(), []);
    assert.equal(runtime.prompt.assemble(), '');
  } finally {
    await cleanupTestRuntime();
  }
});

test('trusted plugin policy locks protected drafts and packages below the tool layer', () => {
  assert.equal(lockedPluginNameFromPath('.plugins/page.js'), 'page');
  assert.equal(lockedPluginNameFromPath('/.plugins//page.js/'), 'page');
  assert.equal(lockedPluginNameFromPath('.plugins/page.js/child'), 'page');
  assert.equal(lockedPluginNameFromPath('.harness/capabilities/compaction/index.js'), 'compaction');
  assert.equal(lockedPluginNameFromPath('.harness//capabilities/mcp//manifest.json'), 'mcp');
  assert.equal(lockedPluginNameFromPath('.plugins/run-js.js'), null);
  assert.deepEqual(pluginPolicy('loop'), { source: 'kernel', reload: 'idle' });
  assert.deepEqual(pluginPolicy('run-js'), { source: 'editable', reload: 'turn' });

  const capability = {
    kind: 'capability', id: 'writer', fiberId: 'writer:1', scope: 'global',
    providers: ['workspace'], permissions: ['workspace.write'],
  } as const;
  assert.throws(() => assertWorkspaceMutationAllowed(capability, '.plugins/page.js'), /source\/package is locked/);
  assert.throws(() => assertWorkspaceMutationAllowed(capability, '.harness/capabilities/mcp/manifest.json'), /internal state is manager-owned/);
  assert.throws(() => assertWorkspaceMutationAllowed(capability, '.harness/tasks/index.json'), /internal state is manager-owned/);
  assert.throws(() => assertWorkspaceMutationAllowed(capability, '/.plugins/'), /storage root is locked/);
  assert.doesNotThrow(() => assertWorkspaceMutationAllowed(capability, '.plugins/run-js.js'));
  assert.doesNotThrow(() => assertWorkspaceMutationAllowed({ ...capability, kind: 'system' }, '.plugins/page.js'));
});

test('every shipped TypeScript plugin survives the build transform and import registry', async () => {
  globalThis.__harness = Object.freeze({ modules });
  const compiled: string[] = [];
  for (const [name, definition] of Object.entries(BUILTIN_CAPABILITIES)) {
    const { source, files } = await bundlePlugin(resolve(definition.entry));
    const plugin = await compilePlugin(name, source);
    assert.equal(typeof plugin === 'object' && typeof plugin.apply, 'function', name);
    assert.ok(files.some(file => file.replaceAll('\\', '/').endsWith(definition.entry)), name);
    assert.equal(files.some(file => file.replaceAll('\\', '/').includes('/src/kernel/')), false,
      `${name} must use the shared public SDK instead of bundling private kernel state`);
    compiled.push(name);
  }

  assert.equal(compiled.includes('tools'), false);
  assert.equal(compiled.includes('loop'), false);
  assert.ok(compiled.includes('page'));

  const protectedPermissions = new Set([
    'capability.manage', 'workspace.write', 'llm.use', 'page.modify', 'page.interact', 'page.eval',
    'site-skill.manage', 'mcp.connect', 'mcp.use',
    'web.read',
  ]);
  for (const name of compiled) {
    const sensitive = legacyCapabilityManifest(name, true).permissions
      .some(permission => protectedPermissions.has(permission.id));
    if (sensitive) assert.equal(pluginPolicy(name).source, 'protected', `${name} has privileged shipped permissions`);
  }
});
