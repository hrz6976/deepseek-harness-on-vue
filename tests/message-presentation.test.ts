import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldDisplayMessage } from '@/extension/message-presentation';

test('context checkpoints stay internal to the model transcript', () => {
  assert.equal(shouldDisplayMessage({
    role: 'summary', text: 'internal checkpoint', tokensBefore: 116_000,
  }), false);
});

test('streaming assistant drafts stay out of the stable message feed', () => {
  assert.equal(shouldDisplayMessage({
    role: 'assistant', text: 'I will inspect the page…', thinking: '', toolCalls: [], status: 'streaming',
  }), false);
});

test('completed tool turns become stable activity records', () => {
  assert.equal(shouldDisplayMessage({
    role: 'assistant', text: 'Let me query that.', thinking: '', status: 'done',
    toolCalls: [{ id: 'call-1', name: 'page_query', args: '{}', status: 'done' }],
  }), true);
});

test('a streaming tool call is visible without exposing its text draft', () => {
  assert.equal(shouldDisplayMessage({
    role: 'assistant', text: 'I might click something…', thinking: '', status: 'streaming',
    toolCalls: [{ id: 'call-1', name: 'page_query', args: '{"selector":"main"}', status: 'running' }],
  }), true);
});

test('only a completed answer without tool calls is presented', () => {
  assert.equal(shouldDisplayMessage({
    role: 'assistant', text: '这是最终回答。', thinking: '', toolCalls: [], status: 'done',
  }), true);
});

test('a length-truncated turn stays hidden even if it contains a partial tool call', () => {
  assert.equal(shouldDisplayMessage({
    role: 'assistant', text: '让我先构造 pre', thinking: '', status: 'incomplete',
    toolCalls: [{ id: 'partial', name: 'page_patch_preview', args: '{"operations":' }],
  }), false);
});
