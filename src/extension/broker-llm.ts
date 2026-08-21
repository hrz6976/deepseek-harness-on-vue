import { ref } from 'vue';
import { getService, provideService } from '../kernel/services';
import type { LlmRequest, LlmStreamEvent } from '../shared/runtime';

export const brokerLlmPlugin = {
  name: 'broker-llm',
  setup() {
    const engineName = ref('trusted broker');
    provideService('llm', {
      engineName,
      contextWindow: 131_072,
      async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
        const broker = getService('broker');
        if (!broker) {
          yield { type: 'error', message: 'Trusted LLM broker is unavailable.' };
          return;
        }
        try {
          for await (const value of broker.stream({
            kind: 'llm/complete',
            request: {
              systemPrompt: request.systemPrompt,
              messages: request.messages,
              tools: request.tools,
            },
          })) {
            const event = value as unknown as LlmStreamEvent;
            if (event.type === 'done' || event.type === 'update' || event.type === 'error') yield event;
            else yield { type: 'error', message: 'Trusted LLM broker returned an invalid stream event.' };
          }
        } catch (error) {
          yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
        }
      },
    });
    return () => null;
  },
};
