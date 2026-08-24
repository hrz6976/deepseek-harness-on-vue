import { Service, type Context } from '@deepseek-ai/cordis';
import { ref } from 'vue';
import { modelLimitsFor } from '@/shared/model-limits';
import type { LlmRequest, LlmService, LlmStreamEvent } from '@/shared/runtime';
import { DEFAULT_SESSION_LLM_CONFIG, type SessionLlmConfig } from '@/shared/task-model';

class BrokerLlmRuntime extends Service implements LlmService {
  readonly engineName = ref('trusted broker');
  readonly limits = (sessionConfig?: SessionLlmConfig) =>
    modelLimitsFor(sessionConfig?.model ?? DEFAULT_SESSION_LLM_CONFIG.model);

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
      }, request.signal)) {
        const event = value as unknown as LlmStreamEvent;
        if (event.type === 'done' || event.type === 'update' || event.type === 'error') yield event;
        else yield { type: 'error', message: 'Trusted LLM broker returned an invalid stream event.' };
      }
    } catch (error) {
      if (request.signal.aborted) return;
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
