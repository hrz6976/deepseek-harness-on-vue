import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSandboxBroker } from '@/extension/sandbox-broker';
import type { CapabilityEnvelope } from '@/shared/capability-protocol';
import { normalizeSessionLlmConfig } from '@/shared/task-model';

test('sandbox broker aborts a silent LLM stream immediately and forwards cancellation', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browserWindow = new Window({ url: 'chrome-extension://test/sandbox.html' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });
  try {
    const sent: unknown[] = [];
    const target = { postMessage: (message: unknown) => { sent.push(message); } } as unknown as globalThis.Window;
    const broker = createSandboxBroker(target);
    broker.handleMessage({
      channel: 'harness-shell-v1', type: 'broker-session',
      token: 'session-token-with-at-least-32-bytes', host: 'example.test',
    });
    sent.length = 0;

    const controller = new AbortController();
    const next = broker.stream({
      provider: 'llm', action: 'complete',
      input: { request: {
        systemPrompt: 'system', messages: [], tools: [], sessionConfig: normalizeSessionLlmConfig(),
      } },
    }, controller.signal)[Symbol.asyncIterator]().next();
    await Promise.resolve();

    const completion = sent.find(message => (message as CapabilityEnvelope).payload?.provider === 'llm'
      && (message as CapabilityEnvelope).payload?.action === 'complete') as CapabilityEnvelope;
    assert.ok(completion);

    controller.abort();
    assert.deepEqual(await next, { value: undefined, done: true });
    const cancellation = sent.find(message => (message as { cancel?: boolean }).cancel) as { requestId: string };
    assert.equal(cancellation.requestId, completion.requestId);
  } finally {
    browserWindow.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('ordinary broker requests cancel immediately and late replies cannot revive them', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browserWindow = new Window({ url: 'chrome-extension://test/sandbox.html' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });
  try {
    const sent: unknown[] = [];
    const broker = createSandboxBroker({ postMessage: message => sent.push(message) } as never);
    broker.handleMessage({ channel: 'harness-shell-v1', type: 'broker-session', token: 'session-token-with-at-least-32-bytes' });
    const controller = new AbortController();
    const result = broker.request({ provider: 'workspace', action: 'list', input: {} }, controller.signal);
    const envelope = sent.find(message => (message as CapabilityEnvelope).payload) as CapabilityEnvelope;
    controller.abort();
    await assert.rejects(result, /abort/i);
    assert.ok(sent.some(message => (message as { cancel?: boolean; requestId?: string }).cancel && (message as { requestId: string }).requestId === envelope.requestId));
    broker.handleMessage({ channel: 'harness-broker-v1', requestId: envelope.requestId, ok: true, value: 'late' });
    const next = broker.request({ provider: 'workspace', action: 'list', input: {} });
    const nextEnvelope = sent.at(-1) as CapabilityEnvelope;
    broker.handleMessage({ channel: 'harness-broker-v1', requestId: nextEnvelope.requestId, ok: true, value: { 'file.txt': 'ok' } });
    assert.deepEqual(await next, { 'file.txt': 'ok' });
  } finally {
    browserWindow.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
