// Invariant tests: drive the REAL loop + llm message conversion in Node with a
// fake engine, covering the "Ported invariants" in docs/TESTING.md that
// kernel.test.js does not reach. No browser, no network — the llm service is
// swapped for a scripted async generator; tools run through the real
// toolsPlugin collector and the real bus waterfall seams.
// Run: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { useBusOn } from '@/kernel/bus';
import { runtime } from '@/kernel/cordis';
import { useTool } from '@/kernel/contrib';
import { toolsPlugin } from '@/plugins/tools';
import { promptPlugin } from '@/plugins/prompt';
import { createSnapshotBuffer, loopPlugin } from '@/plugins/loop';
import { toHarnessFinishReason, toPiMessages } from '@/plugins/llm';
import { translateESM, compilePlugin } from '@/kernel/compile';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';

// ---------------------------------------------------------------- helpers --
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mount loop + tools with a scripted engine. `script(req, turn)` is an async
// generator; `requests` collects a frozen copy of every request the loop sent.
async function mountHarness(script, options = {}) {
  const requests = [];
  await applyTestPlugin(toolsPlugin);
  await applyTestPlugin(promptPlugin);
  await provideTestService('fs', { ready: Promise.resolve(), files: new Map(), read: () => null, list: () => [], write: async () => {}, remove: async () => {} });
  await provideTestService('llm', {
    stream(req) {
      requests.push({
        tools: req.tools.map(t => t.name),
        messages: req.messages.map(m => ({ role: m.role, status: m.status, text: m.text })),
        sessionConfig: { ...req.sessionConfig },
      });
      return script(req, requests.length);
    },
  });
  const task = {
    ready: Promise.resolve(), messages: [], activeTask: () => null,
    async appendEvent() {}, async saveCheckpoint() {}, ...options.task,
  };
  await provideTestService('task', task);
  await applyTestPlugin(loopPlugin);
  return { loop: Object.assign(runtime.reflect.get('loop'), { messages: task.messages }), requests };
}

afterEach(async () => { await cleanupTestRuntime(); });

test('stream snapshot buffer coalesces cumulative updates and flushes the final state', () => {
  const commits = [];
  const buffer = createSnapshotBuffer(snapshot => commits.push(snapshot));
  buffer.push({ type: 'update', text: 'a', thinking: '', toolCalls: [] });
  buffer.push({ type: 'update', text: 'ab', thinking: '', toolCalls: [] });
  buffer.push({ type: 'done', text: 'abc', thinking: '', toolCalls: [] });
  assert.deepEqual(commits.map(snapshot => snapshot.text), ['abc']);
});

const finishEvent = text => ({
  type: 'done', text, thinking: '', finishReason: 'stop', toolCalls: [],
});

const doneText = text => async function* () { yield finishEvent(text); };

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

test('toPiMessages: user annotations are included in model context', () => {
  const out = toPiMessages([{
    role: 'user', text: '', annotations: [{
      id: 'annotation-1',
      scope: { tabId: 1, frameId: 0, url: 'https://example.test/page', origin: 'https://example.test' },
      target: {
        nodeRef: 'n_4', selector: '#content',
        fingerprint: { tag: 'main', classes: [], attributes: {} },
      },
      text: '', createdAt: 1,
    }],
  }], 'm');
  assert.match(out[0].content, /#content/);
  assert.match(out[0].content, /"text":""/);
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

test('DeepSeek/pi finish reasons survive the engine adapter', () => {
  assert.equal(toHarnessFinishReason('stop'), 'stop');
  assert.equal(toHarnessFinishReason('toolUse'), 'tool_calls');
  assert.equal(toHarnessFinishReason('length'), 'length');
  assert.equal(toHarnessFinishReason('deferred'), 'unknown');
});

// ------------------------------------------------------ loop: request filter --
test('loop: notes and streaming/error partials never reach the model', async () => {
  const { loop, requests } = await mountHarness(doneText('ok'));
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

test('loop: submitted annotations belong to the canonical user message', async () => {
  const { loop } = await mountHarness(doneText('ok'));
  const annotation = {
    id: 'annotation-1',
    scope: { tabId: 1, frameId: 0, url: 'https://example.test/page', origin: 'https://example.test' },
    target: {
      nodeRef: 'n_4', selector: '#content',
      fingerprint: { tag: 'main', classes: [], attributes: {} },
    },
    text: '只要外部边框', createdAt: 1,
  };
  const submitted = [annotation];
  await loop.run('', { annotations: submitted });
  assert.deepEqual(loop.messages[0].annotations, [annotation]);
  assert.notEqual(loop.messages[0].annotations, submitted);
  assert.notEqual(loop.messages[0].annotations[0], annotation);
});

test('loop snapshots the active session model profile into its request', async () => {
  const task = {
    activeTask: () => ({
      id: 'task-1',
      llm: { profileId: 'opencode-go', model: 'deepseek-v4-pro', thinking: true, reasoningEffort: 'max' },
    }),
  };
  const { loop, requests } = await mountHarness(doneText('ok'), { task });
  await loop.run('goal');
  assert.deepEqual(requests[0].sessionConfig, {
    profileId: 'opencode-go', model: 'deepseek-v4-pro', thinking: true, reasoningEffort: 'max',
  });
});

test('loop publishes Cordis busy and idle lifecycle events', async () => {
  const events = [];
  await applyTestPlugin({ name: 'loop-lifecycle-observer', apply(ctx) {
    ctx.on('loop/busy', () => { events.push('busy'); });
    ctx.on('loop/idle', () => { events.push('idle'); });
  } });
  const { loop } = await mountHarness(doneText('ok'));
  await loop.run('goal');
  assert.deepEqual(events, ['busy', 'idle']);
});

test('loop: length is incomplete, audited, and continued with an internal directive', async () => {
  const events = [];
  const task = {
    activeTask: () => ({ id: 'task-1' }),
    async appendEvent(type, data) { events.push({ type, data }); },
  };
  const { loop, requests } = await mountHarness(async function* (req, turn) {
    if (turn === 1) {
      yield {
        type: 'done', responseId: 'response-1', text: '让我先构造 pre', thinking: '',
        toolCalls: [{ id: 'partial', name: 'page_patch_preview', args: '{"operations":' }],
        finishReason: 'length',
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 120 },
      };
    } else {
      yield {
        type: 'done', responseId: 'response-2', text: '真正完成。', thinking: '', finishReason: 'stop', toolCalls: [],
      };
    }
  }, { task });

  await loop.run('更新页面样式');

  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).text, /Harness continuation/);
  assert.equal(requests[1].messages.some(message => message.status === 'incomplete'), false);
  const assistants = loop.messages.filter(message => message.role === 'assistant');
  assert.deepEqual(assistants.map(message => message.status), ['incomplete', 'done']);
  assert.equal(assistants[0].toolCalls.length, 0, 'a truncated tool call must never execute or enter history');
  assert.deepEqual(events[0], {
    type: 'turn/end',
    data: {
      turn: 1,
      responseId: 'response-1',
      finishReason: 'length',
      outcome: 'incomplete',
      toolCallCount: 1,
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 120 },
    },
  });
  assert.equal(events[1].data.finishReason, 'stop');
  assert.equal(events[1].data.outcome, 'completed');
});

test('loop: length continuation stops after three retries instead of spinning', async () => {
  const { loop, requests } = await mountHarness(async function* () {
    yield { type: 'done', text: 'partial', thinking: '', toolCalls: [], finishReason: 'length' };
  });

  await loop.run('写入长报告');

  assert.equal(requests.length, 4, 'initial turn plus three bounded continuations');
  assert.ok(notesOf(loop).some(text => text.includes('after 3 automatic continuations')));
  assert.ok(loop.messages.filter(message => message.role === 'assistant').every(message => message.status === 'incomplete'));
});

test('loop: tool_calls without a valid call is a protocol error', async () => {
  const events = [];
  const task = {
    activeTask: () => ({ id: 'task-1' }),
    async appendEvent(type, data) { events.push({ type, data }); },
  };
  const { loop, requests } = await mountHarness(async function* () {
    yield { type: 'done', text: '', thinking: '', toolCalls: [], finishReason: 'tool_calls' };
  }, { task });

  await loop.run('修改页面');

  assert.equal(requests.length, 1);
  assert.equal(loop.messages.find(message => message.role === 'assistant').status, 'error');
  assert.ok(notesOf(loop).some(text => text.includes('no complete valid call')));
  assert.equal(events[0].data.outcome, 'protocol-error');
});

test('loop: an empty stop ends once with a clear provider error', async () => {
  const { loop, requests } = await mountHarness(async function* () {
    yield { type: 'done', text: '', thinking: '', toolCalls: [], finishReason: 'stop' };
  });

  await loop.run('修改这个页面');

  assert.equal(requests.length, 1);
  assert.deepEqual(loop.messages.filter(message => message.role === 'assistant').map(message => message.status), ['error']);
  assert.ok(notesOf(loop).some(text => text.includes('empty final response')));
});

test('loop: an omitted terminal state ends once as a protocol error', async () => {
  const { loop, requests } = await mountHarness(async function* () {
    yield { type: 'done', text: 'provider omitted finish reason', thinking: '', toolCalls: [] };
  });

  await loop.run('修改这个页面');

  assert.equal(requests.length, 1);
  assert.deepEqual(loop.messages.filter(message => message.role === 'assistant').map(message => message.status), ['error']);
  assert.ok(notesOf(loop).some(text => text.includes('unhandled finish reason unknown')));
});

test('loop: a prose stop is a valid terminal answer without keyword heuristics or repair', async () => {
  const events = [];
  const task = {
    activeTask: () => ({ id: 'task-1' }),
    async appendEvent(type, data) { events.push({ type, data }); },
  };
  const { loop, requests } = await mountHarness(async function* () {
    yield { type: 'done', text: '你好，有什么可以帮你？', thinking: '', toolCalls: [], finishReason: 'stop' };
  }, { task });

  await loop.run('你好');

  assert.equal(requests.length, 1);
  assert.deepEqual(loop.messages.filter(message => message.role === 'assistant').map(message => message.status), ['done']);
  assert.equal(loop.messages.filter(message => message.role === 'assistant').at(-1).text, '你好，有什么可以帮你？');
  assert.equal(events.at(-1).data.outcome, 'completed');
});

test('loop: a failed tool result may be followed by a normal terminal explanation', async () => {
  const { loop, requests } = await mountHarness(async function* (req, turn) {
    if (turn === 1) {
      yield {
        type: 'done', text: '', thinking: '', finishReason: 'tool_calls',
        toolCalls: [{ id: 'attach-1', name: 'attach_missing', args: '{}', argsObj: {} }],
      };
    } else {
      yield {
        type: 'done', text: '没有找到要附加的文件，请先创建文件或提供现有路径。',
        thinking: '', toolCalls: [], finishReason: 'stop',
      };
    }
  });
  const dispose = useTool({
    name: 'attach_missing', description: '', parameters: z.object({}),
    run: () => 'Error: workspace file .plugins/dice.js does not exist',
  });

  await loop.run('附加 dice plugin');

  assert.equal(requests.length, 2);
  assert.equal(loop.messages.filter(message => message.role === 'assistant').at(-1).status, 'done');
  assert.equal(notesOf(loop).some(text => text.includes('protocol error')), false);
  dispose();
});

// --------------------------------------------------- loop: truncation / veto --
test('loop: tool results truncate at 8000 chars before entering history', async () => {
  const { loop } = await mountHarness(async function* (req, turn) {
    if (turn === 1) yield { type: 'done', text: '', thinking: '', toolCalls: [{ id: 't1', name: 'big', argsObj: {}, args: '{}' }] };
    else yield finishEvent('finished');
  });
  const dispose = useTool({ name: 'big', description: '', parameters: z.object({}), run: () => 'x'.repeat(10_000) });
  await loop.run('goal');
  const call = loop.messages.find(m => m.role === 'assistant')?.toolCalls[0];
  assert.equal(call.result.length, 8000);
  assert.equal(call.status, 'done');
  dispose();
});

test('loop: tools/pre-execute veto blocks the call, tool body never runs', async () => {
  let ran = false;
  const { loop } = await mountHarness(async function* (req, turn) {
    if (turn === 1) yield { type: 'done', text: '', thinking: '', toolCalls: [{ id: 't1', name: 'guarded', argsObj: {}, args: '{}' }] };
    else yield finishEvent('finished');
  });
  const dispose = useTool({ name: 'guarded', description: '', parameters: z.object({}), run: () => { ran = true; return 'secret'; } });
  const off = useBusOn('tools/pre-execute', req => req.name === 'guarded' ? { ...req, veto: 'disabled by policy' } : req);
  await loop.run('goal');
  const call = loop.messages.find(m => m.role === 'assistant')?.toolCalls[0];
  assert.equal(ran, false);
  assert.match(call.result, /^Error: tool call vetoed by a plugin: disabled by policy$/);
  off(); dispose();
});

// ------------------------------------------- loop: per-request snapshot race --
test('loop: mid-turn tool removal — in-flight turn uses the snapshot, next request drops it', async () => {
  const { loop, requests } = await mountHarness(async function* (req, turn) {
    if (turn === 1) yield { type: 'done', text: '', thinking: '', toolCalls: [{ id: 't1', name: 'doomed', argsObj: {}, args: '{}' }] };
    else yield finishEvent('finished');
  });
  let disposeDoomed;
  disposeDoomed = useTool({
    name: 'doomed', description: '', parameters: z.object({}),
    run: () => { disposeDoomed(); return 'ran from snapshot'; }, // v-if/removal lands mid-turn
  });
  await loop.run('goal');
  const call = loop.messages.find(m => m.role === 'assistant')?.toolCalls[0];
  assert.equal(call.result, 'ran from snapshot'); // in-flight turn still executed it
  assert.deepEqual(requests[0].tools, ['doomed']);
  assert.deepEqual(requests[1].tools, []); // doomed is gone from the NEXT request
});

// ------------------------------------------------------- loop: turn failsafe --
test('loop: a model that never stops calling tools hits the failsafe turn limit', async () => {
  const { loop, requests } = await mountHarness(async function* () {
    yield { type: 'done', text: '', thinking: '', toolCalls: [{ id: 'x', name: 'poke', argsObj: {}, args: '{}' }] };
  });
  const dispose = useTool({ name: 'poke', description: '', parameters: z.object({}), run: () => 'ok' });
  await loop.run('goal');
  assert.equal(requests.length, 500); // failsafe kill switch, not a control mechanism
  assert.ok(notesOf(loop).some(t => t.includes('failsafe turn limit (500)')));
  dispose();
});

// ------------------------------------------- loop: compaction plugin seams --
test('loop/turn-start: fires before the request; splices to the log shape it', async () => {
  const { loop, requests } = await mountHarness(doneText('ok'));
  loop.messages.push({ role: 'user', text: 'ancient history' });
  const off = useBusOn('loop/turn-start', (arg, next) => {
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
  const { loop, requests } = await mountHarness(async function* () {
    yield { type: 'error', message: 'maximum context length is 131072 tokens' };
  });
  const off = useBusOn('loop/llm-error', (arg, next) => { fired++; return next({ ...arg, retry: true }); });
  await loop.run('goal');
  assert.equal(fired, 2);           // consulted on both failures
  assert.equal(requests.length, 2); // but retried only once
  assert.ok(notesOf(loop).some(t => t.startsWith('LLM call failed')));
  assert.equal(loop.running.value, false);
  off();
});

// ------------------------------------------------------------ loop: control --
test('loop: stop mid-stream — loop exits with a "stopped" note, no stuck cursor', async () => {
  const checkpoints = [];
  const { loop } = await mountHarness(async function* (req) {
    while (!req.signal.aborted) {
      yield { type: 'update', text: 'working…', thinking: '', toolCalls: [] };
      await sleep(5);
    }
  }, { task: {
    activeTask: () => ({ id: 'task-1', llm: { model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high' } }),
    async saveCheckpoint() { checkpoints.push(loop.messages.map(message => ({ ...message }))); },
  } });
  const p = loop.run('goal');
  await sleep(30);
  assert.equal(checkpoints[0]?.[0]?.text, 'goal', 'the submitted prompt is durable before streaming finishes');
  loop.stop();
  await p;
  assert.ok(notesOf(loop).some(t => t === 'stopped'));
  assert.equal(loop.running.value, false);
  const last = loop.messages.at(-1);
  assert.notEqual(last.status, 'streaming', 'cursor must not be left blinking');
  assert.ok(checkpoints.length >= 2, 'manual stop flushes a final stable checkpoint');
});

test('loop: LLM error lands as a note (with CORS hint on fetch failures)', async () => {
  const { loop } = await mountHarness(async function* () {
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

test('loop releases running state when the final checkpoint stalls', async () => {
  let checkpoints = 0;
  const { loop } = await mountHarness(async function* () {
    yield { type: 'error', message: 'Broker connection closed before the request completed.' };
  }, { task: {
    activeTask: () => ({ id: 'task-1', llm: { profileId: '', model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high' } }),
    async saveCheckpoint() {
      checkpoints++;
      if (checkpoints > 1) await new Promise(() => {});
    },
  } });

  await Promise.race([
    loop.run('goal'),
    sleep(100).then(() => { throw new Error('loop stayed blocked by its final checkpoint'); }),
  ]);
  assert.equal(loop.running.value, false);
  assert.equal(checkpoints, 2);
});

test('loop: re-entry guard — a second run while running is refused', async () => {
  const { loop } = await mountHarness(async function* (req) {
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
    export const answer = mul(7);
    export function apply() {}
  `);
  assert.equal(typeof def.apply, 'function');
  assert.equal(def.name, 'ok42');
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
  return mod.exports.f().then(v => assert.equal(v, 6));
});

test('loop: tool calls and results are persisted as audit events', async () => {
  const events = [];
  const task = {
    activeTask: () => ({ id: 'task-1' }),
    async appendEvent(type, data) { events.push({ type, data }); },
  };
  const { loop } = await mountHarness(async function* (req, turn) {
    if (turn === 1) yield { type: 'done', text: '', thinking: '', toolCalls: [{ id: 'call-1', name: 'inspect', argsObj: { target: 'main' }, args: '{"target":"main"}' }] };
    else yield finishEvent('finished');
  }, { task });
  const dispose = useTool({ name: 'inspect', description: '', parameters: z.object({ target: z.string() }), run: ({ target }) => `found ${target}` });

  await loop.run('goal');

  assert.deepEqual(events.map(event => event.type), ['turn/end', 'tool/call-started', 'tool/call-completed', 'turn/end']);
  assert.deepEqual(events[1].data, { callId: 'call-1', name: 'inspect', args: { target: 'main' } });
  assert.deepEqual(events[2].data, { callId: 'call-1', name: 'inspect', outcome: 'completed', result: 'found main' });
  assert.equal(events[0].data.outcome, 'tool-calls');
  assert.equal(events[3].data.outcome, 'completed');
  dispose();
});

// ------------------------------------------------------------------ bus misc --
test('bus.emit follows Cordis synchronous error propagation', async () => {
  let reached = 0;
  const off1 = useBusOn('misc/emit', () => { throw new Error('boom'); });
  const off2 = useBusOn('misc/emit', () => { reached++; });
  assert.throws(() => runtime.emit('misc/emit'), /boom/);
  assert.equal(reached, 0);
  off1(); off2();
});

test('bus.waterfall: no listeners passes the argument through untouched', async () => {
  const v = { untouched: true };
  assert.equal(await runtime.waterfall('misc/nobody-listens', v, value => value), v);
});
