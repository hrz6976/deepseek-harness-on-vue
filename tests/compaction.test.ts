// Compaction tests: the pure policy helpers plus runCompaction end-to-end
// against a fake llm.stream. Same zero-DOM philosophy as kernel.test.js —
// the plugin's bus/service wiring on top is a few trusted lines.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateMessageTokens, estimateContextTokens, findCutIndex,
  serializeTranscript, runCompaction, DEFAULT_SETTINGS,
} from '@/plugins/compaction';
import { toPiMessages } from '@/plugins/llm';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';

afterEach(async () => { await cleanupTestRuntime(); });

const usage = (totalTokens) => ({ input: totalTokens - 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens });
const asst = (text, extra = {}) => ({ role: 'assistant', text, thinking: '', toolCalls: [], status: 'done', ...extra });

test('estimateContextTokens: last reported usage is ground truth, chars/4 after it', () => {
  const messages = [
    { role: 'user', text: 'x'.repeat(4000) },          // covered by usage below, must NOT be re-counted
    asst('a', { usage: usage(1050) }),
    { role: 'user', text: 'z'.repeat(400) },            // 100 estimated tokens
    { role: 'note', text: 'n'.repeat(4000) },           // notes are free
  ];
  assert.equal(estimateContextTokens(messages), 1150);
});

test('estimateContextTokens: error/streaming assistants and zero usage are skipped', () => {
  const messages = [
    asst('x'.repeat(400), { usage: usage(500) }),
    asst('partial', { status: 'error', usage: usage(9999) }),   // never trusted
    asst('live', { status: 'streaming' }),
  ];
  // 500 (last valid usage) + estimates for the two later messages
  const expected = 500 + estimateMessageTokens(messages[1]) + estimateMessageTokens(messages[2]);
  assert.equal(estimateContextTokens(messages), expected);
});

test('findCutIndex: keeps at least keepRecentTokens, returns 0 when everything fits', () => {
  const big = { role: 'user', text: 'x'.repeat(4000) }; // 1000 tokens each
  const messages = [big, big, big, big];
  assert.equal(findCutIndex(messages, 1500), 2);  // last two = 2000 >= 1500
  assert.equal(findCutIndex(messages, 999999), 0); // whole log fits in budget: nothing to compact
});

test('serializeTranscript: role tags, tool calls with truncated results, notes and thinking dropped', () => {
  const t = serializeTranscript([
    { role: 'summary', text: 'OLD CHECKPOINT' },
    { role: 'user', text: 'do the thing' },
    { role: 'note', text: 'ui noise' },
    asst('done it', { thinking: 'SECRET THOUGHTS', toolCalls: [{ name: 'run_js', args: '{"code":"1"}', result: 'R'.repeat(3000) }] }),
  ]);
  assert.match(t, /\[Previous context checkpoint\]: OLD CHECKPOINT/);
  assert.match(t, /\[User\]: do the thing/);
  assert.match(t, /\[Tool call\]: run_js\(\{"code":"1"\}\)/);
  assert.match(t, /more characters truncated/);
  assert.ok(!t.includes('ui noise'));
  assert.ok(!t.includes('SECRET THOUGHTS'));
});

test('serializeTranscript: persisted page annotations survive compaction', () => {
  const t = serializeTranscript([{
    role: 'user', text: 'fix this', annotations: [{
      id: 'annotation-1',
      scope: { tabId: 1, frameId: 0, url: 'https://example.test/page', origin: 'https://example.test' },
      target: {
        nodeRef: 'n_4', selector: '#content',
        fingerprint: { tag: 'main', text: 'Dashboard', classes: [], attributes: {} },
      },
      text: '边框太重', createdAt: 1,
    }],
  }]);
  assert.match(t, /边框太重/u);
  assert.match(t, /#content/u);
  assert.match(t, /example\.test\/page/u);
});

test('toPiMessages: summary role becomes a user checkpoint message', () => {
  const out = toPiMessages([{ role: 'summary', text: 'THE SUMMARY' }], 'm');
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  assert.match(out[0].content, /^\[Context checkpoint — the earlier conversation was compacted into this summary\]\n\nTHE SUMMARY$/);
});

test('runCompaction: splices the prefix into one summary message, keeps the tail', async () => {
  const big = (s) => ({ role: 'user', text: s.repeat(4000) });
  const messages = [big('a'), asst('old work'), big('b'), { role: 'user', text: 'recent question' }];
  let seenReq;
  const llm = {
    stream: async function* (req) { seenReq = req; yield { type: 'done', text: 'FRESH SUMMARY', thinking: '', toolCalls: [] }; },
  };
  const did = await runCompaction(messages, { llm, settings: { ...DEFAULT_SETTINGS, keepRecentTokens: 1 } });
  assert.equal(did, true);
  assert.equal(messages[0].role, 'summary');
  assert.equal(messages[0].text, 'FRESH SUMMARY');
  assert.ok(messages[0].tokensBefore > 0);
  assert.deepEqual(messages.slice(1).map(m => m.text), ['recent question']);
  // the summarizer saw a serialized document, not a conversation, and no tools
  assert.match(seenReq.messages[0].text, /<conversation>[\s\S]*old work[\s\S]*<\/conversation>/);
  assert.deepEqual(seenReq.tools, []);
  assert.match(seenReq.systemPrompt, /Do NOT continue the conversation/);
  assert.match(seenReq.systemPrompt, /<page_annotations>/);
});

test('runCompaction: invalidates stale provider usage retained from the old transcript', async () => {
  const messages = [
    { role: 'user', text: 'old'.repeat(4000) },
    asst('old answer'),
    asst('recent answer', { usage: usage(116_000) }),
  ];
  const before = estimateContextTokens(messages);
  const llm = {
    stream: async function* () {
      yield { type: 'done', text: 'CHECKPOINT', thinking: '', toolCalls: [] };
    },
  };

  assert.equal(await runCompaction(messages, {
    llm,
    settings: { ...DEFAULT_SETTINGS, keepRecentTokens: 1 },
  }), true);

  assert.equal(messages.at(-1).role, 'assistant');
  assert.equal(messages.at(-1).usage, undefined);
  assert.ok(estimateContextTokens(messages) < before / 10);
});

test('runCompaction: no-op when the prefix holds nothing summarizable', async () => {
  const messages = [{ role: 'summary', text: 'old' }, { role: 'user', text: 'recent question' }];
  const llm = { stream: async function* () { throw new Error('must not be called'); } };
  assert.equal(await runCompaction(messages, { llm, settings: { ...DEFAULT_SETTINGS, keepRecentTokens: 1 } }), false);
  assert.equal(messages.length, 2);
});

test('runCompaction: summarizer failure throws and leaves the log untouched', async () => {
  const messages = [{ role: 'user', text: 'x'.repeat(4000) }, { role: 'user', text: 'recent' }];
  const llm = { stream: async function* () { yield { type: 'error', message: 'boom' }; } };
  await assert.rejects(() => runCompaction(messages, { llm, settings: { ...DEFAULT_SETTINGS, keepRecentTokens: 1 } }), /boom/);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
});

// ---- end-to-end: real loop + real compaction plugin, scripted engine --------
// (this file runs in its own node:test process, so the plugin's global bus
// listeners and services can't leak into the other test files)
test('plugin end-to-end: over-threshold log is compacted before the next request', async () => {
  const { toolsPlugin } = await import('@/plugins/tools');
  const { promptPlugin } = await import('@/plugins/prompt');
  const { loopPlugin } = await import('@/plugins/loop');
  const compactionPlugin = await import('@/plugins/compaction');
  const { runtime } = await import('@/kernel/cordis');

  await applyTestPlugin(toolsPlugin);
  await applyTestPlugin(promptPlugin);
  await provideTestService('fs', { ready: Promise.resolve(), files: new Map(), read: () => null, list: () => [], write: async () => {}, remove: async () => {} });
  const requests = [];
  await provideTestService('llm', {
    contextWindow: 1000, // tiny window so the trigger fires
    stream(req) {
      requests.push(req);
      const isSummarizer = /summarization assistant/.test(req.systemPrompt);
      return (async function* () {
        yield { type: 'done', text: isSummarizer ? 'CHECKPOINT' : 'ok', thinking: '', toolCalls: [] };
      })();
    },
  });
  const taskMessages = [];
  await provideTestService('task', { ready: Promise.resolve(), messages: taskMessages, activeTask: () => null, async appendEvent() {} });
  await applyTestPlugin(loopPlugin);
  await applyTestPlugin(compactionPlugin);
  const loop = runtime.reflect.get('loop');
  const compaction = runtime.reflect.get('compaction');
  compaction.settings.reserveTokens = 500;   // threshold: > 1000 - 500 = 500 tokens
  compaction.settings.keepRecentTokens = 10;

  taskMessages.push({ role: 'user', text: 'a'.repeat(4000) }); // ~1000 tokens — must be summarized away
  taskMessages.push({ role: 'user', text: 'b'.repeat(4000) }); // crosses the keep budget — stays
  await loop.run('finish up');

  assert.equal(taskMessages[0].role, 'summary');
  assert.equal(taskMessages[0].text, 'CHECKPOINT');
  assert.ok(notesOf(taskMessages).includes('上下文接近上限，正在压缩…'));
  assert.ok(notesOf(taskMessages).some(t => /^上下文已压缩：约 \d+k → \d+k tokens$/.test(t)));
  const agentReq = requests.find(r => !/summarization assistant/.test(r.systemPrompt));
  assert.ok(agentReq.messages.some(m => m.role === 'summary'), 'agent request must carry the checkpoint');
  assert.ok(!agentReq.messages.some(m => (m.text || '').includes('aaaa')), 'summarized prefix must be gone');
  assert.ok(agentReq.messages.some(m => (m.text || '').includes('bbbb')), 'kept tail must survive');

});

const notesOf = messages => messages.filter(m => m.role === 'note').map(m => m.text);
