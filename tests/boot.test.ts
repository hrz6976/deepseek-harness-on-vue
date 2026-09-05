// Boot + manager lifecycle tests: seeding semantics (write-if-missing is what
// keeps agent modifications alive across refreshes), fail-soft mounting, and
// the manager's mount/unmount/HMR policies. Runs the REAL
// manager initialization and lifecycle in Node against a fake (reactive) fs
// service; compilePlugin exercises its new Function fallback here (blob:
// imports don't exist in Node), which is also why plugin defs never render.
// Run: npm test
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { reactive, nextTick } from 'vue';
import { PLUGIN_DIR, readCapabilityPackage } from '@/kernel/capability-package';
import { modules } from '@/kernel/modules';
import { mountPlugin } from '@/kernel/host';
import uiKernelPlugin, { UiService } from '@/kernel/ui';
import managerPlugin, { createManagerPlugin } from '@/plugins/manager';
import { createTaskRuntimePlugin } from '@/plugins/task-runtime';
import toolsPlugin from '@/plugins/tools';
import promptPlugin from '@/plugins/prompt';
import loopPlugin from '@/plugins/loop';
import fsPlugin from '@/plugins/fs';
import { capabilities, legacyCapabilityManifest } from '@/kernel/capabilities';
import { createSystemPlugin, runtime } from '@/kernel/cordis';
import type { TaskRuntimeService } from '@/shared/runtime';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';

globalThis.__harness = { modules }; // what compiled plugin code reads its imports from

// Legacy layout fixtures exercise upgrade without writing old files again.
const capabilityIndexPath = id => `.harness/capabilities/${id}/index.js`;
const capabilityManifestPath = id => `.harness/capabilities/${id}/manifest.json`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SRC = marker => `export default { name: 'fixture', apply() {} }; // ${marker}`;
const TOOL_HOOK_SRC = marker => `
  export const inject = ['tools'];
  export function apply(ctx) {
    ctx.tools.registerSchema({
      name: 'versioned_tool',
      description: 'tool:${marker}',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: () => 'result:${marker}',
    });
    ctx.on('llm/request', (request, next) => {
      request.systemPrompt += '\\nhook:${marker}';
      return next(request);
    });
  }
`;
const plugins = () => [...capabilities.values()];

const boot = (defaults, options = {}) => applyTestPlugin(createManagerPlugin({ defaults, ...options }, false));

function fakeFs(initial = {}) {
  const cache = reactive(new Map(Object.entries(initial)));
  return {
    files: cache, ready: Promise.resolve(),
    read: p => (cache.has(p) ? cache.get(p) : null),
    list: () => [...cache.keys()].sort(),
    async write(p, c) { const value = String(c ?? ''); cache.set(p, value); runtime.emit('workspace/changed', p, value); },
    async remove(p) { if (cache.delete(p)) runtime.emit('workspace/changed', p, null); },
  };
}

beforeEach(async () => { await cleanupTestRuntime(); });
after(async () => { await cleanupTestRuntime(); });

// -------------------------------------------------------------------- boot --
test('boot: seeds missing files and mounts everything auto-mountable', async () => {
  const fs = fakeFs();
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('alpha') }, llm: { source: SRC('llm'), autoMount: false } }, { search: '' });
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), SRC('alpha'));       // seeded
  assert.equal(fs.read(PLUGIN_DIR + 'llm.js'), SRC('llm'));           // seeded too…
  assert.deepEqual(plugins().map(p => p.manifest.id), ['alpha']);        // …but not mounted
  assert.equal(plugins()[0].manifest.scope, 'global');
});

test('boot: never overwrites an existing (agent-modified) file — and mounts FROM it', async () => {
  const modified = SRC('agent-was-here');
  const fs = fakeFs({ [PLUGIN_DIR + 'alpha.js']: modified });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('shipped') } }, { search: '' });
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), modified);
  assert.deepEqual(plugins().map(p => p.manifest.id), ['alpha']);
});

test('boot: agent-created extras (no manifest entry) mount after manifest order', async () => {
  const fs = fakeFs({ [PLUGIN_DIR + 'zzz-user.js']: SRC('user') });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('a') }, beta: { source: SRC('b') } }, { search: '' });
  assert.deepEqual(plugins().map(p => p.manifest.id), ['alpha', 'beta', 'zzz-user']);
  assert.equal(plugins().find(p => p.manifest.id === 'zzz-user')!.manifest.scope, 'task');
});

test('boot: loads stored sources directly without a pre-release format gate', async () => {
  const stored = SRC('agent-edited');
  const fs = fakeFs({ [PLUGIN_DIR + 'alpha.js']: stored, [PLUGIN_DIR + 'user.js']: SRC('user') });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('shipped') } }, { search: '' });
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), stored);
  assert.deepEqual(plugins().map(p => p.manifest.id), ['alpha', 'user']);
});

test('boot: removes legacy OPFS copies of reserved system plugins', async () => {
  const fs = fakeFs({
    [PLUGIN_DIR + 'loop.js']: SRC('stale-loop'),
    [PLUGIN_DIR + 'llm.js']: SRC('stale-llm'),
    '.harness/capabilities/loop/manifest.json': '{}',
    '.harness/capabilities/loop/index.js': SRC('stale-active-loop'),
  });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('alpha') }, llm: { source: SRC('shipped-llm') } }, { search: '', reservedNames: ['loop', 'llm'] });

  assert.equal(fs.read(PLUGIN_DIR + 'loop.js'), null);
  assert.equal(fs.read(PLUGIN_DIR + 'llm.js'), null);
  assert.equal(fs.read('.harness/capabilities/loop/manifest.json'), null);
  assert.equal(fs.read('.harness/capabilities/loop/index.js'), null);
  assert.deepEqual(plugins().map(plugin => plugin.manifest.id), ['alpha']);
});

test('boot: updates an untouched generated builtin from the new shipped source', async () => {
  const previous = SRC('previous-shipped');
  const next = SRC('next-shipped');
  const manifest = legacyCapabilityManifest('alpha', true);
  const fs = fakeFs({
    [PLUGIN_DIR + 'alpha.js']: previous,
    [capabilityIndexPath('alpha')]: previous,
    [capabilityManifestPath('alpha')]: `${JSON.stringify(manifest)}\n`,
  });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: next } }, { search: '' });
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), next);
  assert.equal(readCapabilityPackage(fs, 'alpha')?.source, next);
});

test('boot: preserves edited builtins and uncommitted drafts during a shipped update', async () => {
  const active = SRC('active-shipped');
  const edited = SRC('agent-edited');
  const editedManifest = { ...legacyCapabilityManifest('alpha', true), version: '0.1.1' };
  const editedFs = fakeFs({
    [PLUGIN_DIR + 'alpha.js']: edited,
    [capabilityIndexPath('alpha')]: edited,
    [capabilityManifestPath('alpha')]: `${JSON.stringify(editedManifest)}\n`,
  });
  await provideTestService('fs', editedFs);
  await boot({ alpha: { source: SRC('new-shipped') } }, { search: '' });
  assert.equal(editedFs.read(PLUGIN_DIR + 'alpha.js'), edited);
  await cleanupTestRuntime();

  const draft = SRC('working-draft');
  const draftFs = fakeFs({
    [PLUGIN_DIR + 'alpha.js']: draft,
    [capabilityIndexPath('alpha')]: active,
    [capabilityManifestPath('alpha')]: `${JSON.stringify(legacyCapabilityManifest('alpha', true))}\n`,
  });
  await provideTestService('fs', draftFs);
  await boot({ alpha: { source: SRC('newer-shipped') } }, { search: '' });
  assert.equal(draftFs.read(PLUGIN_DIR + 'alpha.js'), draft);
  assert.equal(readCapabilityPackage(draftFs, 'alpha')?.manifest.version, '0.1.1');
});

test('boot: one broken file is skipped, the rest of the app comes up', async () => {
  const fs = fakeFs({ [PLUGIN_DIR + 'broken.js']: 'export default {{{' });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('a') } }, { search: '' });
  assert.deepEqual(plugins().map(p => p.manifest.id), ['alpha']);
});

test('boot: a broken working draft restores the last active capability revision', async () => {
  const active = SRC('active');
  const fs = fakeFs({
    [PLUGIN_DIR + 'alpha.js']: 'export default {{{',
    [capabilityIndexPath('alpha')]: active,
    [capabilityManifestPath('alpha')]: JSON.stringify(legacyCapabilityManifest('alpha', true)),
  });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('shipped') } }, { search: '' });
  const entry = plugins().find(plugin => plugin.manifest.id === 'alpha');
  assert.equal(entry?.status, 'active');
  assert.match(entry?.hmrError ?? '', /Working draft rejected/);
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), 'export default {{{');
});

test('boot: ?reset wipes .plugins/ and reseeds shipped state', async () => {
  const fs = fakeFs({
    [PLUGIN_DIR + 'alpha.js']: SRC('agent-modified'),
    [PLUGIN_DIR + 'user.js']: SRC('user-made'),
    'index.html': '<p>agent work outside .plugins/ survives</p>',
  });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('shipped') } }, { search: '?reset' });
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), SRC('shipped'));     // factory copy
  assert.equal(fs.read(PLUGIN_DIR + 'user.js'), null);                // user plugin gone
  assert.equal(fs.read('index.html'), '<p>agent work outside .plugins/ survives</p>');
  assert.deepEqual(plugins().map(p => p.manifest.id), ['alpha']);
});

// ----------------------------------------------------------------- manager --
// Manager is a real Cordis plugin; its HMR effects belong to its test Fiber.
async function mountManager(files, defaults = null) {
  const fs = fakeFs(files);
  await provideTestService('fs', fs);
  await applyTestPlugin(defaults
    ? createManagerPlugin({ defaults, search: '' }, false)
    : managerPlugin);
  await sleep(0); // let the adopt-existing-files pass run (it awaits fs.ready)
  let mgr;
  const caller = await mountPlugin('manager-test-client', {
    inject: ['manager'],
    apply(ctx) { mgr = ctx.manager; },
  }, {
    manifest: {
      id: 'manager-test-client', version: '1.0.0', title: 'Manager test client', scope: 'global',
      contributes: {}, requires: {}, permissions: [{ id: 'capability.manage' }],
    },
  });
  await caller.fiber?.await();
  return { fs, mgr };
}

test('manager: mount passes config through; HMR reload preserves it', async () => {
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'alpha.js']: SRC('v1') });
  assert.match(await mgr.mount('alpha', { cfg: { model: 'm1' } }), /mounted/);
  const entry = plugins().find(p => p.manifest.id === 'alpha');
  assert.deepEqual(entry.config, { cfg: { model: 'm1' } });
  const v = entry.version;
  await fs.write(PLUGIN_DIR + 'alpha.js', SRC('v2'));                 // agent edits the file
  await nextTick(); await sleep(400);                                 // event + 300ms debounce
  const reloaded = plugins().find(p => p.manifest.id === 'alpha');
  assert.equal(reloaded.version, v + 1);                              // replacement Fiber
  assert.deepEqual(reloaded.config, { cfg: { model: 'm1' } });        // config survived
});

test('manager: unmount keeps the file; a later edit does NOT surprise-remount', async () => {
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'alpha.js']: SRC('v1') });
  await mgr.mount('alpha', { cfg: {} });
  assert.match(await mgr.unmount('alpha'), /file kept/);
  assert.equal(plugins().find(p => p.manifest.id === 'alpha'), undefined);
  assert.equal(mgr.catalog().find(p => p.id === 'alpha')?.status, 'disposed');
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), SRC('v1'));
  await fs.write(PLUGIN_DIR + 'alpha.js', SRC('v2'));
  await nextTick(); await sleep(400);
  assert.equal(plugins().find(p => p.manifest.id === 'alpha'), undefined); // still unmounted
  await mgr.mount('alpha', { cfg: {} });                              // explicit remount uses the NEW source
  assert.match(plugins().find(p => p.manifest.id === 'alpha') ? 'ok' : 'missing', /ok/);
  assert.match(await mgr.remove('alpha'), /source are gone/);
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), null);
  await fs.write(PLUGIN_DIR + 'beta.js', SRC('idle'));
  assert.match(await mgr.remove('beta'), /not running/);
  assert.equal(fs.read(PLUGIN_DIR + 'beta.js'), null);
});

test('manager: create publishes a visible task capability instead of only writing source', async () => {
  const { fs, mgr } = await mountManager({});
  await applyTestPlugin(uiKernelPlugin);
  await applyTestPlugin(createTaskRuntimePlugin());
  const task = runtime.reflect.get('task') as TaskRuntimeService;
  await task.ready;
  const result = await mgr.create('mcp-panel', `
    export const inject = ['ui'];
    export function apply(ctx) {
      ctx.ui.register({ name: 'mcp-status', region: 'main', component: { template: '<p>MCP ready</p>' } });
    }
  `);
  assert.match(result, /visible UI: mcp-status/);
  assert.equal(fs.read(`${PLUGIN_DIR}mcp-panel.js`) != null, true);
  assert.deepEqual(task.activeTask()?.capabilityIds, ['mcp-panel']);
  assert.equal((runtime.reflect.get('ui') as UiService).contributions.has('mcp-panel:mcp-status'), true);
});

test('manager: create refuses to replace an existing capability', async () => {
  const original = SRC('original-alpha');
  const replacement = SRC('replacement-alpha');
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'alpha.js']: original });
  assert.match(await mgr.mount('alpha'), /mounted/);
  const active = capabilities.get('alpha');

  assert.match(await mgr.create('alpha', replacement), /already exists/);
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), original);
  assert.equal(capabilities.get('alpha'), active);
});

test('manager: protected shipped capability always uses trusted source and cannot self-update', async () => {
  const trusted = SRC('trusted-llm');
  const tampered = SRC('agent-llm');
  const { fs, mgr } = await mountManager(
    { [PLUGIN_DIR + 'llm.js']: tampered },
    { llm: { source: trusted, autoMount: false } },
  );

  assert.equal(fs.read(PLUGIN_DIR + 'llm.js'), trusted);
  const catalog = mgr.catalog().find(entry => entry.id === 'llm');
  assert.equal(catalog?.source, 'protected');
  assert.equal(catalog?.editable, false);
  assert.equal(catalog?.reloadBoundary, 'turn');
  assert.match(await mgr.create('llm', tampered), /protected/);

  assert.match(await mgr.mount('llm', { cfg: { model: 'm1' } }), /mounted/);
  const entry = capabilities.get('llm')!;
  assert.equal(entry.manifest.scope, 'global');
  assert.ok(entry.manifest.permissions.some(permission => permission.id === 'llm.use'));
  const version = entry.version;

  // fakeFs intentionally bypasses the workspace provider so this also proves
  // manager-side HMR refuses a protected draft that arrived through a stale
  // or otherwise out-of-band writer.
  await fs.write(PLUGIN_DIR + 'llm.js', tampered);
  await runtime.parallel('loop/safe-point', { turn: 1, reason: 'tool-calls-complete' });
  assert.equal(capabilities.get('llm')?.version, version);
  assert.match(await mgr.remove('llm'), /protected/);
});

test('manager: trusted maintenance can persist a protected on-demand mount through the real workspace guard', async () => {
  const trusted = SRC('trusted-llm');
  await applyTestPlugin(createSystemPlugin('workspace', fsPlugin));
  await applyTestPlugin(createSystemPlugin('manager', createManagerPlugin({
    defaults: { llm: { source: trusted, autoMount: false } }, search: '',
  }, false)));

  let mgr;
  let read;
  const caller = await mountPlugin('settings-test-client', {
    inject: ['manager', 'fs'], apply(ctx) { mgr = ctx.manager; read = path => ctx.fs.read(path); },
  }, {
    manifest: {
      id: 'settings-test-client', version: '1.0.0', title: 'Settings test client', scope: 'global',
      contributes: {}, requires: { providers: ['workspace'] },
      permissions: [{ id: 'capability.manage' }, { id: 'workspace.read' }],
    },
  });
  await caller.fiber?.await();

  assert.match(await mgr.mount('llm', { cfg: { model: 'm1' } }), /mounted/);
  assert.equal(capabilities.get('llm')?.manifest.scope, 'global');
  assert.equal(readCapabilityPackage({ read } as never, 'llm')?.source, trusted);
});

test('manager: recreated capability does not inherit an orphaned package manifest', async () => {
  const privileged = {
    id: 'recreated', version: '1.0.0', title: 'Old capability', scope: 'global',
    contributes: {}, requires: { providers: ['mcp'] }, permissions: [{ id: 'mcp.use' }],
  };
  const { mgr } = await mountManager({
    [capabilityManifestPath('recreated')]: JSON.stringify(privileged),
  });

  assert.match(await mgr.create('recreated', SRC('fresh')), /mounted/);
  const manifest = capabilities.get('recreated')?.manifest;
  assert.equal(manifest?.scope, 'task');
  assert.deepEqual(manifest?.requires, {});
  assert.deepEqual(manifest?.permissions, []);
});

test('manager remounts attached task capabilities under each active task Fiber', async () => {
  const { mgr } = await mountManager({ [PLUGIN_DIR + 'alpha.js']: SRC('task') });
  await applyTestPlugin(createTaskRuntimePlugin());
  const task = runtime.reflect.get('task') as TaskRuntimeService;
  await task.ready;
  const first = task.activeTask()!;
  assert.match(await mgr.mount('alpha'), /mounted/);
  const firstFiber = capabilities.get('alpha')?.fiber;

  await task.createTask('Second');
  assert.equal(firstFiber?.uid, null);
  assert.equal(capabilities.has('alpha'), false);
  await task.activateTask(first.id);
  assert.equal(capabilities.get('alpha')?.status, 'active');
  assert.notEqual(capabilities.get('alpha')?.fiber, firstFiber);
});

test('manager: safe points commit the latest debounce candidate; idle remains the terminal fallback', async () => {
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'alpha.js']: SRC('v1') });
  await mgr.mount('alpha');
  const entry = plugins().find(p => p.manifest.id === 'alpha');
  const v = entry.version;
  await runtime.parallel('loop/busy');
  await fs.write(PLUGIN_DIR + 'alpha.js', SRC('v2'));
  await fs.write(PLUGIN_DIR + 'alpha.js', SRC('v1'));
  await nextTick();
  assert.equal(entry.version, v);                                     // current generation is still active
  await runtime.parallel('loop/safe-point', { turn: 1, reason: 'tool-calls-complete' });
  assert.equal(plugins().find(p => p.manifest.id === 'alpha')!.version, v); // undo cancelled the stale v2 candidate

  await fs.write(PLUGIN_DIR + 'alpha.js', SRC('v2'));
  await runtime.parallel('loop/safe-point', { turn: 2, reason: 'tool-calls-complete' });
  assert.equal(plugins().find(p => p.manifest.id === 'alpha')!.version, v + 1); // 300-ms candidate committed now

  await fs.write(PLUGIN_DIR + 'alpha.js', SRC('v3'));
  await nextTick(); await sleep(400);
  assert.equal(plugins().find(p => p.manifest.id === 'alpha')!.version, v + 1); // queued while still busy
  await runtime.parallel('loop/idle');
  assert.equal(plugins().find(p => p.manifest.id === 'alpha')!.version, v + 2); // terminal fallback flushed
});

test('manager: tool and hook HMR becomes visible next turn without replacing the task session', async () => {
  const v1 = TOOL_HOOK_SRC('v1');
  const v2 = TOOL_HOOK_SRC('v2');
  const fs = fakeFs({ [PLUGIN_DIR + 'turn-plugin.js']: v1 });
  const messages = [];
  const requests = [];

  await provideTestService('fs', fs);
  await applyTestPlugin(toolsPlugin);
  await applyTestPlugin(promptPlugin);
  await provideTestService('task', {
    ready: Promise.resolve(), messages,
    activeTask: () => null, scope: () => runtime,
    async appendEvent() { },
  });
  await provideTestService('llm', {
    stream(request) {
      requests.push({
        prompt: request.systemPrompt,
        tools: request.tools.map(tool => ({ name: tool.name, description: tool.description })),
      });
      const turn = requests.length;
      return (async function*() {
        if (turn === 1) {
          yield {
            type: 'done', text: '', thinking: '', finishReason: 'tool_calls', toolCalls: [
              { id: 'edit', name: 'rewrite_turn_plugin', args: '{}', argsObj: {} },
            ]
          };
        } else if (turn === 2) {
          yield {
            type: 'done', text: '', thinking: '', finishReason: 'tool_calls', toolCalls: [
              { id: 'use', name: 'versioned_tool', args: '{}', argsObj: {} },
            ]
          };
        } else {
          yield { type: 'done', text: 'finished', thinking: '', finishReason: 'stop', toolCalls: [] };
        }
      })();
    },
  });
  await applyTestPlugin({
    name: 'turn-plugin-editor', inject: ['tools'],
    apply(ctx) {
      ctx.tools.registerSchema({
        name: 'rewrite_turn_plugin', description: 'replace the fixture capability',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => { await fs.write(PLUGIN_DIR + 'turn-plugin.js', v2); return 'rewritten'; },
      });
    },
  });
  await boot({ 'turn-plugin': { source: v1 } }, { search: '' });
  const initialHookProbe = await runtime.waterfall('llm/request', { systemPrompt: 'probe' }, request => request);
  assert.match(initialHookProbe.systemPrompt, /hook:v1/);
  await applyTestPlugin(loopPlugin);

  const taskService = runtime.reflect.get('task');
  const sessionMessages = taskService.messages;
  await runtime.reflect.get('loop').run('update the tool and continue');

  assert.equal(taskService.messages, sessionMessages);
  assert.equal(sessionMessages, messages);
  assert.match(requests[0].prompt, /hook:v1/);
  assert.equal(requests[0].tools.find(tool => tool.name === 'versioned_tool')?.description, 'tool:v1');
  assert.match(requests[1].prompt, /hook:v2/);
  assert.doesNotMatch(requests[1].prompt, /hook:v1/);
  assert.equal(requests[1].tools.find(tool => tool.name === 'versioned_tool')?.description, 'tool:v2');
  const versionedCall = messages
    .filter(message => message.role === 'assistant')
    .flatMap(message => message.toolCalls)
    .find(call => call.name === 'versioned_tool');
  assert.equal(versionedCall?.result, 'result:v2');
  assert.equal(capabilities.get('turn-plugin')?.version, 1);
});

test('manager: broken edit rolls back — old version keeps running, hmrError set', async () => {
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'alpha.js']: SRC('v1') });
  await mgr.mount('alpha');
  const entry = plugins().find(p => p.manifest.id === 'alpha');
  const v = entry.version;
  await fs.write(PLUGIN_DIR + 'alpha.js', 'export default {{{');
  await nextTick(); await sleep(400);
  assert.equal(entry.version, v);                                     // no swap
  assert.match(entry.hmrError, /./);                                  // flagged
});

test('manager: ignores legacy files that use reserved system names', async () => {
  const { mgr } = await mountManager({ [PLUGIN_DIR + 'loop.js']: SRC('stale-loop') });
  assert.equal(mgr.catalog().some(entry => entry.id === 'loop'), false);
  assert.match(await mgr.mount('loop'), /bundled system plugin/);
});

test('manager: apply-time failure remounts the previous Cordis plugin', async () => {
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'alpha.js']: SRC('v1') });
  await mgr.mount('alpha');
  const version = plugins().find(p => p.manifest.id === 'alpha')!.version;
  await fs.write(PLUGIN_DIR + 'alpha.js', `export default { name: 'fixture', apply() { throw new Error('apply boom') } }`);
  await nextTick(); await sleep(400);
  const restored = plugins().find(p => p.manifest.id === 'alpha');
  assert.equal(restored.status, 'active');
  assert.equal(restored.version, version);
  assert.match(restored.hmrError, /apply boom/);
});

test('manager serializes creation and removal so a delayed install cannot resurrect a deleted plugin', async () => {
  const { fs, mgr } = await mountManager({});
  const write = fs.write;
  fs.write = async (path, source) => { await sleep(5); await write(path, source); };
  const creating = mgr.create('serialized', SRC('created'));
  const removing = mgr.remove('serialized');
  assert.match(await creating, /compiled and mounted/);
  assert.match(await removing, /source are gone/);
  assert.equal(capabilities.has('serialized'), false);
  assert.equal(fs.list().some(path => path.includes('serialized')), false);
});
