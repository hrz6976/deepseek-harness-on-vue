import { parseJsonObject, type LlmStreamEvent, type TokenUsage } from '@/shared/runtime';

export interface OpenAiStreamChunk {
  id?: string;
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
    finish_reason?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'insufficient_system_resource' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
  } | null;
}

interface PendingToolCall { id: string; name: string; args: string }

export class OpenAiStreamAccumulator {
  #responseId = '';
  #text = '';
  #thinking = '';
  #toolCalls = new Map<number, PendingToolCall>();
  #finishReason: Exclude<LlmStreamEvent, { type: 'error' }>['finishReason'];
  #usage: TokenUsage | undefined;

  ingest(chunk: OpenAiStreamChunk): LlmStreamEvent {
    if (chunk.id) this.#responseId ||= chunk.id;
    const delta = chunk.choices?.[0]?.delta;
    const finishReason = chunk.choices?.[0]?.finish_reason;
    if (finishReason) this.#finishReason = finishReason;
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
        cacheRead: chunk.usage.prompt_cache_hit_tokens ?? 0,
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
      ...(this.#responseId ? { responseId: this.#responseId } : {}),
      text: this.#text,
      thinking: this.#thinking,
      toolCalls: [...this.#toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({ ...call, argsObj: parseJsonObject(call.args) })),
      ...(this.#finishReason ? { finishReason: this.#finishReason } : {}),
      ...(type === 'done' && this.#usage ? { usage: this.#usage } : {}),
    };
  }
}
