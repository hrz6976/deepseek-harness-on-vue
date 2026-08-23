import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiStreamAccumulator } from '@/extension/openai-stream';

test('OpenAI stream accumulator emits cumulative text, reasoning, tools, and final usage', () => {
  const stream = new OpenAiStreamAccumulator();
  const first = stream.ingest({ id: 'response-1', choices: [{ delta: { content: '你', reasoning_content: '看', tool_calls: [{ index: 0, id: 'call_', function: { name: 'page_', arguments: '{"sel' } }] }, finish_reason: null }] });
  const second = stream.ingest({ id: 'response-1', choices: [{ delta: { content: '好', reasoning_content: '到', tool_calls: [{ index: 0, id: '1', function: { name: 'query', arguments: 'ector":"#app"}' } }] }, finish_reason: 'tool_calls' }] });
  stream.ingest({ id: 'response-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 4 } });
  const done = stream.done();

  assert.equal(first.type, 'update');
  assert.equal(first.type === 'update' ? first.text : '', '你');
  assert.equal(second.type === 'update' ? second.text : '', '你好');
  assert.equal(done.type, 'done');
  if (done.type !== 'done') return;
  assert.equal(done.responseId, 'response-1');
  assert.equal(done.finishReason, 'tool_calls');
  assert.equal(done.thinking, '看到');
  assert.deepEqual(done.toolCalls[0], {
    id: 'call_1',
    name: 'page_query',
    args: '{"selector":"#app"}',
    argsObj: { selector: '#app' },
  });
  assert.equal(done.usage?.totalTokens, 15);
  assert.equal(done.usage?.cacheRead, 4);
});
