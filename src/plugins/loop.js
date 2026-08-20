// loop plugin: the agent loop. Streaming consumption, unbounded tool rounds
// (with a high failsafe), the five waterfall interception points, Abort-
// Controller real stop, prompt assembly from the prompt registry, and the
// per-request snapshot. Context-size POLICY does not live here — the loop
// fires 'loop/turn-start' / 'loop/llm-error' and the compaction plugin acts.
import { reactive, ref, onUnmounted } from 'vue';
import { services, provideService } from '../kernel/services.js';
import { bus } from '../kernel/bus.js';
import { log } from '../kernel/log.js';
import { usePromptSection } from '../kernel/contrib.js';

// Failsafe kill switch ONLY, not a control mechanism: Stop aborts for real,
// and the compaction plugin keeps context bounded. This exists so a wedged
// engine/tool pair can't spin forever.
const HARD_TURN_LIMIT = 500;
const TOOL_RESULT_LIMIT = 8000; // chars; unbounded tool output would blow up the context
function tryParse(s) { try { return JSON.parse(s); } catch { return {}; } }

export const loopPlugin = {
  name: 'loop',
  setup() {
    // Composable face of the contribution API (logic-only plugin, no template):
    // same name-keyed collector as <PromptSection>, same auto-disposal.
    usePromptSection({
      name: 'persona', order: 0,
      text: 'You are a coding agent running inside a browser page, operating a persistent virtual filesystem (OPFS) through tools. Use only the tools you have; do not ask for capabilities you lack. When the task is done, summarize what you did in one or two sentences.',
    });

    const messages = reactive([]);
    const running = ref(false);
    let ctrl = null;

    const note = text => { messages.push({ role: 'note', text }); };

    provideService('loop', {
      messages, running,
      stop: () => { ctrl?.abort(); },
      reset() { messages.splice(0); },
      async run(goal) {
        if (running.value) { note('a task is already running — stop it first'); return; } // re-entry guard: two loops would fight over ctrl
        const llm = services.get('llm')?.value;
        const toolsSvc = services.get('tools')?.value;
        const promptSvc = services.get('prompt')?.value;
        if (!llm || !toolsSvc) { note('llm / tools service not ready'); return; }
        const fs = services.get('fs')?.value;
        if (fs?.ready) await fs.ready;
        messages.push({ role: 'user', text: goal });
        running.value = true;
        ctrl = new AbortController();
        try {
          let recovered = false; // one recovery retry per run, granted via loop/llm-error
          for (let turn = 0; turn < HARD_TURN_LIMIT; turn++) {
            if (ctrl.signal.aborted) { note('stopped'); return; }
            // interception point: plugins act on the canonical log between
            // turns — compaction splices old messages into a summary here,
            // BEFORE the streaming placeholder is pushed and the request built.
            await bus.waterfall('loop/turn-start', { messages, signal: ctrl.signal });
            if (ctrl.signal.aborted) { note('stopped'); return; }
            const msg = reactive({ role: 'assistant', text: '', thinking: '', toolCalls: [], status: 'streaming' });
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
              messages: messages.filter(m => m.role !== 'note' && m.status !== 'streaming' && m.status !== 'error'),
              tools: toolsSnap.schemas,
              signal: ctrl.signal,
            });

            let errMsg = null;
            for await (const ev of llm.stream(req)) {
              if (ev.type === 'update' || ev.type === 'done') {
                msg.text = ev.text; msg.thinking = ev.thinking;
                msg.toolCalls = ev.toolCalls.map((c, i) => ({ ...msg.toolCalls[i], ...c, status: msg.toolCalls[i]?.status ?? 'pending' }));
                if (ev.type === 'done' && ev.usage) msg.usage = ev.usage; // provider-reported context size, read by compaction
              } else if (ev.type === 'error') {
                msg.status = 'error';
                errMsg = ev.message || 'unknown LLM error';
              }
            }
            if (errMsg != null) {
              // interception point: plugins may recover (compaction handles
              // context-overflow errors) by setting retry — one grant per run.
              const rec = await bus.waterfall('loop/llm-error', { message: errMsg, messages, signal: ctrl.signal, retry: false });
              if (rec?.retry && !recovered && !ctrl.signal.aborted) { recovered = true; turn--; note('retrying after recovery'); continue; }
              const hint = /fetch/i.test(errMsg) ? ' (network/CORS? browsers block direct third-party API calls — use the /proxy route, see serve.mjs)' : '';
              note(`LLM call failed: ${errMsg}${hint}`);
              return;
            }
            msg.status = 'done';
            if (ctrl.signal.aborted) { note('stopped'); return; }
            if (!msg.toolCalls.length) return; // no tool calls = task finished

            for (const tc of msg.toolCalls) {
              if (ctrl.signal.aborted) { note('stopped'); return; }
              tc.status = 'running';
              const pre = await bus.waterfall('tools/pre-execute', { name: tc.name, args: tc.argsObj ?? tryParse(tc.args) }); // interception point: veto seam
              let result;
              if (pre?.veto) result = `Error: tool call vetoed by a plugin: ${pre.veto}`;
              else result = await toolsSnap.call(pre.name, pre.args); // dispatch against the snapshot the model saw
              tc.result = String(result).slice(0, TOOL_RESULT_LIMIT);
              tc.status = 'done';
              await bus.waterfall('tools/post-execute', { name: tc.name, result: tc.result }); // interception point: observe/transform results
            }
          }
          note(`reached the failsafe turn limit (${HARD_TURN_LIMIT}) — stopping what looks like a runaway loop`);
        } catch (e) {
          const last = messages.at(-1);
          if (last?.role === 'assistant' && last.status === 'streaming') last.status = 'error'; // close the cursor, never leave it blinking
          note(ctrl.signal.aborted ? 'stopped' : `loop error: ${e.message}`);
        } finally { running.value = false; ctrl = null; }
      },
    });
    onUnmounted(() => log('loop plugin unmounted', 'warn'));
    return () => null;
  },
};
