// loop plugin: the agent loop. Streaming consumption, unbounded tool rounds
// (with a high failsafe), the five waterfall interception points, Abort-
// Controller real stop, prompt assembly from the prompt registry, and the
// per-request snapshot. Context-size POLICY does not live here — the loop
// fires 'loop/turn-start' / 'loop/llm-error' and the compaction plugin acts.
import { reactive, ref, onUnmounted, getCurrentInstance } from 'vue';
import { getService, provideService } from '../kernel/services';
import { bus } from '../kernel/bus';
import { log } from '../kernel/log';
import { usePromptSection } from '../kernel/contrib';
import type { ToolGuardRequest } from '../kernel/bus';
import type { AssistantHarnessMessage, HarnessMessage, JsonObject } from '../shared/runtime';
import { errorMessage } from '../shared/runtime';

// Failsafe kill switch ONLY, not a control mechanism: Stop aborts for real,
// and the compaction plugin keeps context bounded. This exists so a wedged
// engine/tool pair can't spin forever.
const HARD_TURN_LIMIT = 500;
const TOOL_RESULT_LIMIT = 8000; // chars; unbounded tool output would blow up the context
function tryParse(source: string): JsonObject {
  try {
    const value = JSON.parse(source) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
  } catch { return {}; }
}

export const loopPlugin = {
  name: 'loop',
  setup() {
    // Composable face of the contribution API (logic-only plugin, no template):
    // same name-keyed collector as <PromptSection>, same auto-disposal.
    usePromptSection({
      name: 'persona', order: 0,
      text: 'You are a coding agent running inside a browser page, operating a persistent virtual filesystem (OPFS) through tools. Use only the tools you have; do not ask for capabilities you lack. When the task is done, summarize what you did in one or two sentences.',
    });

    const messages = reactive<HarnessMessage[]>([]);
    const running = ref(false);
    let ctrl: AbortController | null = null;

    const note = (text: string): void => { messages.push({ role: 'note', text }); };

    provideService('loop', {
      messages, running,
      stop: () => { ctrl?.abort(); },
      reset() { messages.splice(0); },
      async run(goal: string) {
        if (running.value) { note('a task is already running — stop it first'); return; } // re-entry guard: two loops would fight over ctrl
        const llm = getService('llm');
        const toolsSvc = getService('tools');
        const promptSvc = getService('prompt');
        if (!llm || !toolsSvc) { note('llm / tools service not ready'); return; }
        const fs = getService('fs');
        if (fs?.ready) await fs.ready;
        messages.push({ role: 'user', text: goal });
        running.value = true;
        const controller = new AbortController();
        ctrl = controller;
        try {
          let recovered = false; // one recovery retry per run, granted via loop/llm-error
          for (let turn = 0; turn < HARD_TURN_LIMIT; turn++) {
            if (controller.signal.aborted) { note('stopped'); return; }
            // interception point: plugins act on the canonical log between
            // turns — compaction splices old messages into a summary here,
            // BEFORE the streaming placeholder is pushed and the request built.
            await bus.waterfall('loop/turn-start', { messages, signal: controller.signal });
            if (controller.signal.aborted) { note('stopped'); return; }
            const msg = reactive<AssistantHarnessMessage>({ role: 'assistant', text: '', thinking: '', toolCalls: [], status: 'streaming' });
            messages.push(msg);

            // Per-request snapshot: freeze the assembled prompt AND the tool
            // dispatch table now. The model answers against exactly this
            // request; an HMR reload or v-if removing a tool mid-turn must
            // not race the model's selection of it.
            const toolsSnap = toolsSvc.snapshot();
            const req = await bus.waterfall('llm/request', { // interception point: plugins may rewrite the request
              systemPrompt: promptSvc ? promptSvc.assemble({ fs }) : 'You are a coding agent running in a browser.',
              // invariant: notes and still-streaming/error partials never reach
              // the model; user/assistant/summary (compaction checkpoints) do
              messages: messages.filter(message => message.role !== 'note'
                && (message.role !== 'assistant' || (message.status !== 'streaming' && message.status !== 'error'))),
              tools: toolsSnap.schemas,
              signal: controller.signal,
            });

            let errMsg = null;
            for await (const ev of llm.stream(req)) {
              if (ev.type === 'update' || ev.type === 'done') {
                msg.text = ev.text; msg.thinking = ev.thinking;
                msg.toolCalls = ev.toolCalls.map((call, index) => ({
                  ...call,
                  ...(msg.toolCalls[index]?.result ? { result: msg.toolCalls[index]!.result } : {}),
                  status: msg.toolCalls[index]?.status ?? 'pending',
                }));
                if (ev.type === 'done' && ev.usage) msg.usage = ev.usage; // provider-reported context size, read by compaction
              } else if (ev.type === 'error') {
                msg.status = 'error';
                errMsg = ev.message || 'unknown LLM error';
              }
            }
            if (errMsg != null) {
              // interception point: plugins may recover (compaction handles
              // context-overflow errors) by setting retry — one grant per run.
              const rec = await bus.waterfall('loop/llm-error', { message: errMsg, messages, signal: controller.signal, retry: false });
              if (rec.retry && !recovered && !controller.signal.aborted) { recovered = true; turn--; note('retrying after recovery'); continue; }
              const hint = /fetch/i.test(errMsg) ? ' (network/CORS? browsers block direct third-party API calls — use the /proxy route, see serve.mjs)' : '';
              note(`LLM call failed: ${errMsg}${hint}`);
              return;
            }
            msg.status = 'done';
            if (controller.signal.aborted) { note('stopped'); return; }
            if (!msg.toolCalls.length) return; // no tool calls = task finished

            for (const tc of msg.toolCalls) {
              if (controller.signal.aborted) { note('stopped'); return; }
              tc.status = 'running';
              const pre = await bus.waterfall<ToolGuardRequest>('tools/pre-execute', { name: tc.name, args: tc.argsObj ?? tryParse(tc.args) }); // interception point: veto seam
              let result;
              if (pre?.veto) result = `Error: tool call vetoed by a plugin: ${pre.veto}`;
              else result = await toolsSnap.call(pre.name, pre.args); // dispatch against the snapshot the model saw
              tc.result = String(result).slice(0, TOOL_RESULT_LIMIT);
              tc.status = 'done';
              await bus.waterfall('tools/post-execute', { name: tc.name, result: tc.result }); // interception point: observe/transform results
            }
          }
          note(`reached the failsafe turn limit (${HARD_TURN_LIMIT}) — stopping what looks like a runaway loop`);
        } catch (error: unknown) {
          const last = messages.at(-1);
          if (last?.role === 'assistant' && last.status === 'streaming') last.status = 'error'; // close the cursor, never leave it blinking
          note(controller.signal.aborted ? 'stopped' : `loop error: ${errorMessage(error)}`);
        } finally { running.value = false; ctrl = null; }
      },
    });
    if (getCurrentInstance()) onUnmounted(() => log('loop plugin unmounted', 'warn'));
    return () => null;
  },
};

export default loopPlugin;
