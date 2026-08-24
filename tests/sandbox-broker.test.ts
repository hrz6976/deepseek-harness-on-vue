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
    const cancellation = sent.find(message => (message as CapabilityEnvelope).payload?.provider === 'llm'
      && (message as CapabilityEnvelope).payload?.action === 'cancel') as CapabilityEnvelope;
    assert.equal(cancellation.payload.provider === 'llm' && cancellation.payload.action === 'cancel'
      ? cancellation.payload.input.requestId
      : null, completion.requestId);
  } finally {
    browserWindow.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
