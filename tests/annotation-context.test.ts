import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSubmitPageMessage, takeAnnotationSubmission } from '@/extension/annotation-context';
import { formatAnnotationContext, userMessageTextForModel } from '@/shared/message-annotations';
import type { Annotation } from '@/shared/page-protocol';

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
  assert.match(prompt, /page_style_inspect/);
  assert.equal(formatAnnotationContext([]), '');

  const modelText = userMessageTextForModel({ role: 'user', text: '1', annotations: [annotation] });
  assert.match(modelText, /^1/);
  assert.match(modelText, /这是个啥/);
  assert.match(modelText, /#content/);

  const composerAnnotations = [annotation];
  const submittedAnnotations = takeAnnotationSubmission(composerAnnotations);
  assert.deepEqual(submittedAnnotations, [annotation]);
  assert.deepEqual(composerAnnotations, []);

  assert.equal(canSubmitPageMessage('', [annotation]), true);
  assert.match(formatAnnotationContext([{ ...annotation, text: '' }]), /"text": ""/u);
  assert.equal(canSubmitPageMessage('1', []), true);
  assert.equal(canSubmitPageMessage('   ', []), false);
});
