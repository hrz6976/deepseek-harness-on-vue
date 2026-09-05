// llm plugin: the engine seam. Exactly one REAL engine (pi-ai with a custom
// DeepSeek provider — deepseekProvider() hardcodes its baseUrl and would
// ignore both cfg.baseURL and the dev /proxy route) plus a ~tiny mock engine
// for keyless/offline demos and loop tests. Both satisfy the same interface:
//   llm.stream(req) -> AsyncIterable<{type:'update'|'done'|'error', text, thinking, toolCalls, message?}>
// where update/done carry cumulative snapshots. llm.stream() is the SOLE
// transport boundary (options.fetch is the Phase-2 GM-shim seam).
//
// Trust note: cfg (incl. apiKey) is closure-captured; the provided service
// object exposes no getter to it, so plugin/tool code cannot read the key
// through the service.
import type { Context as CordisContext, Plugin } from '@deepseek-ai/cordis';
import { ref } from 'vue';
import { createProvider } from '@earendil-works/pi-ai';
import type { AssistantMessage, Context as PiContext, Message, Model, StopReason, Usage } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { errorMessage, log, modelLimitsFor, parseJsonObject, userMessageTextForModel } from '@/sdk';
import type { ModelLimits } from '@/shared/model-limits';
import type { HarnessMessage, LlmRequest, LlmStreamEvent, ToolCall } from '@/shared/runtime';

interface LlmConfig {
  mock?: boolean;
  baseURL: string;
  apiKey?: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  requestOutputTokens?: number;
  fetch?: typeof globalThis.fetch;
}

const IDLE_MS = 45000; // pi-ai has no idle-stream watchdog (timeoutMs is the SDK request timeout), so we wrap: a gateway can drop a stream with no chunk and no error, and without this the loop hangs forever
const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export function toHarnessFinishReason(reason: StopReason): Exclude<LlmStreamEvent, { type: 'error' }>['finishReason'] {
  if (reason === 'toolUse') return 'tool_calls';
  if (reason === 'length') return 'length';
  if (reason === 'stop') return 'stop';
  return 'unknown';
}

// ---- internal message log -> pi-ai Context.messages ------------------------
// Invariants carried over from the PoC (enumerated in TESTING.md):
//   - only user/assistant messages are sent; notes and streaming/error
//     partials are filtered by the LOOP before calling stream()
//   - every toolCall gets a matching toolResult (aborted ones get a stub)
export function toPiMessages(messages: HarnessMessage[], modelId: string): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: userMessageTextForModel(m), timestamp: Date.now() });
    else if (m.role === 'summary') // compaction checkpoint goes to the model as user prose (pi does the same)
      out.push({ role: 'user', content: `[Context checkpoint — the earlier conversation was compacted into this summary]\n\n${m.text}`, timestamp: Date.now() });
    else if (m.role === 'assistant') {
      const content: AssistantMessage['content'] = [];
      if (m.thinking) content.push({ type: 'thinking', thinking: m.thinking });
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls) content.push({ type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.argsObj ?? parseJsonObject(tc.args) });
      out.push({
        role: 'assistant', content, api: 'openai-completions', provider: 'deepseek', model: modelId,
        usage: zeroUsage(), stopReason: m.toolCalls.length ? 'toolUse' : 'stop', timestamp: Date.now()
      });
      for (const tc of m.toolCalls)
        out.push({
          role: 'toolResult', toolCallId: tc.id, toolName: tc.name,
          content: [{ type: 'text', text: tc.result ?? '(aborted, not executed)' }], isError: false, timestamp: Date.now()
        });
    }
  }
  return out;
}

// ---- real engine: pi-ai custom provider ------------------------------------
function makePiEngine(cfg: LlmConfig, limits: ModelLimits): (request: LlmRequest) => AsyncIterable<LlmStreamEvent> {
  // Relative baseURL ("/proxy") -> absolute: the SDK underneath pi-ai joins
  // URLs and rejects relative bases. Empty key -> "pi-local" placeholder: the
  // dev proxy replaces that token with the local pi credential server-side,
  // so the real key never enters the page.
  const baseURL = typeof location !== 'undefined' ? new URL(cfg.baseURL, location.origin).href.replace(/\/+$/, '') : cfg.baseURL;
  const apiKey = cfg.apiKey || 'pi-local';
  // provider id "deepseek" keeps pi-ai's compat auto-detect on the DeepSeek
  // path (thinking format, max_tokens field) even behind a proxy baseURL.
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
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: limits.contextWindow, maxTokens: limits.requestOutputTokens,
  };
  return async function* piStream({ systemPrompt, messages, tools, signal }: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const ctx = { systemPrompt, messages: toPiMessages(messages, model.id), tools } as unknown as PiContext;
    // retry is built into pi-ai's SDK layer; the PoC's withRetry is gone
    const stream = provider.stream(model, ctx, { apiKey, signal, fetch: cfg.fetch });
    const snapOf = (p: AssistantMessage): { text: string; thinking: string; toolCalls: ToolCall[] } => ({
      text: p.content.filter(c => c.type === 'text').map(c => c.text).join(''),
      thinking: p.content.filter(c => c.type === 'thinking').map(c => c.thinking).join(''),
      toolCalls: p.content.filter(c => c.type === 'toolCall').map(c => ({ id: c.id, name: c.name, argsObj: c.arguments, args: JSON.stringify(c.arguments ?? {}) })),
    });
    try {
      for await (const ev of withIdleGuard(stream, signal)) {
        const p = ev.type === 'done' ? ev.message : ev.type === 'error' ? ev.error : ev.partial;
        if (ev.type === 'done') {
          yield {
            type: 'done',
            ...snapOf(p),
            ...(p.responseId ? { responseId: p.responseId } : {}),
            finishReason: toHarnessFinishReason(p.stopReason),
            usage: p.usage,
          };
          return;
        } // provider-reported usage drives compaction; stopReason drives loop completion
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
        throw new Error(`stream silent for ${IDLE_MS / 1000}s, treating as dropped (gateway/proxy cut)`);
      }
      throw error;
    } finally { clearTimeout(timer); }
    if (result.done) return;
    yield result.value;
  }
}

// ---- mock engine: keyless/offline demo -------------------------------------
// Drives one canned tool round (against a really-registered tool, so the full
// tools/pre-execute -> call -> toolResult path runs) and then streamed text.
function makeMockEngine(): (request: LlmRequest) => AsyncIterable<LlmStreamEvent> {
  const THINK = 'mock thinking: no key, no network.';
  return async function* mockStream({ messages, tools, signal }: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    const last = [...messages].reverse().find(m => m.role === 'assistant');
    const wantTool = tools.some(tool => tool.name === 'run_js') && !(last?.role === 'assistant' && last.toolCalls.length);
    const words = (wantTool
      ? 'Mock engine here. Let me verify the tool path with run_js:'
      : 'Tool round came back — streaming works end-to-end without a key. Connect a real endpoint in Settings when ready.'
    ).split(' ');
    let text = '';
    for (const w of words) {
      if (signal?.aborted) return;
      text += (text ? ' ' : '') + w;
      yield { type: 'update', text, thinking: THINK, toolCalls: [] };
      await delay(60);
    }
    const toolCalls = wantTool
      ? [{ id: 'mock_call_1', name: 'run_js', argsObj: { code: 'console.log(6 * 7)' }, args: '{"code":"console.log(6 * 7)"}' }]
      : [];
    // fake but shape-correct usage so compaction is exercisable offline
    const input = Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length) / 4);
    const output = Math.ceil(text.length / 4);
    yield {
      type: 'done', text, thinking: THINK, toolCalls, finishReason: wantTool ? 'tool_calls' : 'stop',
      usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output }
    };
  };
}

// ---- the plugin -------------------------------------------------------------
function setupLlm(ctx: CordisContext, cfg: LlmConfig): void {
  const mock = !!cfg.mock;
  const limits = modelLimitsFor(cfg.model, cfg);
  const engineName = ref(mock ? 'mock engine (offline)' : `pi-ai · ${cfg.model}`);
  const engine = mock ? makeMockEngine() : makePiEngine(cfg, limits);
  ctx.provide('llm', {
    engineName,
    limits: () => limits,
    stream: (request: LlmRequest) => engine(request),
  });
  ctx.effect(() => () => log('llm plugin unmounted', 'warn'), 'llm.log-dispose');
}

// Mounted on demand: the standalone connection service passes cfg through manager.mount() into the
// Cordis plugin config. The service deliberately exposes no config getter.
export default {
  name: 'llm',
  apply: (ctx: CordisContext, config: { cfg?: LlmConfig } = {}) => setupLlm(ctx, config.cfg ?? { baseURL: '/proxy', model: 'deepseek-v4-flash' }),
} satisfies Plugin.Object;
