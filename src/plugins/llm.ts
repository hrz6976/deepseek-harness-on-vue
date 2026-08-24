// llm plugin: the engine seam. Exactly one REAL engine (pi-ai via
// shared/pi-engine.ts) plus a ~tiny mock engine for keyless/offline demos and
// loop tests. Both satisfy the same interface:
//   llm.stream(req) -> AsyncIterable<{type:'update'|'done'|'error', text, thinking, toolCalls}>
// llm.stream() is the SOLE transport boundary.
//
// Trust note: cfg (incl. apiKey) is closure-captured; the provided service
// object exposes no getter to it, so plugin/tool code cannot read the key
// through the service.
import { ref, onUnmounted, getCurrentInstance } from 'vue';
import { createPiStream, DEFAULT_CONTEXT_WINDOW } from '../shared/pi-engine';
import type { LlmRequest, LlmStreamEvent } from '../shared/runtime';
import { provideService } from '../kernel/services';
import { log } from '../kernel/log';

interface LlmConfig {
  mock?: boolean;
  baseURL: string;
  apiKey?: string;
  model: string;
  contextWindow?: number;
  fetch?: typeof globalThis.fetch;
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
    yield { type: 'done', text, thinking: THINK, toolCalls,
            usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output } };
  };
}

// ---- the plugin -------------------------------------------------------------
function setupLlm(cfg: LlmConfig) {
  const mock = !!cfg.mock;
  const engineName = ref(mock ? 'mock engine (offline)' : `pi-ai · ${cfg.model}`);
  const engine = mock ? makeMockEngine() : createPiStream(cfg);
  provideService('llm', {
    engineName,
    contextWindow: cfg.contextWindow || DEFAULT_CONTEXT_WINDOW,
    stream: (request: LlmRequest) => engine(request),
  });
  if (getCurrentInstance()) onUnmounted(() => log('llm plugin unmounted', 'warn'));
  return () => null;
}

// Mounted ON DEMAND (autoMount:false in the defaults manifest): settings
// calls manager.mount('llm', { cfg }) on connect, and PluginHost hands the
// config through as props — that is how a from-OPFS plugin receives runtime
// configuration. cfg stays closure/props-captured; the service exposes no
// getter to it.
export default {
  name: 'llm',
  props: { cfg: Object },
  setup: (props: { cfg?: LlmConfig }) => setupLlm(props.cfg ?? { baseURL: 'http://localhost:8787/v1', model: 'deepseek-v4-flash' }),
};

// Test/embedding face: same plugin with the config frozen in.
export const makeLlmPlugin = (cfg: LlmConfig) => ({ name: 'llm', setup: () => setupLlm(cfg) });
