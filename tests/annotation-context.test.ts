import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachAnnotationContext, canSubmitPageMessage, formatAnnotationContext, takeAnnotationSubmission } from '../src/extension/annotation-context';
import type { Annotation } from '../src/shared/page-protocol';

test('annotation context preserves user text and the selected element identity', () => {
  const annotation: Annotation = {
    id: 'annotation-1',
    scope: { tabId: 1, frameId: 0, url: 'https://example.test/page', origin: 'https://example.test' },
    target: {
      nodeRef: 'n_4',
      selector: '#content',
      fingerprint: { tag: 'main', id: 'content', text: 'Dashboard', classes: ['layout'], attributes: {} },
      rect: { x: 10, y: 20, width: 300, height: 200 },
    },
    text: '这是个啥',
    createdAt: 1,
  };

  const prompt = formatAnnotationContext([annotation]);
  assert.match(prompt, /这是个啥/);
  assert.match(prompt, /#content/);
  assert.match(prompt, /Dashboard/);
  assert.match(prompt, /https:\/\/example\.test\/page/);
  assert.equal(formatAnnotationContext([]), '');

  const request = attachAnnotationContext({
    systemPrompt: 'system',
    messages: [{ role: 'user', text: '1' }],
    tools: [],
    signal: new AbortController().signal,
  }, prompt);
  assert.equal(request.messages[0]?.role, 'user');
  assert.match(request.messages[0]?.text ?? '', /^1/);
  assert.match(request.messages[0]?.text ?? '', /这是个啥/);
  assert.match(request.messages[0]?.text ?? '', /#content/);

  const composerAnnotations = [annotation];
  const submittedAnnotations = takeAnnotationSubmission(composerAnnotations);
  assert.deepEqual(submittedAnnotations, [annotation]);
  assert.deepEqual(composerAnnotations, []);

  assert.equal(canSubmitPageMessage('', [annotation]), true);
  assert.equal(canSubmitPageMessage('1', []), true);
  assert.equal(canSubmitPageMessage('   ', []), false);
});
