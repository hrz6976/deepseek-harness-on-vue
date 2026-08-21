import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { createBrokerEnvelope } from '../src/shared/broker-schema';

test('broker envelope removes Vue proxies before the structured-clone boundary', () => {
  const messages = reactive([{ role: 'user' as const, text: 'hello' }]);
  const tools = reactive([{
    name: 'inspect',
    description: 'Inspect the page',
    parameters: { type: 'object', properties: { selector: { type: 'string' } } },
  }]);

  const envelope = createBrokerEnvelope('request-1', {
    kind: 'llm/complete',
    request: { systemPrompt: 'system', messages, tools },
  });

  assert.doesNotThrow(() => structuredClone(envelope));
  assert.notEqual(envelope.payload.kind === 'llm/complete' ? envelope.payload.request.messages : null, messages);
});
