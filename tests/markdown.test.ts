import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '@/shared/markdown';

test('chat markdown renders structure and safe external links', () => {
  const html = renderMarkdown('# Result\n\n- one\n- two\n\n[docs](https://example.test)');
  assert.match(html, /<h1>Result<\/h1>/);
  assert.match(html, /<ul>/);
  assert.match(html, /href="https:\/\/example\.test"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('chat markdown does not activate raw HTML or javascript links', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))');
  assert.doesNotMatch(html, /<img\b/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /&lt;img/);
});
