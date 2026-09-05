// Kernel tests: pure-logic guards for exactly the documented traps.
// Zero browser, zero DOM — kernel functions return explicit disposers, and
// the onUnmounted wiring on top of them is one trusted line each.
// Run: npm test
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { useBusOn } from '@/kernel/bus';
import { translateESM, rewriteImports } from '@/kernel/compile';
import { normalizePlugin } from '@/kernel/plugin-runtime';
import { modules, preparePluginModules } from '@/kernel/modules';
import uiKernelPlugin, { UiService } from '@/kernel/ui';
import { serializeState } from '@/plugins/tools/read-state';
import toolsPlugin, { type ToolsRuntime } from '@/plugins/tools';
import { runtime } from '@/kernel/cordis';
import { useService } from '@/kernel/services';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';
import { ref, proxyRefs } from 'vue';
import { z } from 'zod';

afterEach(async () => { await cleanupTestRuntime(); });

test('waterfall: runs in order, value threads through', async () => {
  const seen = [];
  const off1 = useBusOn('wf/order', (v, next) => { seen.push('a'); return next({ value: v.value + 1 }); });
  const off2 = useBusOn('wf/order', (v, next) => { seen.push('b'); return next({ value: v.value * 10 }); });
  assert.deepEqual(await runtime.waterfall('wf/order', { value: 1 }, value => value), { value: 20 });
  assert.deepEqual(seen, ['a', 'b']);
  off1(); off2();
});

test('waterfall: not calling next() vetoes (short-circuits) the chain', async () => {
  let reached = false;
  const off1 = useBusOn('wf/veto', req => ({ ...req, veto: 'blocked' })); // no next()
  const off2 = useBusOn('wf/veto', req => { reached = true; return req; });
  const out = await runtime.waterfall('wf/veto', { name: 'x' }, value => value);
  assert.equal(out.veto, 'blocked');
  assert.equal(reached, false);
  off1(); off2();
});

test('waterfall: double next() is detected and the second call is inert', async () => {
  let downstream = 0;
  const off1 = useBusOn('wf/dbl', (v, next) => { next(v); return next(v); });
  const off2 = useBusOn('wf/dbl', v => { downstream++; return v; });
  await runtime.waterfall('wf/dbl', 0, value => value);
  assert.equal(downstream, 1); // chain ran once, not twice
  off1(); off2();
});

test('Cordis tool contributions are Fiber-owned, duplicate-safe, and snapshot-stable', async () => {
  await applyTestPlugin(toolsPlugin);
  const first = await applyTestPlugin({
    name: 'plugin-a', inject: ['tools'],
    apply(ctx) {
      ctx.tools.register({ name: 'dice', description: 'old', parameters: z.object({}), run: () => 1 });
      ctx.tools.register({ name: 'dice', description: 'new', parameters: z.object({}), run: () => 3 });
    },
  });
  const tools = runtime.reflect.get('tools') as ToolsRuntime;
  const snapshot = tools.snapshot();
  assert.equal(await snapshot.call('dice', {}), 3);

  const duplicate = runtime.plugin({
    name: 'plugin-b', inject: ['tools'],
    apply(ctx) { ctx.tools.register({ name: 'dice', description: '', parameters: z.object({}), run: () => 2 }); },
  });
  await assert.rejects(() => duplicate.await(), /duplicate tool "dice"/);
  await duplicate.dispose();

  await first.dispose();
  assert.deepEqual(tools.schemas(), []);
  assert.equal(await snapshot.call('dice', {}), 3);
});

test('tool parameters derive JSON Schema and validate before run', async () => {
  await applyTestPlugin(toolsPlugin);
  let calls = 0;
  await applyTestPlugin({
    name: 'validated-tool', inject: ['tools'],
    apply(ctx) {
      ctx.tools.register({
        name: 'greet',
        description: 'greet someone',
        parameters: z.object({ name: z.string().min(1).describe('Person to greet.') }),
        run: ({ name }) => { calls++; return `hello ${name}`; },
      });
    },
  });
  const tools = runtime.reflect.get('tools') as ToolsRuntime;
  assert.deepEqual(tools.schemas()[0]?.parameters, {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, description: 'Person to greet.' } },
    required: ['name'],
    additionalProperties: false,
  });
  assert.match(String(await tools.call('greet', {})), /invalid arguments/);
  assert.equal(calls, 0);
  assert.equal(await tools.call('greet', { name: 'Yuri' }), 'hello Yuri');
  assert.equal(calls, 1);
});

test('remote tools keep and validate native Draft-07 and 2020-12 schemas', async () => {
  await applyTestPlugin(toolsPlugin);
  let calls = 0;
  await applyTestPlugin({
    name: 'schema-tool', inject: ['tools'],
    apply(ctx) {
      for (const [name, $schema] of [
        ['remote_search_7', 'http://json-schema.org/draft-07/schema#'],
        ['remote_search_2020', 'https://json-schema.org/draft/2020-12/schema'],
      ]) {
        ctx.tools.registerSchema({
          name,
          description: 'remote schema',
          parameters: {
            $schema,
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'integer' } },
            required: ['query'],
            additionalProperties: false,
          },
          run: ({ query }) => { calls++; return query; },
        });
      }
    },
  });
  const tools = runtime.reflect.get('tools') as ToolsRuntime;
  assert.equal(tools.schemas()[0]?.parameters.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(tools.schemas()[1]?.parameters.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.match(String(await tools.call('remote_search_7', { limit: 1 })), /required property.*query/i);
  assert.match(String(await tools.call('remote_search_2020', { limit: 1 })), /required property.*query/i);
  assert.equal(calls, 0);
  assert.equal(await tools.call('remote_search_7', { query: 'yuri', limit: 5 }), 'yuri');
  assert.equal(await tools.call('remote_search_2020', { query: 'season', limit: 5 }), 'season');
  assert.equal(calls, 2);
});

test('loadable tool groups stay out of snapshots until loaded for the active task', async () => {
  await applyTestPlugin(toolsPlugin);
  await provideTestService('task', { activeTaskId: ref('task-1') });
  await applyTestPlugin({
    name: 'loadable-tool', inject: ['tools'],
    apply(ctx) {
      ctx.tools.register({
        name: 'deep_search', description: 'deep search', parameters: z.object({}),
        availability: { id: 'search.deep', title: 'Deep search', description: 'Optional search tools.', scope: 'task' },
        run: () => 'found',
      });
    },
  });
  const tools = runtime.reflect.get('tools') as ToolsRuntime;
  assert.equal(tools.schemas().some(tool => tool.name === 'deep_search'), false);
  assert.deepEqual(tools.catalog()[0]?.tools, ['deep_search']);
  assert.equal(tools.load('search.deep'), true);
  assert.equal(await tools.call('deep_search', {}), 'found');
  assert.equal(tools.unload('search.deep'), true);
  assert.equal(tools.schemas().some(tool => tool.name === 'deep_search'), false);
});

test('Cordis services reject simultaneous providers and disappear with their Fiber', async () => {
  const old = await provideTestService('svc-x', { who: 'old' });
  await assert.rejects(() => provideTestService('svc-x', { who: 'new' }), /has been registered/);
  await old.dispose();
  assert.equal(runtime.reflect.get('svc-x'), undefined);
});

test('useService reactively projects Cordis without storing a second service value', async () => {
  const service = useService<{ who: string }>('svc-reactive');
  assert.equal(service.value, null);
  const owner = await provideTestService('svc-reactive', { who: 'cordis' });
  assert.equal(service.value?.who, 'cordis');
  await owner.dispose();
  assert.equal(service.value, null);
});

test('translateESM: the pinned dialect survives the new Function fallback', () => {
  const src = `
    const n = 2;
    export function helper(x) { return x * n; }
    export default { name: 'p', apply() { return helper(21); } };
  `;
  const mod = { exports: {} };
  new Function('module', 'exports', translateESM(src))(mod, mod.exports);
  const module = mod.exports as { default: { apply(): number } };
  assert.equal(module.default.apply(), 42);
  const plugin = normalizePlugin(module, 'p');
  assert.equal(typeof (plugin as { apply?: unknown }).apply, 'function');
});

test('rewriteImports: named/aliased, namespace, and default forms hit the registry', () => {
  const out = rewriteImports([
    `// leading comment`,
    ``,
    `import { ref, watch as w } from 'vue';`,
    `import * as pi from '@earendil-works/pi-ai';`,
    `import sdk from '@/sdk';`,
    `export default { setup() {} };`,
  ].join('\n'));
  const M = `globalThis.__harness.modules`;
  assert.ok(out.includes(`const { ref, watch: w } = ${M}["vue"];`));
  assert.ok(out.includes(`const pi = ${M}["@earendil-works/pi-ai"];`));
  assert.ok(out.includes(`= ${M}["@harness/sdk"].default ?? ${M}["@harness/sdk"];`));
  assert.ok(out.includes(`export default { setup() {} };`)); // body untouched
});

test('rewriteImports: the src alias resolves only the public SDK membrane', () => {
  const aliasSdk = rewriteImports(`import { log } from '@/sdk';\n`);
  const packageSdk = rewriteImports(`import { log } from '@harness/sdk';\n`);
  assert.equal(aliasSdk, packageSdk);
  assert.ok(aliasSdk.includes(`["@harness/sdk"]`));
  assert.throws(() => rewriteImports(`import { log } from '@/kernel/log';\n`), /unknown import/);
  assert.throws(() => rewriteImports(`import { errorMessage } from '@/shared/runtime';\n`), /unknown import/);
  const cordis = rewriteImports(`import { Context } from '@deepseek-ai/cordis';\n`);
  assert.ok(cordis.includes(`["@deepseek-ai/cordis"]`));
});

test('rewriteImports: unknown and cross-plugin specifiers fail loud, listing the registry', () => {
  assert.throws(() => rewriteImports(`import { x } from './other-plugin';\n`), /unknown import.*plugins may import only.*@harness\/sdk/s);
  assert.throws(() => rewriteImports(`import 'side-effect';\n`), /unsupported import/);
  assert.throws(() => rewriteImports(`import { a,\n b } from 'vue';\n`), /unsupported import/); // multi-line pinned out
});

test('rewriteImports: only the leading block is touched — template-literal import text survives', () => {
  const src = `const recipe = \`\nimport { evil } from 'nowhere';\n\`;\nexport default { setup() {} };`;
  assert.equal(rewriteImports(src), src); // byte-identical: no leading imports at all
});

test('expose capture: only explicit expose() opts in; unmount cleans up', async () => {
  await applyTestPlugin(uiKernelPlugin);
  const ui = runtime.reflect.get('ui') as UiService;
  const cap = ui.capture('cap-a');
  cap({ $: { exposed: null } });                 // default public instance: expose() never called
  assert.equal(ui.readState('cap-a'), null);
  const val = { $: { exposed: {} }, score: 1 };  // shape of an exposed proxy
  cap(val);
  assert.equal(ui.readState('cap-a'), val);
  cap(null);                                     // ref(null) on unmount
  assert.equal(ui.readState('cap-a'), null);
});

test('expose capture: cleanup is token-guarded across HMR remount order', async () => {
  await applyTestPlugin(uiKernelPlugin);
  const ui = runtime.reflect.get('ui') as UiService;
  const capOld = ui.capture('cap-b');
  const capNew = ui.capture('cap-b');
  capOld({ $: { exposed: {} }, v: 'old' });
  capNew({ $: { exposed: {} }, v: 'new' });      // replacement mounts BEFORE the old ref(null)
  capOld(null);                                  // late unmount of the old instance
  assert.equal((ui.readState('cap-b') as { v: string }).v, 'new');
  capNew(null);
  assert.equal(ui.readState('cap-b'), null);
});

test('serializeState: unwraps refs like the expose proxy, drops functions', () => {
  const s = proxyRefs({ score: ref(3), board: [[0, 1]], roll: () => { } });
  assert.equal(serializeState(s), '{"score":3,"board":[[0,1]]}');
});

test('serializeState: circular state degrades to an error string, oversized state truncates', () => {
  const o = {}; o.self = o;
  assert.match(serializeState(o), /^Error: state is not JSON-serializable/);
  const out = serializeState({ s: 'x'.repeat(100) }, 20);
  assert.ok(out.length < 80 && /truncated, 108 chars/.test(out)); // {"s":"…"} = 108 chars
});

test('normalizePlugin: accepts only explicit Cordis plugins', () => {
  assert.throws(() => normalizePlugin({ default: { foo: 1 } }, 'x'), /Cordis/);
  assert.throws(() => normalizePlugin({ default: { setup: () => () => null } }, 'panel'), /Cordis/);
  const fn = normalizePlugin({ default: () => undefined }, 'logic');
  assert.equal(typeof fn, 'function');
});

test('public AI modules load only when plugin source imports them', async () => {
  await preparePluginModules(`import * as pi   from   '@earendil-works/pi-ai';\n`);
  assert.equal(typeof modules['@earendil-works/pi-ai'].createProvider, 'function');
});
