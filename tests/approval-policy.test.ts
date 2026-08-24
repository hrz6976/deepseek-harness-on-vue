import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalForRequest } from '@/extension/approval-policy';

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
  assert.equal(approvalForRequest({ provider: 'page', action: 'command', input: {
    command: { type: 'page/style-inspect', target, pseudo: '::after' },
  } }), null);
  assert.match(approvalForRequest({ provider: 'page', action: 'command', input: { command: { type: 'page/click', target } } })?.title ?? '', /页面交互/);
  assert.equal(approvalForRequest({ provider: 'page', action: 'command', input: { command: { type: 'page/settle' } } }), null);
  const script = approvalForRequest({ provider: 'page', action: 'command', input: {
    command: { type: 'page/eval', world: 'USER_SCRIPT', code: 'document.body.dataset.ready = "1"' },
  } });
  assert.equal(script?.danger, true, 'arbitrary page code retains one explicit high-risk boundary');

  const mcp = approvalForRequest({ provider: 'mcp', action: 'connect', input: { id: 'local', url: 'http://localhost:3001/mcp' } });
  assert.deepEqual(mcp?.origins, ['http://localhost/*']);

  const web = approvalForRequest({ provider: 'web', action: 'search', input: { query: 'DeepSeek API docs' } });
  assert.deepEqual(web?.origins, ['http://*/*', 'https://*/*']);
  assert.equal(web?.reuseGrantedOrigins, true);
  assert.match(web?.body ?? '', /默认搜索引擎/u);
});
