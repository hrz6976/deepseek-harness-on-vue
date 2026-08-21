import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalForRequest } from '../src/extension/approval-policy';

test('temporary page patches need no shell prompt while persistent and high-risk actions do', () => {
  const patch = approvalForRequest({ kind: 'page', command: { type: 'page/patch-apply', label: 'Polish table', operations: [] } });
  assert.equal(patch, null);

  const save = approvalForRequest({
    kind: 'recipe/save',
    recipe: { id: 'r1', name: 'Modern table', matches: ['https://example.test/*'], enabled: true, world: 'ISOLATED', createdAt: 1, updatedAt: 1 },
  });
  assert.match(save?.title ?? '', /安装页面插件/);

  assert.equal(approvalForRequest({ kind: 'page', command: { type: 'page/snapshot' } }), null);
});
