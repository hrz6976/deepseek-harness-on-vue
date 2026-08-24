import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldDisplayMessage } from '@/extension/message-presentation';

test('context checkpoints stay internal to the model transcript', () => {
  assert.equal(shouldDisplayMessage({
    role: 'summary', text: 'internal checkpoint', tokensBefore: 116_000,
  }), false);
});

test('streaming assistant text is visible immediately', () => {
  assert.equal(shouldDisplayMessage({
    role: 'assistant', text: 'I will inspect the page…', thinking: '', toolCalls: [], status: 'streaming',
  }), true);
});

test('provider reasoning is visible while the assistant is still thinking', () => {
  assert.equal(shouldDisplayMessage({
    role: 'assistant', text: '', thinking: '先读取页面结构', toolCalls: [], status: 'streaming',
  }), true);
});

test('completed tool turns become stable activity records', () => {
  assert.equal(shouldDisplayMessage({
    role: 'assistant', text: 'Let me query that.', thinking: '', status: 'done',
    toolCalls: [{ id: 'call-1', name: 'page_query', args: '{}', status: 'done' }],
  }), true);
});

test('a streaming tool call and its cumulative prose are visible together', () => {
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
