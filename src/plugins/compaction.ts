// compaction plugin: keeps the conversation inside the model's context
// window. All POLICY lives here — the loop only exposes two generic
// interception points ('loop/turn-start' before each request is assembled,
// 'loop/llm-error' after a failed stream) and hands over its canonical
// messages array; this plugin decides when and how to shrink it.
//
// The recipe is pi-coding-agent's, simplified for our flat message model:
//   - context size = last provider-reported usage + chars/4 for what follows
//   - trigger when size > contextWindow - reserveTokens (pi default 16384)
//   - keep the most recent ~keepRecentTokens (pi default 20000), summarize
//     everything older with ONE tool-less llm.stream() call into a structured
//     checkpoint, and splice it in as a single { role: 'summary' } message
//   - a provider "context length exceeded" error triggers the same compaction
//     plus a one-shot retry (detected with pi-ai's isContextOverflow patterns)
// pi additionally splits oversized turns and merges via a separate UPDATE
// prompt; we don't need the former (tool calls and their results live INSIDE
// each assistant message, so every top-level boundary is a valid cut) and we
// fold the latter into the single prompt (an old checkpoint rides along in
// the serialized transcript and the prompt says to merge it).
import type { Context } from '@deepseek-ai/cordis';
import { reactive, ref } from 'vue';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { errorMessage, log } from '@/sdk';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { HarnessMessage, LlmRequest, LlmService } from '@/shared/runtime';

export interface CompactionSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
interface TurnStartRequest { messages: HarnessMessage[]; signal: AbortSignal }
interface LlmErrorRequest extends TurnStartRequest { message: string; retry: boolean }

export const DEFAULT_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
const TOOL_RESULT_MAX = 2000; // chars per tool result in the transcript sent to the summarizer
const ARGS_MAX = 300;

// ---- pure helpers (unit-tested in tests/compaction.test.js) -----------------

export function estimateMessageTokens(message: HarnessMessage): number {
  const m = message;
  if (m.role === 'note') return 0;
  let chars = m.text.length + (m.role === 'assistant' ? m.thinking.length : 0);
  if (m.role === 'assistant') {
    for (const tc of m.toolCalls) chars += tc.name.length + tc.args.length + String(tc.result ?? '').length;
  }
  return Math.ceil(chars / 4);
}

// Last reported provider usage is ground truth for everything up to and
// including that assistant message; chars/4 estimates only what came after.
// Before the first response lands this is a pure estimate that ignores the
// system prompt and tool schemas — fine, the threshold only matters once
// real usage numbers exist.
export function estimateContextTokens(messages: HarnessMessage[]): number {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const usage = m.role === 'assistant' ? m.usage : undefined;
    if (m.role === 'assistant' && m.status === 'done' && usage && (usage.totalTokens || usage.input)) { last = i; break; }
  }
  let tokens = 0;
  if (last >= 0) {
    const message = messages[last]!;
    const usage = message.role === 'assistant' ? message.usage : undefined;
    if (usage) tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }
  for (let i = last + 1; i < messages.length; i++) tokens += estimateMessageTokens(messages[i]!);
  return tokens;
}

// Walk backwards accumulating estimated tokens until >= keepRecentTokens;
// the message where we cross the budget is the first KEPT message. Returns 0
// (nothing to compact) when the whole log fits in the budget.
export function findCutIndex(messages: HarnessMessage[], keepRecentTokens: number): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i]!);
    if (acc >= keepRecentTokens) return i;
  }
  return 0;
}

const trunc = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}\n[... ${s.length - n} more characters truncated]`);

// Role-tagged plain text, NOT a message list — the summarizer must see a
// document to describe, never a conversation to continue (pi does the same).
// Thinking is deliberately dropped: bulky, and never part of later context.
export function serializeTranscript(messages: HarnessMessage[]): string {
  const parts = [];
  for (const m of messages) {
    if (m.role === 'summary') parts.push(`[Previous context checkpoint]: ${m.text}`);
    else if (m.role === 'user') parts.push(`[User]: ${m.text}`);
    else if (m.role === 'assistant') {
      if (m.text) parts.push(`[Assistant]: ${m.text}`);
      for (const tc of m.toolCalls ?? []) {
        parts.push(`[Tool call]: ${tc.name}(${trunc(tc.args ?? '{}', ARGS_MAX)})`);
        if (tc.result != null) parts.push(`[Tool result]: ${trunc(String(tc.result), TOOL_RESULT_MAX)}`);
      }
    }
  }
  return parts.join('\n\n');
}

// Prompts adapted from pi-coding-agent's compaction module.
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding agent, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The conversation above is to be summarized into a context checkpoint that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items.]

## Constraints & Preferences
- [Constraints or preferences stated by the user, or "(none)"]

## Progress
### Done
- [x] [Completed tasks/changes]
### In Progress
- [ ] [Current work]
### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Data, file contents, or references needed to continue, or "(none)"]

If a [Previous context checkpoint] appears at the start of the conversation, PRESERVE its still-relevant content and merge the new information into it.
Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// The compaction itself: pick the cut, summarize the prefix, splice.
// Bypasses the 'llm/request' waterfall on purpose — plugins that rewrite
// AGENT requests must not touch the summarizer's request.
export async function runCompaction(
  messages: HarnessMessage[],
  { llm, settings, signal = new AbortController().signal }: { llm: LlmService; settings: CompactionSettings; signal?: AbortSignal },
): Promise<boolean> {
  const cut = findCutIndex(messages, settings.keepRecentTokens);
  const prefix = messages.slice(0, cut);
  if (!prefix.some(m => m.role === 'user' || m.role === 'assistant')) return false; // nothing new to fold in
  const tokensBefore = estimateContextTokens(messages);
  let summary = '';
  const req: LlmRequest = {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', text: `<conversation>\n${serializeTranscript(prefix)}\n</conversation>\n\n${SUMMARIZATION_PROMPT}` }],
    tools: [],
    signal,
  };
  for await (const ev of llm.stream(req)) {
    if (ev.type === 'done') summary = ev.text;
    else if (ev.type === 'error') throw new Error(ev.message);
  }
  if (!summary.trim()) throw new Error('summarizer returned empty text');
  messages.splice(0, cut, { role: 'summary', text: summary, tokensBefore });
  // Provider usage on retained assistant turns was measured against the
  // pre-compaction transcript. Keeping it would make the compacted log appear
  // just as large as before and retrigger compaction on every following turn.
  // The next real model response will establish a fresh provider baseline.
  for (const message of messages) {
    if (message.role === 'assistant') delete message.usage;
  }
  return true;
}

// ---- the plugin -------------------------------------------------------------

export const name = 'compaction';

export function apply(ctx: Context): void {
    const settings = reactive({ ...DEFAULT_SETTINGS });
    const compacting = ref(false);
    const getLlm = () => ctx.reflect.get('llm') as LlmService | undefined;
    const note = (messages: HarnessMessage[], text: string): void => { messages.push({ role: 'note', text }); };

    async function compact(messages: HarnessMessage[], signal = new AbortController().signal): Promise<boolean> {
      const llm = getLlm();
      if (!llm || compacting.value) return false;
      compacting.value = true;
      try {
        const before = estimateContextTokens(messages);
        const did = await runCompaction(messages, { llm, settings, signal });
        if (did) {
          const after = estimateContextTokens(messages);
          note(messages, `上下文已压缩：约 ${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tokens`);
          log(`compaction: ~${before} → ~${after} est. tokens`);
        }
        return did;
      } finally { compacting.value = false; }
    }

    // Auto-trigger between turns, before the loop assembles the next request.
    // Failure falls through uncompacted — worst case the request overflows,
    // which the loop/llm-error hook below then catches.
    ctx.on('loop/turn-start', async (arg: TurnStartRequest, next: (value: TurnStartRequest) => unknown) => {
      const llm = getLlm();
      if (settings.enabled && llm) {
        const window = llm.contextWindow ?? 131072;
        if (estimateContextTokens(arg.messages) > window - settings.reserveTokens) {
          note(arg.messages, '上下文接近上限，正在压缩…');
          try { await compact(arg.messages, arg.signal); }
          catch (error: unknown) { note(arg.messages, `compaction failed: ${errorMessage(error)} — continuing uncompacted`); }
        }
      }
      return next(arg);
    });

    // Provider rejected the request as too long (estimate was off, or another
    // plugin inflated the request): compact and ask the loop for its one retry.
    ctx.on('loop/llm-error', async (arg: LlmErrorRequest, next: (value: LlmErrorRequest) => unknown) => {
      const overflowMessage = { role: 'assistant', stopReason: 'error', errorMessage: arg.message } as unknown as AssistantMessage;
      if (settings.enabled && isContextOverflow(overflowMessage)) {
        try {
          if (await compact(arg.messages, arg.signal)) {
            arg.retry = true;
            return next(arg);
          }
        }
        catch (error: unknown) { log(`compaction after overflow failed: ${errorMessage(error)}`, 'err'); }
      }
      return next(arg);
    });

    ctx.provide('compaction', {
      settings, compacting,
      contextTokens: estimateContextTokens,
      contextWindow: () => getLlm()?.contextWindow ?? 131072,
      // manual "Compact" from the UI; loop must be idle (the button enforces it)
      async compact() {
        const task = ctx.reflect.get('task') as import('../shared/runtime').TaskRuntimeService | undefined;
        if (!task || !getLlm()) return false;
        try { return await compact(task.messages); }
        catch (error: unknown) { note(task.messages, `compaction failed: ${errorMessage(error)}`); return false; }
      },
    });
    ctx.effect(() => () => log('compaction plugin unmounted', 'warn'), 'compaction.log-dispose');
}
