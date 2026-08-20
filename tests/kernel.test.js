// Kernel tests: pure-logic guards for exactly the documented traps.
// Zero browser, zero DOM — kernel functions return explicit disposers, and
// the onUnmounted wiring on top of them is one trusted line each.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bus } from '../src/kernel/bus.js';
import { createCollector } from '../src/kernel/collector.js';
import { services, provideService } from '../src/kernel/services.js';
import { translateESM, normalizePluginDef } from '../src/kernel/compile.js';
import { makeExposeCapture, exposedStates } from '../src/kernel/host.js';
import { serializeState } from '../src/plugins/state.js';
import { ref, proxyRefs } from 'vue';

test('waterfall: runs in order, value threads through', async () => {
  const seen = [];
  const off1 = bus.on('wf/order', (v, next) => { seen.push('a'); return next(v + 1); });
  const off2 = bus.on('wf/order', (v, next) => { seen.push('b'); return next(v * 10); });
  assert.equal(await bus.waterfall('wf/order', 1), 20);
  assert.deepEqual(seen, ['a', 'b']);
  off1(); off2();
});

test('waterfall: not calling next() vetoes (short-circuits) the chain', async () => {
  let reached = false;
  const off1 = bus.on('wf/veto', req => ({ ...req, veto: 'blocked' })); // no next()
  const off2 = bus.on('wf/veto', req => { reached = true; return req; });
  const out = await bus.waterfall('wf/veto', { name: 'x' });
  assert.equal(out.veto, 'blocked');
  assert.equal(reached, false);
  off1(); off2();
});

test('waterfall: double next() is detected and the second call is inert', async () => {
  let downstream = 0;
  const off1 = bus.on('wf/dbl', (v, next) => { next(v); return next(v); });
  const off2 = bus.on('wf/dbl', v => { downstream++; return v; });
  await bus.waterfall('wf/dbl', 0);
  assert.equal(downstream, 1); // chain ran once, not twice
  off1(); off2();
});

test('collector: cross-plugin duplicate name throws, same-plugin remount replaces', () => {
  const c = createCollector('tool');
  c.add('dice', { v: 1 }, 'plugin-a');
  assert.throws(() => c.add('dice', { v: 2 }, 'plugin-b'), /duplicate tool "dice"/);
  c.add('dice', { v: 3 }, 'plugin-a'); // HMR remount: legal replace
  assert.equal(c.get('dice').v, 3);
});

test('collector: disposal is token-guarded (old unmount cannot delete the replacement)', () => {
  const c = createCollector('tool');
  const disposeOld = c.add('t', { v: 'old' }, 'p');
  c.add('t', { v: 'new' }, 'p');   // replacement mounts BEFORE the old instance unmounts
  disposeOld();                     // late unmount of the old instance
  assert.equal(c.get('t').v, 'new'); // replacement survives
});

test('collector: snapshot is frozen against later changes', () => {
  const c = createCollector('tool');
  const dispose = c.add('a', { v: 1 }, 'p');
  const snap = c.snapshot();
  dispose();
  c.add('b', { v: 2 }, 'p');
  assert.deepEqual([...snap.keys()], ['a']); // per-request snapshot semantics
  assert.deepEqual(c.names(), ['b']);
});

test('services: cleanup is token-guarded too', () => {
  const disposeOld = provideService('svc-x', { who: 'old' });
  provideService('svc-x', { who: 'new' }); // replacement provided before old disposes
  disposeOld();
  assert.equal(services.get('svc-x').value.who, 'new');
  services.delete('svc-x');
});

test('translateESM: the pinned dialect survives the new Function fallback', () => {
  const src = `
    const n = 2;
    export function helper(x) { return x * n; }
    export default { name: 'p', setup() { return { n: helper(21) }; } };
  `;
  const mod = { exports: {} };
  new Function('module', 'exports', translateESM(src))(mod, mod.exports);
  const def = normalizePluginDef({ default: mod.exports }, 'p');
  assert.equal(def.setup().n, 42);
});

test('expose capture: only explicit expose() opts in; unmount cleans up', () => {
  const cap = makeExposeCapture('cap-a');
  cap({ $: { exposed: null } });                 // default public instance: expose() never called
  assert.equal(exposedStates.has('cap-a'), false);
  const val = { $: { exposed: {} }, score: 1 };  // shape of an exposed proxy
  cap(val);
  assert.equal(exposedStates.get('cap-a'), val);
  cap(null);                                     // ref(null) on unmount
  assert.equal(exposedStates.has('cap-a'), false);
});

test('expose capture: cleanup is token-guarded across HMR remount order', () => {
  const capOld = makeExposeCapture('cap-b');
  const capNew = makeExposeCapture('cap-b');
  capOld({ $: { exposed: {} }, v: 'old' });
  capNew({ $: { exposed: {} }, v: 'new' });      // replacement mounts BEFORE the old ref(null)
  capOld(null);                                  // late unmount of the old instance
  assert.equal(exposedStates.get('cap-b').v, 'new');
  capNew(null);
  assert.equal(exposedStates.has('cap-b'), false);
});

test('serializeState: unwraps refs like the expose proxy, drops functions', () => {
  const s = proxyRefs({ score: ref(3), board: [[0, 1]], roll: () => {} });
  assert.equal(serializeState(s), '{"score":3,"board":[[0,1]]}');
});

test('serializeState: circular state degrades to an error string, oversized state truncates', () => {
  const o = {}; o.self = o;
  assert.match(serializeState(o), /^Error: state is not JSON-serializable/);
  const out = serializeState({ s: 'x'.repeat(100) }, 20);
  assert.ok(out.length < 80 && /truncated, 108 chars/.test(out)); // {"s":"…"} = 108 chars
});

test('normalizePluginDef: rejects non-components, accepts bare setup functions', () => {
  assert.throws(() => normalizePluginDef({ default: { foo: 1 } }, 'x'), /export default a component/);
  const def = normalizePluginDef({ default: () => () => null }, 'x');
  assert.equal(typeof def.setup, 'function');
  assert.equal(def.name, 'x');
});
