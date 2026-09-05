import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { AnnotationSchema, assertCapabilitySession, createCapabilityEnvelope, SiteRecipeSchema, SiteUserScriptSchema } from '@/shared/broker-schema';
import { systemPrincipal } from '@/kernel/broker';
import { workspaceRevision } from '@/shared/capability-protocol';
import { matchesPagePattern } from '@/shared/page-protocol';
import { normalizeSessionLlmConfig } from '@/shared/task-model';

test('broker envelope removes Vue proxies before the structured-clone boundary', () => {
  const messages = reactive([{ role: 'user' as const, text: 'hello', annotations: [{
    id: 'annotation-1',
    scope: { tabId: 1, frameId: 0, url: 'https://example.test/page', origin: 'https://example.test' },
    target: {
      nodeRef: 'n_4', selector: '#content',
      fingerprint: { tag: 'main', classes: [], attributes: {} },
    },
    text: '', createdAt: 1,
  }] }]);
  const tools = reactive([{
    name: 'inspect',
    description: 'Inspect the page',
    parameters: { type: 'object', properties: { selector: { type: 'string' } } },
  }]);

  const envelope = createCapabilityEnvelope('session-token-with-at-least-32-bytes', 'request-1', systemPrincipal(), {
    provider: 'llm',
    action: 'complete',
    input: { request: { systemPrompt: 'system', messages, tools, sessionConfig: normalizeSessionLlmConfig() } },
  });

  assert.doesNotThrow(() => structuredClone(envelope));
  assert.equal(envelope.principal.id, 'kernel:shell');
  assert.doesNotThrow(() => assertCapabilitySession(envelope, 'session-token-with-at-least-32-bytes'));
  assert.throws(() => assertCapabilitySession(envelope, 'forged-session-token-with-32-bytes'), /authentication failed/);
  assert.notEqual(envelope.payload.provider === 'llm' && envelope.payload.action === 'complete'
    ? envelope.payload.input.request.messages
    : null, messages);
  const parsedMessage = envelope.payload.provider === 'llm' && envelope.payload.action === 'complete'
    ? envelope.payload.input.request.messages[0] : null;
  assert.equal(parsedMessage?.role === 'user' ? parsedMessage.annotations?.[0]?.target.selector : null, '#content');
});

test('broker validates bounded public web requests', () => {
  assert.doesNotThrow(() => createCapabilityEnvelope(
    'session-token-with-at-least-32-bytes', 'request-web', systemPrincipal(),
    { provider: 'web', action: 'search', input: { query: 'Yuri anime news', limit: 6 } },
  ));
  assert.throws(() => createCapabilityEnvelope(
    'session-token-with-at-least-32-bytes', 'request-web-bad', systemPrincipal(),
    { provider: 'web', action: 'open', input: { url: 'file:///etc/passwd' } },
  ));
});

test('annotation schema is the persisted type boundary and keeps empty notes', () => {
  assert.equal(AnnotationSchema.safeParse({
    id: 'annotation-1',
    scope: { tabId: 1, frameId: 0, url: 'https://example.test/page', origin: 'https://example.test' },
    target: {
      nodeRef: 'n_4', selector: '#content',
      fingerprint: { tag: 'main', classes: [], attributes: {} },
    },
    text: '', createdAt: 1,
  }).success, true);
});

test('workspace revisions distinguish absent and changed file bodies', () => {
  assert.equal(workspaceRevision(null), 'absent');
  assert.equal(workspaceRevision('same'), workspaceRevision('same'));
  assert.notEqual(workspaceRevision('same'), workspaceRevision('changed'));
});

test('persisted page code has a distinct userscript schema', () => {
  assert.equal(SiteUserScriptSchema.safeParse({
    type: 'userscript', id: 'calendar', name: 'Calendar grouping',
    matches: ['https://example.test/calendar*'], enabled: true,
    runAt: 'document_idle', source: 'document.body.dataset.ready = "1"',
    createdAt: 1, updatedAt: 1,
  }).success, true);
  assert.equal(SiteRecipeSchema.safeParse({
    type: 'recipe', id: 'calendar', name: 'Calendar grouping',
    matches: ['https://example.test/calendar*'], enabled: true, world: 'ISOLATED',
    source: 'document.body.remove()', createdAt: 1, updatedAt: 1,
  }).success, false);
});

test('page match patterns share one implementation across UI and runtime', () => {
  assert.equal(matchesPagePattern('https://*.example.test/calendar*', 'https://www.example.test/calendar/1'), true);
  assert.equal(matchesPagePattern('https://*.example.test/calendar*', 'https://www.example.test/news'), false);
  assert.equal(matchesPagePattern('<all_urls>', 'chrome://extensions'), false);
});
