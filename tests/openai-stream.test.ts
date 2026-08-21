import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiStreamAccumulator } from '../src/extension/openai-stream';

test('OpenAI stream accumulator emits cumulative text, reasoning, tools, and final usage', () => {
  const stream = new OpenAiStreamAccumulator();
  const first = stream.ingest({ choices: [{ delta: { content: '你', reasoning_content: '看', tool_calls: [{ index: 0, id: 'call_', function: { name: 'page_', arguments: '{"sel' } }] } }] });
  const second = stream.ingest({ choices: [{ delta: { content: '好', reasoning_content: '到', tool_calls: [{ index: 0, id: '1', function: { name: 'query', arguments: 'ector":"#app"}' } }] } }] });
  stream.ingest({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  const done = stream.done();

  assert.equal(first.type, 'update');
  assert.equal(first.type === 'update' ? first.text : '', '你');
  assert.equal(second.type === 'update' ? second.text : '', '你好');
  assert.equal(done.type, 'done');
  if (done.type !== 'done') return;
  assert.equal(done.thinking, '看到');
  assert.deepEqual(done.toolCalls[0], {
    id: 'call_1',
    name: 'page_query',
    args: '{"selector":"#app"}',
    argsObj: { selector: '#app' },
  });
  assert.equal(done.usage?.totalTokens, 15);
});
