import type { JsonObject, LlmStreamEvent, TokenUsage } from '../shared/runtime';

export interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

interface PendingToolCall { id: string; name: string; args: string }

export class OpenAiStreamAccumulator {
  #text = '';
  #thinking = '';
  #toolCalls = new Map<number, PendingToolCall>();
  #usage: TokenUsage | undefined;

  ingest(chunk: OpenAiStreamChunk): LlmStreamEvent {
    const delta = chunk.choices?.[0]?.delta;
    this.#text += delta?.content ?? '';
    this.#thinking += delta?.reasoning_content ?? '';
    for (const fragment of delta?.tool_calls ?? []) {
      const call = this.#toolCalls.get(fragment.index) ?? { id: '', name: '', args: '' };
      call.id += fragment.id ?? '';
      call.name += fragment.function?.name ?? '';
      call.args += fragment.function?.arguments ?? '';
      this.#toolCalls.set(fragment.index, call);
    }
    if (chunk.usage) {
      this.#usage = {
        input: chunk.usage.prompt_tokens,
        output: chunk.usage.completion_tokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: chunk.usage.total_tokens,
      };
    }
    return this.event('update');
  }

  done(): LlmStreamEvent {
    return this.event('done');
  }

  private event(type: 'update' | 'done'): LlmStreamEvent {
    return {
      type,
      text: this.#text,
      thinking: this.#thinking,
      toolCalls: [...this.#toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({ ...call, argsObj: parseArgs(call.args) })),
      ...(type === 'done' && this.#usage ? { usage: this.#usage } : {}),
    };
  }
}

function parseArgs(source: string): JsonObject {
  try {
    const value = JSON.parse(source) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
  } catch { return {}; }
}
