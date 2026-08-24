// Shared LLM engine seam: pi-ai with a DeepSeek-compatible OpenAI-completions
// provider. Pure TypeScript — no Vue, no chrome.* — so BOTH the sandboxed llm
// plugin and the trusted service worker bundle exactly one engine instead of
// each carrying its own SDK stack.
//
//   createPiStream(cfg)(request) -> AsyncIterable<LlmStreamEvent>
//
// update/done events carry cumulative snapshots; usage on done drives
// compaction. An idle watchdog converts silently-dropped gateway streams into
// LLM errors instead of a hung loop.
import { createProvider } from '@earendil-works/pi-ai';
import type { AssistantMessage, Context, Message, Model, Usage } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { HarnessMessage, JsonObject, LlmRequest, LlmStreamEvent, ToolCall } from './runtime';
import { errorMessage } from './runtime';

export interface PiEngineConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  contextWindow?: number;
  fetch?: typeof globalThis.fetch;
}

export const DEFAULT_CONTEXT_WINDOW = 131072; // DeepSeek-class default

const IDLE_MS = 45000; // pi-ai has no idle-stream watchdog (timeoutMs is the SDK request timeout), so we wrap: a gateway can drop a stream with no chunk and no error, and without this the loop hangs forever

function tryParse(source: string): JsonObject {
  try { return JSON.parse(source) as JsonObject; } catch { return {}; }
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

// ---- internal message log -> pi-ai Context.messages ------------------------
// Invariants carried over from the PoC (enumerated in TESTING.md):
//   - only user/assistant messages are sent; notes and streaming/error
//     partials are filtered by the LOOP before calling stream()
//   - every toolCall gets a matching toolResult (aborted ones get a stub)
export function toPiMessages(messages: HarnessMessage[], modelId: string): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text, timestamp: Date.now() });
    else if (m.role === 'summary') // compaction checkpoint goes to the model as user prose (pi does the same)
      out.push({ role: 'user', content: `[Context checkpoint — the earlier conversation was compacted into this summary]\n\n${m.text}`, timestamp: Date.now() });
    else if (m.role === 'assistant') {
      const content: AssistantMessage['content'] = [];
      if (m.thinking) content.push({ type: 'thinking', thinking: m.thinking });
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls) content.push({ type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.argsObj ?? tryParse(tc.args) });
      out.push({ role: 'assistant', content, api: 'openai-completions', provider: 'deepseek', model: modelId,
                 usage: zeroUsage(), stopReason: m.toolCalls.length ? 'toolUse' : 'stop', timestamp: Date.now() });
      for (const tc of m.toolCalls)
        out.push({ role: 'toolResult', toolCallId: tc.id, toolName: tc.name,
                   content: [{ type: 'text', text: tc.result ?? '(aborted, not executed)' }], isError: false, timestamp: Date.now() });
    }
  }
  return out;
}

export function createPiStream(cfg: PiEngineConfig): (request: LlmRequest) => AsyncIterable<LlmStreamEvent> {
  // The SDK underneath pi-ai joins endpoint URLs and requires an absolute
  // base. An empty key uses a harmless placeholder; local Bridge authenticates
  // upstream from its own environment, so provider keys never enter the page.
  const baseURL = typeof location !== 'undefined' ? new URL(cfg.baseURL, location.origin).href.replace(/\/+$/, '') : cfg.baseURL;
  const apiKey = cfg.apiKey || 'pi-local';
  // provider id "deepseek" keeps pi-ai's compat auto-detect on the DeepSeek
  // path (thinking format, max_tokens field) even behind a Bridge base URL.
  const provider = createProvider<'openai-completions'>({
    id: 'deepseek',
    name: 'DeepSeek (custom endpoint)',
    baseUrl: baseURL,
    auth: { apiKey: { name: 'key', login: async () => { throw new Error('unused'); }, resolve: async () => undefined } },
    models: [],
    api: openAICompletionsApi(),
  });
  const model: Model<'openai-completions'> = {
    id: cfg.model, name: cfg.model, api: 'openai-completions', provider: 'deepseek',
    baseUrl: baseURL, reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: cfg.contextWindow || DEFAULT_CONTEXT_WINDOW, maxTokens: 8192,
  };
  return async function* piStream({ systemPrompt, messages, tools, signal }: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const ctx = { systemPrompt, messages: toPiMessages(messages, model.id), tools } as unknown as Context;
    // retry is built into pi-ai's SDK layer
    const stream = provider.stream(model, ctx, { apiKey, signal, fetch: cfg.fetch, maxRetries: 2, timeoutMs: 60_000 });
    const snapOf = (p: AssistantMessage): { text: string; thinking: string; toolCalls: ToolCall[] } => ({
      text: p.content.filter(c => c.type === 'text').map(c => c.text).join(''),
      thinking: p.content.filter(c => c.type === 'thinking').map(c => c.thinking).join(''),
      toolCalls: p.content.filter(c => c.type === 'toolCall').map(c => ({ id: c.id, name: c.name, argsObj: c.arguments, args: JSON.stringify(c.arguments ?? {}) })),
    });
    try {
      for await (const ev of withIdleGuard(stream, signal)) {
        const p = ev.type === 'done' ? ev.message : ev.type === 'error' ? ev.error : ev.partial;
        if (ev.type === 'done') { yield { type: 'done', ...snapOf(p), usage: p.usage }; return; } // usage: provider-reported tokens, drives compaction
        if (ev.type === 'error') {
          if (p.stopReason === 'aborted') return; // manual stop: the loop's signal check finishes up
          yield { type: 'error', message: p.errorMessage || 'unknown LLM error' };
          return;
        }
        yield { type: 'update', ...snapOf(p) };
      }
    } catch (error: unknown) {
      if (signal?.aborted) return;
      yield { type: 'error', message: errorMessage(error) }; // idle watchdog + transport failures land as LLM errors, not loop crashes
    }
  };
}

async function* withIdleGuard<T>(stream: AsyncIterable<T>, signal?: AbortSignal): AsyncIterable<T> {
  const it = stream[Symbol.asyncIterator]();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('IDLE_TIMEOUT')), IDLE_MS); });
    let result: IteratorResult<T>;
    try { result = await Promise.race([it.next(), idle]); }
    catch (error: unknown) {
      if (error instanceof Error && error.message === 'IDLE_TIMEOUT' && !signal?.aborted) {
        await it.return?.();
        throw new Error(`stream silent for ${IDLE_MS / 1000}s, treating as dropped (gateway/Bridge cut)`);
      }
      throw error;
    } finally { clearTimeout(timer); }
    if (result.done) return;
    yield result.value;
  }
}
