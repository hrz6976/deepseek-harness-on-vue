// Invariant tests: drive the REAL loop + llm message conversion in Node with a
// fake engine, covering the "Ported invariants" in docs/TESTING.md that
// kernel.test.js does not reach. No browser, no network — the llm service is
// swapped for a scripted async generator; tools run through the real
// toolsPlugin collector and the real bus waterfall seams.
// Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { bus } from '../src/kernel/bus.js';
import { services, provideService } from '../src/kernel/services.js';
import { useTool } from '../src/kernel/contrib.js';
import { toolsPlugin } from '../src/plugins/tools.js';
import { loopPlugin } from '../src/plugins/loop.js';
import { toPiMessages } from '../src/plugins/llm.js';
import { translateESM, compilePlugin } from '../src/kernel/compile.js';

// ---------------------------------------------------------------- helpers --
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mount loop + tools with a scripted engine. `script(req, turn)` is an async
// generator; `requests` collects a frozen copy of every request the loop sent.
function mountHarness(script) {
  const requests = [];
  toolsPlugin.setup();
  provideService('llm', {
    stream(req) {
      requests.push({
        tools: req.tools.map(t => t.name),
        messages: req.messages.map(m => ({ role: m.role, status: m.status, text: m.text })),
      });
      return script(req, requests.length);
    },
  });
  loopPlugin.setup();
  return { loop: services.get('loop').value, requests };
}

after(() => { services.delete('llm'); services.delete('tools'); services.delete('loop'); });

const doneText = text => async function* () {
  yield { type: 'update', text, thinking: '', toolCalls: [] };
  yield { type: 'done', text, thinking: '', toolCalls: [] };
};

const notesOf = loop => loop.messages.filter(m => m.role === 'note').map(m => m.text);

// ------------------------------------------------------------- toPiMessages --
test('toPiMessages: notes never reach the model; only user/assistant convert', () => {
  const out = toPiMessages([
    { role: 'note', text: 'internal note' },
    { role: 'user', text: 'hello' },
    { role: 'system', text: 'not a thing here' },
  ], 'm');
  assert.equal(out.length, 1);
  assert.deepEqual({ role: out[0].role, content: out[0].content }, { role: 'user', content: 'hello' });
});

test('toPiMessages: every toolCall is followed by a matching toolResult', () => {
  const out = toPiMessages([
    { role: 'assistant', text: '', thinking: '', toolCalls: [
      { id: 'c1', name: 'run_js', argsObj: { code: '1' }, args: '{"code":"1"}', result: '1' },
      { id: 'c2', name: 'run_js', args: '{"code":"2"}' }, // no result: aborted mid-round
    ] },
  ], 'm');
  assert.equal(out.length, 3); // assistant + 2 toolResults
  assert.equal(out[1].role, 'toolResult');
  assert.equal(out[1].toolCallId, 'c1');
  assert.equal(out[1].content[0].text, '1');
  assert.equal(out[2].toolCallId, 'c2');
  assert.equal(out[2].content[0].text, '(aborted, not executed)'); // the stub
  assert.equal(out[0].stopReason, 'toolUse');
  // argsObj wins over re-parsing args
  assert.deepEqual(out[0].content.find(c => c.type === 'toolCall').arguments, { code: '1' });
});

test('toPiMessages: thinking precedes text; plain reply stops with "stop"', () => {
  const out = toPiMessages([
    { role: 'assistant', text: 'answer', thinking: 'hmm', toolCalls: [] },
  ], 'm');
  assert.equal(out[0].stopReason, 'stop');
  assert.deepEqual(out[0].content.map(c => c.type), ['thinking', 'text']);
});

// ------------------------------------------------------ loop: request filter --
test('loop: notes and streaming/error partials never reach the model', async () => {
  const { loop, requests } = mountHarness(doneText('ok'));
  loop.messages.push({ role: 'note', text: 'a note' });
  loop.messages.push({ role: 'assistant', text: 'partial', thinking: '', toolCalls: [], status: 'streaming' });
  loop.messages.push({ role: 'assistant', text: 'broke', thinking: '', toolCalls: [], status: 'error' });
  await loop.run('goal');
  assert.equal(requests.length, 1);
  for (const m of requests[0].messages) {
    assert.notEqual(m.role, 'note');
    assert.ok(m.status !== 'streaming' && m.status !== 'error', `leaked ${m.status} partial`);
  }
  // the completed history DID go: note + 2 partials injected, so only the goal is eligible
  assert.deepEqual(requests[0].messages.map(m => m.role), ['user']);
});

// --------------------------------------------------- loop: truncation / veto --
test('loop: tool results truncate at 8000 chars before entering history', async () => {
  const { loop } = mountHarness(async function* (req, turn) {
    if (turn === 1) yield { type: 'done', text: '', thinking: '', toolCalls: [{ id: 't1', name: 'big', argsObj: {}, args: '{}' }] };
    else yield { type: 'done', text: 'finished', thinking: '', toolCalls: [] };
  });
  const dispose = useTool({ name: 'big', description: '', parameters: {}, run: () => 'x'.repeat(10_000) });
  await loop.run('goal');
  const call = loop.messages.find(m => m.role === 'assistant')?.toolCalls[0];
  assert.equal(call.result.length, 8000);
  assert.equal(call.status, 'done');
  dispose();
});

test('loop: tools/pre-execute veto blocks the call, tool body never runs', async () => {
  let ran = false;
  const { loop } = mountHarness(async function* (req, turn) {
    if (turn === 1) yield { type: 'done', text: '', thinking: '', toolCalls: [{ id: 't1', name: 'guarded', argsObj: {}, args: '{}' }] };
    else yield { type: 'done', text: 'finished', thinking: '', toolCalls: [] };
  });
  const dispose = useTool({ name: 'guarded', description: '', parameters: {}, run: () => { ran = true; return 'secret'; } });
  const off = bus.on('tools/pre-execute', req => req.name === 'guarded' ? { ...req, veto: 'disabled by policy' } : req);
  await loop.run('goal');
  const call = loop.messages.find(m => m.role === 'assistant')?.toolCalls[0];
  assert.equal(ran, false);
  assert.match(call.result, /^Error: tool call vetoed by a plugin: disabled by policy$/);
  off(); dispose();
});

// ------------------------------------------- loop: per-request snapshot race --
test('loop: mid-turn tool removal — in-flight turn uses the snapshot, next request drops it', async () => {
  const { loop, requests } = mountHarness(async function* (req, turn) {
    if (turn === 1) yield { type: 'done', text: '', thinking: '', toolCalls: [{ id: 't1', name: 'doomed', argsObj: {}, args: '{}' }] };
    else yield { type: 'done', text: 'finished', thinking: '', toolCalls: [] };
  });
  let disposeDoomed;
  disposeDoomed = useTool({
    name: 'doomed', description: '', parameters: {},
    run: () => { disposeDoomed(); return 'ran from snapshot'; }, // v-if/removal lands mid-turn
  });
  await loop.run('goal');
  const call = loop.messages.find(m => m.role === 'assistant')?.toolCalls[0];
  assert.equal(call.result, 'ran from snapshot'); // in-flight turn still executed it
  assert.deepEqual(requests[0].tools, ['doomed']);
  assert.deepEqual(requests[1].tools, []); // gone from the NEXT request
});

// ------------------------------------------------------- loop: turn failsafe --
test('loop: a model that never stops calling tools hits the failsafe turn limit', async () => {
  const { loop, requests } = mountHarness(async function* () {
    yield { type: 'done', text: '', thinking: '', toolCalls: [{ id: 'x', name: 'poke', argsObj: {}, args: '{}' }] };
  });
  const dispose = useTool({ name: 'poke', description: '', parameters: {}, run: () => 'ok' });
  await loop.run('goal');
  assert.equal(requests.length, 500); // failsafe kill switch, not a control mechanism
  assert.ok(notesOf(loop).some(t => t.includes('failsafe turn limit (500)')));
  dispose();
});

// ------------------------------------------- loop: compaction plugin seams --
test('loop/turn-start: fires before the request; splices to the log shape it', async () => {
  const { loop, requests } = mountHarness(doneText('ok'));
  loop.messages.push({ role: 'user', text: 'ancient history' });
  const off = bus.on('loop/turn-start', (arg, next) => {
    arg.messages.splice(0, 1, { role: 'summary', text: 'SUM' }); // what compaction does
    return next(arg);
  });
  await loop.run('goal');
  assert.deepEqual(requests[0].messages.map(m => m.role), ['summary', 'user']);
  assert.ok(!requests[0].messages.some(m => m.text === 'ancient history'));
  off();
});

test('loop/llm-error: a recovery listener gets exactly ONE retry per run', async () => {
  let fired = 0;
  const { loop, requests } = mountHarness(async function* () {
    yield { type: 'error', message: 'maximum context length is 131072 tokens' };
  });
  const off = bus.on('loop/llm-error', (arg, next) => { fired++; return next({ ...arg, retry: true }); });
  await loop.run('goal');
  assert.equal(fired, 2);           // consulted on both failures
  assert.equal(requests.length, 2); // but retried only once
  assert.ok(notesOf(loop).some(t => t.startsWith('LLM call failed')));
  assert.equal(loop.running.value, false);
  off();
});

// ------------------------------------------------------------ loop: control --
test('loop: stop mid-stream — loop exits with a "stopped" note, no stuck cursor', async () => {
  const { loop } = mountHarness(async function* (req) {
    while (!req.signal.aborted) {
      yield { type: 'update', text: 'working…', thinking: '', toolCalls: [] };
      await sleep(5);
    }
  });
  const p = loop.run('goal');
  await sleep(30);
  loop.stop();
  await p;
  assert.ok(notesOf(loop).some(t => t === 'stopped'));
  assert.equal(loop.running.value, false);
  const last = loop.messages.at(-1);
  assert.notEqual(last.status, 'streaming', 'cursor must not be left blinking');
});

test('loop: LLM error lands as a note (with CORS hint on fetch failures)', async () => {
  const { loop } = mountHarness(async function* () {
    yield { type: 'error', message: 'fetch failed' };
  });
  await loop.run('goal');
  const note = notesOf(loop).find(t => t.startsWith('LLM call failed:'));
  assert.ok(note, 'error note present');
  assert.match(note, /network\/CORS/);
  // the failed assistant turn is closed (cursor off); the note trails it
  assert.equal(loop.messages.find(m => m.role === 'assistant')?.status, 'error');
  assert.equal(loop.messages.at(-1).role, 'note');
  assert.equal(loop.running.value, false);
});

test('loop: re-entry guard — a second run while running is refused', async () => {
  const { loop } = mountHarness(async function* (req) {
    while (!req.signal.aborted) { yield { type: 'update', text: '…', thinking: '', toolCalls: [] }; await sleep(5); }
  });
  const p = loop.run('first');
  await sleep(20);
  await loop.run('second'); // must return immediately, not queue
  assert.ok(notesOf(loop).some(t => t === 'a task is already running — stop it first'));
  loop.stop();
  await p;
});

// ------------------------------------------------------------- compile probe --
test('compilePlugin: broken source is rejected by the probe (never persisted/mounted)', async () => {
  await assert.rejects(() => compilePlugin('bad', 'export default { setup( {'), SyntaxError);
});

test('compilePlugin: pinned-dialect source compiles (new Function fallback path)', async () => {
  const def = await compilePlugin('ok42', `
    const n = 6;
    export function mul(x) { return x * n; }
    export default { setup() { return { answer: mul(7) }; } };
  `);
  assert.equal(typeof def.setup, 'function');
  assert.equal(def.setup().answer, 42);
});

test('translateESM: covers the full pinned dialect (const/let/var/async exports)', () => {
  const src = `
    export const a = 1;
    export let b = 2;
    export var c = 3;
    export async function f() { return a + b + c; }
    export default { setup() { return { sum: () => f() }; } };
  `;
  const mod = { exports: {} };
  new Function('module', 'exports', translateESM(src))(mod, mod.exports);
  return mod.exports.setup().sum().then(v => assert.equal(v, 6));
});

// ------------------------------------------------------------------ bus misc --
test('bus.emit: a throwing listener is logged and does not break the others', async () => {
  let reached = 0;
  const off1 = bus.on('misc/emit', () => { throw new Error('boom'); });
  const off2 = bus.on('misc/emit', () => { reached++; });
  bus.emit('misc/emit');
  assert.equal(reached, 1);
  off1(); off2();
});

test('bus.waterfall: no listeners passes the argument through untouched', async () => {
  const v = { untouched: true };
  assert.equal(await bus.waterfall('misc/nobody-listens', v), v);
});
