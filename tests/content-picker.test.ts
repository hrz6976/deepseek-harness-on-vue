import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnnotation } from '@/extension/content-picker';

test('page annotations may intentionally attach a target with empty text', () => {
  const target = { nodeRef: 'node-1', selector: '#hero', fingerprint: { tag: 'section', classes: [], attributes: {} } };
  const scope = { tabId: 7, frameId: 0, url: 'https://example.test/', origin: 'https://example.test' };
  assert.deepEqual(buildAnnotation(target, scope, '   ', 123), {
    id: 'annotation_123', scope, target, text: '', createdAt: 123,
  });
});
