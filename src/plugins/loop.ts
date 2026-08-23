// loop plugin: the agent loop. Streaming consumption, unbounded tool rounds
// (with a high failsafe), the five waterfall interception points, Abort-
// Controller real stop, prompt assembly from the prompt registry, and the
// per-request snapshot. Context-size POLICY does not live here — the loop
// fires 'loop/turn-start' / 'loop/llm-error' and the compaction plugin acts.
import type { Context } from '@deepseek-ai/cordis';
import { reactive, ref } from 'vue';
import { errorMessage, log, parseJsonObject } from '@/sdk';
import type { ToolGuardRequest } from '@/kernel/bus';
import type { AssistantHarnessMessage, HarnessMessage, JsonObject, LlmRequest, LlmStreamEvent } from '@/shared/runtime';

// Failsafe kill switch ONLY, not a control mechanism: Stop aborts for real,
// and the compaction plugin keeps context bounded. This exists so a wedged
// engine/tool pair can't spin forever.
const HARD_TURN_LIMIT = 500;
const TOOL_RESULT_LIMIT = 8000; // chars; unbounded tool output would blow up the context
const STREAM_RENDER_INTERVAL_MS = 50;
const MAX_TRUNCATION_CONTINUATIONS = 3;
const CONTINUATION_DIRECTIVE = '[Harness continuation] The previous assistant response was truncated by the model output limit. Continue the same work from where it stopped without repeating the partial response. If an action is needed, call the tool now; otherwise provide the actual final answer.';
type AssistantSnapshot = Extract<LlmStreamEvent, { type: 'update' | 'done' }>;
type TurnOutcome = 'completed' | 'tool-calls' | 'incomplete' | 'protocol-error' | 'filtered' | 'resource-error' | 'llm-error' | 'aborted';
type SafePointReason = 'recovery-retry' | 'truncation-continuation' | 'tool-calls-complete';
const name = 'loop';
const inject = ['tools', 'prompt', 'fs', 'task'];

function apply(ctx: Context): void {
    // Logic contribution: the prompt registration belongs to this Fiber and
    // vanishes automatically when the loop plugin unloads.
    ctx.prompt.register({
      name: 'persona', order: 0,
      text: 'You are a coding agent running inside a browser page, operating a persistent virtual filesystem (OPFS) through tools. Use only the tools you have; do not ask for capabilities you lack. If inspection, change, construction, verification, or continuation is needed, call the tool in the same response instead of narrating a future action. When the work is complete or user input is required, return the actual answer or exact question directly. Do not claim work completed unless tool results prove it.',
    });

    const task = ctx.task;
    const messages = task.messages;
    const running = ref(false);
    let ctrl: AbortController | null = null;

    const note = (text: string): void => { messages.push({ role: 'note', text }); };
    const recordTaskEvent = async (type: string, data: JsonObject): Promise<void> => {
      try {
        if (task.activeTask()) await task.appendEvent(type, data);
      } catch (error) {
        // Audit persistence must never prevent the actual tool call.
        log(`task event ${type} was not persisted: ${errorMessage(error)}`, 'warn');
      }
    };
    const recordTurnEnd = async (turn: number, message: AssistantHarnessMessage, outcome: TurnOutcome, toolCallCount = message.toolCalls.length): Promise<void> => {
      await recordTaskEvent('turn/end', {
        turn,
        responseId: message.responseId ?? null,
        finishReason: normalizedFinishReason(message),
        outcome,
        toolCallCount,
        usage: message.usage ? JSON.parse(JSON.stringify(message.usage)) as JsonObject : null,
      });
    };
    const safePoint = (turn: number, reason: SafePointReason) =>
      ctx.parallel('loop/safe-point', { turn, reason });

    ctx.provide('loop', {
      running,
      stop: () => { ctrl?.abort(); },
      async run(goal: string) {
        if (running.value) { note('a task is already running — stop it first'); return; } // re-entry guard: two loops would fight over ctrl
        if (!ctx.reflect.get('llm')) { note('llm service not ready'); return; }
        await task.ready;
        messages.push({ role: 'user', text: goal });
        running.value = true;
        const controller = new AbortController();
        ctrl = controller;
        try {
          await ctx.parallel('loop/busy');
          let recovered = false; // one recovery retry per run, granted via loop/llm-error
          let truncationContinuations = 0;
          let pendingDirective: string | null = null;
          for (let turn = 0; turn < HARD_TURN_LIMIT; turn++) {
            if (controller.signal.aborted) { note('stopped'); return; }
            // Providers may be replaced transactionally at the previous safe
            // point. Never retain a disposed service object across turns.
            const llm = ctx.reflect.get('llm') as import('../shared/runtime').LlmService | undefined;
            if (!llm) { note('llm service not ready'); return; }
            // interception point: plugins act on the canonical log between
            // turns — compaction splices old messages into a summary here,
            // BEFORE the streaming placeholder is pushed and the request built.
            await ctx.waterfall('loop/turn-start', { messages, signal: controller.signal }, (value: { messages: HarnessMessage[]; signal: AbortSignal }) => value);
            if (controller.signal.aborted) { note('stopped'); return; }
            const msg = reactive<AssistantHarnessMessage>({ role: 'assistant', text: '', thinking: '', toolCalls: [], status: 'streaming' });
            messages.push(msg);

            // Per-request snapshot: freeze the assembled prompt AND the tool
            // dispatch table now. The model answers against exactly this
            // request; an HMR reload or v-if removing a tool mid-turn must
            // not race the model's selection of it.
            const toolsSnap = ctx.tools.snapshot();
            const requestMessages = messages.filter(message => message.role !== 'note'
              && (message.role !== 'assistant' || message.status === 'done'));
            if (pendingDirective) requestMessages.push({ role: 'user', text: pendingDirective });
            pendingDirective = null;
            const req = await ctx.waterfall('llm/request', { // interception point: plugins may rewrite the request
              systemPrompt: ctx.prompt.assemble(),
              // invariant: only completed assistant turns reach the canonical
              // history. Incomplete/error/streaming turns are protocol state,
              // not model conversation history.
              messages: requestMessages,
              tools: toolsSnap.schemas,
              signal: controller.signal,
            }, (value: LlmRequest) => value);

            let errMsg = null;
            const snapshots = createSnapshotBuffer(snapshot => applySnapshot(msg, snapshot));
            try {
              for await (const ev of llm.stream(req)) {
                if (ev.type === 'update' || ev.type === 'done') {
                  snapshots.push(ev);
                } else if (ev.type === 'error') {
                  msg.status = 'error';
                  errMsg = ev.message || 'unknown LLM error';
                }
              }
            } finally {
              snapshots.flush();
            }
            if (errMsg != null) {
              await recordTurnEnd(turn + 1, msg, 'llm-error');
              // interception point: plugins may recover (compaction handles
              // context-overflow errors) by setting retry — one grant per run.
              const rec = await ctx.waterfall('loop/llm-error', { message: errMsg, messages, signal: controller.signal, retry: false }, (value: { message: string; messages: HarnessMessage[]; signal: AbortSignal; retry: boolean }) => value);
              if (rec.retry && !recovered && !controller.signal.aborted) {
                recovered = true;
                note('retrying after recovery');
                await safePoint(turn + 1, 'recovery-retry');
                turn--;
                continue;
              }
              const hint = /fetch/i.test(errMsg) ? ' (network/CORS? browsers block direct third-party API calls — use the /proxy route, see serve.mjs)' : '';
              note(`LLM call failed: ${errMsg}${hint}`);
              return;
            }
            const finishReason = normalizedFinishReason(msg);
            const toolCallCount = msg.toolCalls.length;
            if (controller.signal.aborted) {
              msg.status = 'incomplete';
              await recordTurnEnd(turn + 1, msg, 'aborted', toolCallCount);
              note('stopped');
              return;
            }

            if (finishReason === 'length') {
              // A truncated tool call can have valid-looking JSON while still
              // being incomplete. Discard every call from this turn and never
              // execute or checkpoint the partial response.
              msg.status = 'incomplete';
              msg.toolCalls = [];
              await recordTurnEnd(turn + 1, msg, 'incomplete', toolCallCount);
              if (truncationContinuations >= MAX_TRUNCATION_CONTINUATIONS) {
                note(`LLM output remained incomplete after ${MAX_TRUNCATION_CONTINUATIONS} automatic continuations. Increase the model output limit or shorten the task.`);
                return;
              }
              truncationContinuations++;
              pendingDirective = CONTINUATION_DIRECTIVE;
              await safePoint(turn + 1, 'truncation-continuation');
              continue;
            }

            if ((finishReason === 'tool_calls' && toolCallCount === 0)
              || (toolCallCount > 0 && msg.toolCalls.some(call => !isValidToolCall(call)))) {
              msg.status = 'error';
              await recordTurnEnd(turn + 1, msg, 'protocol-error', toolCallCount);
              note('LLM protocol error: the response declared or contained tool calls, but no complete valid call was available.');
              return;
            }
            if (finishReason === 'content_filter') {
              msg.status = 'error';
              await recordTurnEnd(turn + 1, msg, 'filtered', toolCallCount);
              note('LLM response was stopped by the provider content filter.');
              return;
            }
            if (finishReason === 'insufficient_system_resource') {
              msg.status = 'error';
              await recordTurnEnd(turn + 1, msg, 'resource-error', toolCallCount);
              note('LLM provider stopped the response because system resources were insufficient. Please retry.');
              return;
            }

            if (!toolCallCount) {
              if (finishReason === 'stop') {
                if (!msg.text.trim()) {
                  msg.status = 'error';
                  await recordTurnEnd(turn + 1, msg, 'protocol-error', toolCallCount);
                  note('LLM returned an empty final response.');
                  return;
                }
                msg.status = 'done';
                await recordTurnEnd(turn + 1, msg, 'completed', toolCallCount);
                return;
              }
              msg.status = 'error';
              await recordTurnEnd(turn + 1, msg, 'protocol-error', toolCallCount);
              note(`LLM protocol error: unhandled finish reason ${finishReason}.`);
              return;
            }

            msg.status = 'done';
            await recordTurnEnd(turn + 1, msg, 'tool-calls', toolCallCount);

            for (const tc of msg.toolCalls) {
              if (controller.signal.aborted) { note('stopped'); return; }
              tc.status = 'running';
              const pre = await ctx.waterfall('tools/pre-execute', { name: tc.name, args: tc.argsObj ?? parseJsonObject(tc.args) } as ToolGuardRequest, (value: ToolGuardRequest) => value); // interception point: veto seam
              await recordTaskEvent('tool/call-started', {
                callId: tc.id,
                name: pre.name,
                args: pre.args,
              });
              let result;
              if (pre?.veto) result = `Error: tool call vetoed by a plugin: ${pre.veto}`;
              else result = await toolsSnap.call(pre.name, pre.args); // dispatch against the snapshot the model saw
              tc.result = String(result).slice(0, TOOL_RESULT_LIMIT);
              tc.status = 'done';
              await recordTaskEvent('tool/call-completed', {
                callId: tc.id,
                name: pre.name,
                outcome: tc.result.startsWith('Error:') ? 'failed' : 'completed',
                result: tc.result,
              });
              await ctx.waterfall('tools/post-execute', { name: tc.name, result: tc.result, args: pre.args }, (value: { name: string; result: string; args: JsonObject }) => value); // interception point: observe/transform results
            }
            // All calls selected from this request's frozen tool table, plus
            // their pre/post hooks, have settled. Capability HMR may now swap
            // contributors without changing the task, broker, or loop Fiber;
            // the next iteration takes a fresh tool and hook generation.
            await safePoint(turn + 1, 'tool-calls-complete');
          }
          note(`reached the failsafe turn limit (${HARD_TURN_LIMIT}) — stopping what looks like a runaway loop`);
        } catch (error: unknown) {
          const last = messages.at(-1);
          if (last?.role === 'assistant' && last.status === 'streaming') last.status = 'error'; // close the cursor, never leave it blinking
          note(controller.signal.aborted ? 'stopped' : `loop error: ${errorMessage(error)}`);
        } finally { running.value = false; ctrl = null; await ctx.parallel('loop/idle'); }
      },
    });
    ctx.effect(() => () => { ctrl?.abort(); log('loop plugin unmounted', 'warn'); }, 'loop.dispose');
}

function normalizedFinishReason(message: AssistantHarnessMessage): NonNullable<AssistantHarnessMessage['finishReason']> {
  return message.finishReason ?? (message.toolCalls.length ? 'tool_calls' : 'unknown');
}

function isValidToolCall(call: AssistantHarnessMessage['toolCalls'][number]): boolean {
  if (!call.id.trim() || !call.name.trim()) return false;
  try {
    const args = JSON.parse(call.args || JSON.stringify(call.argsObj ?? {})) as unknown;
    return Boolean(args && typeof args === 'object' && !Array.isArray(args));
  } catch {
    return false;
  }
}

export const loopPlugin = { name, inject, apply };

function applySnapshot(message: AssistantHarnessMessage, snapshot: AssistantSnapshot): void {
  if (snapshot.responseId) message.responseId = snapshot.responseId;
  if (message.text !== snapshot.text) message.text = snapshot.text;
  if (message.thinking !== snapshot.thinking) message.thinking = snapshot.thinking;
  const previousById = new Map(message.toolCalls.filter(call => call.id).map(call => [call.id, call]));
  message.toolCalls = snapshot.toolCalls.map((call, index) => ({
    ...call,
    ...((previousById.get(call.id) ?? message.toolCalls[index])?.result
      ? { result: (previousById.get(call.id) ?? message.toolCalls[index])!.result }
      : {}),
    status: (previousById.get(call.id) ?? message.toolCalls[index])?.status ?? 'pending',
  }));
  if (snapshot.finishReason) message.finishReason = snapshot.finishReason;
  if (snapshot.type === 'done' && snapshot.usage) message.usage = snapshot.usage;
}

export function createSnapshotBuffer(commit: (snapshot: AssistantSnapshot) => void) {
  let pending: AssistantSnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const snapshot = pending;
    pending = null;
    commit(snapshot);
  };
  return {
    push(snapshot: AssistantSnapshot) {
      pending = snapshot;
      if (snapshot.type === 'done') return flush();
      timer ??= setTimeout(flush, STREAM_RENDER_INTERVAL_MS);
    },
    flush,
  };
}
