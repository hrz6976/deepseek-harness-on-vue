// Boot + manager lifecycle tests: seeding semantics (write-if-missing is what
// keeps agent modifications alive across refreshes), fail-soft mounting, and
// the manager's mount/unmount/HMR policies. Runs the REAL
// kernel boot and manager plugin in Node against a fake (reactive) fs
// service; compilePlugin exercises its new Function fallback here (blob:
// imports don't exist in Node), which is also why plugin defs never render.
// Run: npm test
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { reactive, ref, nextTick } from 'vue';
import { boot, PLUGIN_DIR } from '../src/kernel/boot';
import { modules } from '../src/kernel/modules';
import { mountPlugin, plugins } from '../src/kernel/host';
import { services } from '../src/kernel/services';
import { managerPlugin } from '../src/plugins/manager';
import { capabilities } from '../src/kernel/capabilities';
import { legacyCapabilityManifest } from '../src/kernel/capabilities';
import { capabilityIndexPath, capabilityManifestPath } from '../src/kernel/capability-package';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';

globalThis.__harness = { modules }; // what compiled plugin code reads its imports from

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SRC = marker => `export default { name: 'fixture', apply() {} }; // ${marker}`;

function fakeFs(initial = {}) {
  const cache = reactive(new Map(Object.entries(initial)));
  return {
    files: cache, ready: Promise.resolve(),
    read: p => (cache.has(p) ? cache.get(p) : null),
    list: () => [...cache.keys()].sort(),
    async write(p, c) { cache.set(p, String(c ?? '')); },
    async remove(p) { cache.delete(p); },
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
  assert.deepEqual(plugins.map(p => p.name), ['alpha']);              // …but not mounted
  assert.equal(plugins[0].builtin, true);                             // core badge source
});

test('boot: never overwrites an existing (agent-modified) file — and mounts FROM it', async () => {
  const modified = SRC('agent-was-here');
  const fs = fakeFs({ [PLUGIN_DIR + 'alpha.js']: modified });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('shipped') } }, { search: '' });
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), modified);
  assert.deepEqual(plugins.map(p => p.name), ['alpha']);
});

test('boot: agent-created extras (no manifest entry) mount after manifest order', async () => {
  const fs = fakeFs({ [PLUGIN_DIR + 'zzz-user.js']: SRC('user') });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('a') }, beta: { source: SRC('b') } }, { search: '' });
  assert.deepEqual(plugins.map(p => p.name), ['alpha', 'beta', 'zzz-user']);
  assert.equal(plugins.find(p => p.name === 'zzz-user').builtin, false);
});

test('boot: loads stored sources directly without a pre-release format gate', async () => {
  const stored = SRC('agent-edited');
  const fs = fakeFs({ [PLUGIN_DIR + 'alpha.js']: stored, [PLUGIN_DIR + 'user.js']: SRC('user') });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('shipped') } }, { search: '' });
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), stored);
  assert.deepEqual(plugins.map(p => p.name), ['alpha', 'user']);
});

test('boot: removes legacy OPFS copies of reserved system plugins', async () => {
  const fs = fakeFs({
    [PLUGIN_DIR + 'loop.js']: SRC('stale-loop'),
    '.harness/capabilities/loop/manifest.json': '{}',
    '.harness/capabilities/loop/index.js': SRC('stale-active-loop'),
  });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('alpha') } }, { search: '', reservedNames: ['loop'] });

  assert.equal(fs.read(PLUGIN_DIR + 'loop.js'), null);
  assert.equal(fs.read('.harness/capabilities/loop/manifest.json'), null);
  assert.equal(fs.read('.harness/capabilities/loop/index.js'), null);
  assert.deepEqual(plugins.map(plugin => plugin.name), ['alpha']);
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
  assert.equal(fs.read(capabilityIndexPath('alpha')), next);
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
  assert.equal(JSON.parse(draftFs.read(capabilityManifestPath('alpha'))).version, '0.1.1');
});

test('boot: one broken file is skipped, the rest of the app comes up', async () => {
  const fs = fakeFs({ [PLUGIN_DIR + 'broken.js']: 'export default {{{' });
  await provideTestService('fs', fs);
  await boot({ alpha: { source: SRC('a') } }, { search: '' });
  assert.deepEqual(plugins.map(p => p.name), ['alpha']);
});

test('boot: a broken working draft restores the last active capability revision', async () => {
  const fs = fakeFs();
  await provideTestService('fs', fs);
  const active = SRC('active');
  await boot({ alpha: { source: active } }, { search: '' });
  await fs.write(PLUGIN_DIR + 'alpha.js', 'export default {{{');
  await boot({ alpha: { source: SRC('shipped') } }, { search: '' });
  const entry = plugins.find(plugin => plugin.name === 'alpha');
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
  assert.deepEqual(plugins.map(p => p.name), ['alpha']);
});

// ----------------------------------------------------------------- manager --
// Manager is a real Cordis plugin; its watchers belong to its test Fiber.
async function mountManager(files) {
  const fs = fakeFs(files);
  await provideTestService('fs', fs);
  await applyTestPlugin(managerPlugin);
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
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'llm.js']: SRC('v1') });
  assert.match(await mgr.mount('llm', { cfg: { model: 'm1' } }), /mounted/);
  const entry = plugins.find(p => p.name === 'llm');
  assert.deepEqual(entry.config, { cfg: { model: 'm1' } });
  const v = entry.version;
  await fs.write(PLUGIN_DIR + 'llm.js', SRC('v2'));                   // agent edits the file
  await nextTick(); await sleep(400);                                 // watcher + 300ms debounce
  const reloaded = plugins.find(p => p.name === 'llm');
  assert.equal(reloaded.version, v + 1);                              // replacement Fiber
  assert.deepEqual(reloaded.config, { cfg: { model: 'm1' } });        // config survived
});

test('manager: unmount keeps the file; a later edit does NOT surprise-remount', async () => {
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'llm.js']: SRC('v1') });
  await mgr.mount('llm', { cfg: {} });
  assert.match(await mgr.unmount('llm'), /file kept/);
  assert.equal(plugins.find(p => p.name === 'llm'), undefined);
  assert.equal(fs.read(PLUGIN_DIR + 'llm.js'), SRC('v1'));
  await fs.write(PLUGIN_DIR + 'llm.js', SRC('v2'));
  await nextTick(); await sleep(400);
  assert.equal(plugins.find(p => p.name === 'llm'), undefined);       // still unmounted
  await mgr.mount('llm', { cfg: {} });                                // explicit remount uses the NEW source
  assert.match(plugins.find(p => p.name === 'llm') ? 'ok' : 'missing', /ok/);
});

test('manager: reloads are deferred while the loop runs, flushed after', async () => {
  const running = ref(false);
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'alpha.js']: SRC('v1') });
  await provideTestService('loop', { running });
  await mgr.mount('alpha');
  const entry = plugins.find(p => p.name === 'alpha');
  const v = entry.version;
  running.value = true;
  await fs.write(PLUGIN_DIR + 'alpha.js', SRC('v2'));
  await nextTick(); await sleep(400);
  assert.equal(entry.version, v);                                     // deferred
  running.value = false;
  await nextTick(); await sleep(50);
  assert.equal(plugins.find(p => p.name === 'alpha').version, v + 1); // replacement Fiber flushed
});

test('manager: broken edit rolls back — old version keeps running, hmrError set', async () => {
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'alpha.js']: SRC('v1') });
  await mgr.mount('alpha');
  const entry = plugins.find(p => p.name === 'alpha');
  const v = entry.version;
  await fs.write(PLUGIN_DIR + 'alpha.js', 'export default {{{');
  await nextTick(); await sleep(400);
  assert.equal(entry.version, v);                                     // no swap
  assert.match(entry.hmrError, /./);                                  // flagged
});

test('manager: ignores legacy files that use reserved system names', async () => {
  const { mgr } = await mountManager({ [PLUGIN_DIR + 'loop.js']: SRC('stale-loop') });
  assert.equal(mgr.list().includes('loop'), false);
  assert.match(await mgr.mount('loop'), /bundled system plugin/);
});

test('manager: apply-time failure remounts the previous Cordis plugin', async () => {
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'alpha.js']: SRC('v1') });
  await mgr.mount('alpha');
  const version = plugins.find(p => p.name === 'alpha').version;
  await fs.write(PLUGIN_DIR + 'alpha.js', `export default { name: 'fixture', apply() { throw new Error('apply boom') } }`);
  await nextTick(); await sleep(400);
  const restored = plugins.find(p => p.name === 'alpha');
  assert.equal(restored.status, 'active');
  assert.equal(restored.version, version);
  assert.match(restored.hmrError, /apply boom/);
});
