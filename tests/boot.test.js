// Boot + manager lifecycle tests: seeding semantics (write-if-missing is what
// keeps agent modifications alive across refreshes), format fallback, fail-
// soft mounting, and the manager's mount/unmount/HMR policies. Runs the REAL
// kernel boot and manager plugin in Node against a fake (reactive) fs
// service; compilePlugin exercises its new Function fallback here (blob:
// imports don't exist in Node), which is also why plugin defs never render.
// Run: npm test
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { reactive, ref, nextTick } from 'vue';
import { boot, PLUGIN_DIR, FORMAT_FILE, PLUGIN_FORMAT_VERSION } from '../src/kernel/boot.js';
import { modules } from '../src/kernel/modules.js';
import { plugins } from '../src/kernel/host.js';
import { services, provideService } from '../src/kernel/services.js';
import { managerPlugin } from '../src/plugins/manager.js';

globalThis.__harness = { modules }; // what compiled plugin code reads its imports from

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SRC = marker => `export default { name: undefined, setup() { return () => null; } }; // ${marker}`;

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

beforeEach(() => { plugins.splice(0); services.clear(); });
after(() => { plugins.splice(0); services.clear(); });

// -------------------------------------------------------------------- boot --
test('boot: seeds missing files, writes format, mounts everything auto-mountable', async () => {
  const fs = fakeFs();
  provideService('fs', fs);
  await boot({ alpha: { source: SRC('alpha') }, llm: { source: SRC('llm'), autoMount: false } }, { search: '' });
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), SRC('alpha'));       // seeded
  assert.equal(fs.read(PLUGIN_DIR + 'llm.js'), SRC('llm'));           // seeded too…
  assert.equal(fs.read(FORMAT_FILE), PLUGIN_FORMAT_VERSION);
  assert.deepEqual(plugins.map(p => p.name), ['alpha']);              // …but not mounted
  assert.equal(plugins[0].builtin, true);                             // core badge source
});

test('boot: never overwrites an existing (agent-modified) file — and mounts FROM it', async () => {
  const modified = SRC('agent-was-here');
  const fs = fakeFs({ [PLUGIN_DIR + 'alpha.js']: modified, [FORMAT_FILE]: PLUGIN_FORMAT_VERSION });
  provideService('fs', fs);
  await boot({ alpha: { source: SRC('shipped') } }, { search: '' });
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), modified);
  assert.deepEqual(plugins.map(p => p.name), ['alpha']);
});

test('boot: agent-created extras (no manifest entry) mount after manifest order', async () => {
  const fs = fakeFs({ [PLUGIN_DIR + 'zzz-user.js']: SRC('user'), [FORMAT_FILE]: PLUGIN_FORMAT_VERSION });
  provideService('fs', fs);
  await boot({ alpha: { source: SRC('a') }, beta: { source: SRC('b') } }, { search: '' });
  assert.deepEqual(plugins.map(p => p.name), ['alpha', 'beta', 'zzz-user']);
  assert.equal(plugins.find(p => p.name === 'zzz-user').builtin, false);
});

test('boot: format mismatch boots from shipped defaults, stored files kept', async () => {
  const stored = SRC('old-dialect');
  const fs = fakeFs({ [PLUGIN_DIR + 'alpha.js']: stored, [PLUGIN_DIR + 'user.js']: SRC('user'), [FORMAT_FILE]: '1' });
  provideService('fs', fs);
  await boot({ alpha: { source: SRC('shipped') } }, { search: '' });
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), stored);             // file untouched
  assert.deepEqual(plugins.map(p => p.name), ['alpha']);              // shipped def mounted; user has no fallback -> skipped
});

test('boot: one broken file is skipped, the rest of the app comes up', async () => {
  const fs = fakeFs({ [PLUGIN_DIR + 'broken.js']: 'export default {{{', [FORMAT_FILE]: PLUGIN_FORMAT_VERSION });
  provideService('fs', fs);
  await boot({ alpha: { source: SRC('a') } }, { search: '' });
  assert.deepEqual(plugins.map(p => p.name), ['alpha']);
});

test('boot: ?reset wipes .plugins/ and reseeds shipped state', async () => {
  const fs = fakeFs({
    [PLUGIN_DIR + 'alpha.js']: SRC('agent-modified'),
    [PLUGIN_DIR + 'user.js']: SRC('user-made'),
    [FORMAT_FILE]: PLUGIN_FORMAT_VERSION,
    'index.html': '<p>agent work outside .plugins/ survives</p>',
  });
  provideService('fs', fs);
  await boot({ alpha: { source: SRC('shipped') } }, { search: '?reset' });
  assert.equal(fs.read(PLUGIN_DIR + 'alpha.js'), SRC('shipped'));     // factory copy
  assert.equal(fs.read(PLUGIN_DIR + 'user.js'), null);                // user plugin gone
  assert.equal(fs.read('index.html'), '<p>agent work outside .plugins/ survives</p>');
  assert.deepEqual(plugins.map(p => p.name), ['alpha']);
});

// ----------------------------------------------------------------- manager --
// managerPlugin.setup() outside a component: onUnmounted is a no-op (Vue
// warns, harmless) — watchers are stopped via the manager's own maps.
async function mountManager(files) {
  const fs = fakeFs({ [FORMAT_FILE]: PLUGIN_FORMAT_VERSION, ...files });
  provideService('fs', fs);
  managerPlugin.setup();
  await sleep(0); // let the adopt-existing-files pass run (it awaits fs.ready)
  return { fs, mgr: services.get('manager').value };
}

test('manager: mount passes config through; HMR reload preserves it', async () => {
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'llm.js']: SRC('v1') });
  assert.match(await mgr.mount('llm', { cfg: { model: 'm1' } }), /mounted/);
  const entry = plugins.find(p => p.name === 'llm');
  assert.deepEqual(entry.config, { cfg: { model: 'm1' } });
  const v = entry.version;
  await fs.write(PLUGIN_DIR + 'llm.js', SRC('v2'));                   // agent edits the file
  await nextTick(); await sleep(400);                                 // watcher + 300ms debounce
  assert.equal(entry.version, v + 1);                                 // hot-reloaded
  assert.deepEqual(entry.config, { cfg: { model: 'm1' } });           // config survived
});

test('manager: unmount keeps the file; a later edit does NOT surprise-remount', async () => {
  const { fs, mgr } = await mountManager({ [PLUGIN_DIR + 'llm.js']: SRC('v1') });
  await mgr.mount('llm', { cfg: {} });
  assert.match(mgr.unmount('llm'), /file kept/);
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
  const { fs } = await mountManager({ [PLUGIN_DIR + 'alpha.js']: SRC('v1') });
  provideService('loop', { running });
  const mgr = services.get('manager').value;
  await mgr.mount('alpha');
  const entry = plugins.find(p => p.name === 'alpha');
  const v = entry.version;
  running.value = true;
  await fs.write(PLUGIN_DIR + 'alpha.js', SRC('v2'));
  await nextTick(); await sleep(400);
  assert.equal(entry.version, v);                                     // deferred
  running.value = false;
  await nextTick(); await sleep(50);
  assert.equal(entry.version, v + 1);                                 // flushed
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
