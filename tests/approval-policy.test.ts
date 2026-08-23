import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalForRequest } from '../src/extension/approval-policy';

test('temporary page patches need no shell prompt while persistent and high-risk actions do', () => {
  const patch = approvalForRequest({ provider: 'page', action: 'command', input: { command: { type: 'page/patch-apply', label: 'Polish table', operations: [] } } });
  assert.equal(patch, null);

  const save = approvalForRequest({
    provider: 'site-skill',
    action: 'save',
    input: { skill: { id: 'r1', name: 'Modern table', matches: ['https://example.test/*'], enabled: true, world: 'ISOLATED', createdAt: 1, updatedAt: 1 } },
  });
  assert.match(save?.title ?? '', /安装页面插件/);

  const userScript = approvalForRequest({
    provider: 'site-skill',
    action: 'save',
    input: { skill: {
      type: 'userscript', id: 's1', name: 'Calendar grouping', matches: ['https://example.test/calendar*'],
      enabled: true, runAt: 'document_idle', source: 'document.body.dataset.ready = "1"', createdAt: 1, updatedAt: 1,
    } },
  });
  assert.match(userScript?.title ?? '', /页面脚本/);
  assert.equal(userScript?.danger, true);
  assert.match(userScript?.body ?? '', /document\.body/);

  assert.equal(approvalForRequest({ provider: 'page', action: 'command', input: { command: { type: 'page/snapshot' } } }), null);

  const target = { nodeRef: 'n1', selector: '#submit', fingerprint: { tag: 'button', classes: [], attributes: {}, name: 'Submit' } };
  assert.match(approvalForRequest({ provider: 'page', action: 'command', input: { command: { type: 'page/click', target } } })?.title ?? '', /页面交互/);
  assert.equal(approvalForRequest({ provider: 'page', action: 'command', input: { command: { type: 'page/settle' } } }), null);
});
