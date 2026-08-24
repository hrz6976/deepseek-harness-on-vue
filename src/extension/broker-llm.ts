import { Service, type Context } from '@deepseek-ai/cordis';
import { ref } from 'vue';
import type { LlmRequest, LlmService, LlmStreamEvent } from '@/shared/runtime';

class BrokerLlmRuntime extends Service implements LlmService {
  readonly engineName = ref('trusted broker');
  readonly contextWindow = 131_072;

  constructor(ctx: Context) {
    super(ctx, 'llm');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    try {
      for await (const value of this.ctx.broker.stream({
        provider: 'llm',
        action: 'complete',
        input: { request: {
          systemPrompt: request.systemPrompt,
          messages: request.messages,
          tools: request.tools,
          sessionConfig: request.sessionConfig,
        } },
      })) {
        const event = value as unknown as LlmStreamEvent;
        if (event.type === 'done' || event.type === 'update' || event.type === 'error') yield event;
        else yield { type: 'error', message: 'Trusted LLM broker returned an invalid stream event.' };
      }
    } catch (error) {
      yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }
}

export const brokerLlmPlugin = {
  name: 'broker-llm',
  inject: ['broker'],
  apply(ctx: Context) {
    new BrokerLlmRuntime(ctx);
  },
};
