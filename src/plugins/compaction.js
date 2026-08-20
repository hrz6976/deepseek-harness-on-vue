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
import { reactive, ref, onUnmounted } from 'vue';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { services, provideService } from '../kernel/services.js';
import { useBusOn } from '../kernel/bus.js';
import { log } from '../kernel/log.js';

export const DEFAULT_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
const TOOL_RESULT_MAX = 2000; // chars per tool result in the transcript sent to the summarizer
const ARGS_MAX = 300;

// ---- pure helpers (unit-tested in tests/compaction.test.js) -----------------

export function estimateMessageTokens(m) {
  if (m.role === 'note') return 0;
  let chars = (m.text || '').length + (m.thinking || '').length;
  for (const tc of m.toolCalls ?? []) chars += (tc.name?.length ?? 0) + (tc.args?.length ?? 0) + (String(tc.result ?? '').length);
  return Math.ceil(chars / 4);
}

// Last reported provider usage is ground truth for everything up to and
// including that assistant message; chars/4 estimates only what came after.
// Before the first response lands this is a pure estimate that ignores the
// system prompt and tool schemas — fine, the threshold only matters once
// real usage numbers exist.
export function estimateContextTokens(messages) {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i], u = m.usage;
    if (m.role === 'assistant' && m.status === 'done' && u && (u.totalTokens || u.input)) { last = i; break; }
  }
  let tokens = 0;
  if (last >= 0) {
    const u = messages[last].usage;
    tokens = u.totalTokens || u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  }
  for (let i = last + 1; i < messages.length; i++) tokens += estimateMessageTokens(messages[i]);
  return tokens;
}

// Walk backwards accumulating estimated tokens until >= keepRecentTokens;
// the message where we cross the budget is the first KEPT message. Returns 0
// (nothing to compact) when the whole log fits in the budget.
export function findCutIndex(messages, keepRecentTokens) {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i]);
    if (acc >= keepRecentTokens) return i;
  }
  return 0;
}

const trunc = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}\n[... ${s.length - n} more characters truncated]`);

// Role-tagged plain text, NOT a message list — the summarizer must see a
// document to describe, never a conversation to continue (pi does the same).
// Thinking is deliberately dropped: bulky, and never part of later context.
export function serializeTranscript(messages) {
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
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding agent, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARIZATION_PROMPT = `The conversation above is to be summarized into a context checkpoint that another LLM will use to continue the work.

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
export async function runCompaction(messages, { llm, settings, signal }) {
  const cut = findCutIndex(messages, settings.keepRecentTokens);
  const prefix = messages.slice(0, cut);
  if (!prefix.some(m => m.role === 'user' || m.role === 'assistant')) return false; // nothing new to fold in
  const tokensBefore = estimateContextTokens(messages);
  let summary = '';
  const req = {
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
  return true;
}

// ---- the plugin -------------------------------------------------------------

export const compactionPlugin = {
  name: 'compaction',
  setup() {
    const settings = reactive({ ...DEFAULT_SETTINGS });
    const compacting = ref(false);
    const getLlm = () => services.get('llm')?.value;
    const note = (messages, text) => messages.push({ role: 'note', text });

    async function compact(messages, signal) {
      const llm = getLlm();
      if (!llm || compacting.value) return false;
      compacting.value = true;
      try {
        const before = estimateContextTokens(messages);
        const did = await runCompaction(messages, { llm, settings, signal });
        if (did) {
          const after = estimateContextTokens(messages);
          note(messages, `context compacted: ~${Math.round(before / 1000)}k → ~${Math.round(after / 1000)}k tokens`);
          log(`compaction: ~${before} → ~${after} est. tokens`);
        }
        return did;
      } finally { compacting.value = false; }
    }

    // Auto-trigger between turns, before the loop assembles the next request.
    // Failure falls through uncompacted — worst case the request overflows,
    // which the loop/llm-error hook below then catches.
    useBusOn('loop/turn-start', async (arg, next) => {
      const llm = getLlm();
      if (settings.enabled && llm) {
        const window = llm.contextWindow ?? 131072;
        if (estimateContextTokens(arg.messages) > window - settings.reserveTokens) {
          note(arg.messages, 'context near the window limit — compacting…');
          try { await compact(arg.messages, arg.signal); }
          catch (e) { note(arg.messages, `compaction failed: ${e.message} — continuing uncompacted`); }
        }
      }
      return next(arg);
    });

    // Provider rejected the request as too long (estimate was off, or another
    // plugin inflated the request): compact and ask the loop for its one retry.
    useBusOn('loop/llm-error', async (arg, next) => {
      if (settings.enabled && isContextOverflow({ role: 'assistant', stopReason: 'error', errorMessage: arg.message })) {
        try { if (await compact(arg.messages, arg.signal)) return next({ ...arg, retry: true }); }
        catch (e) { log(`compaction after overflow failed: ${e.message}`, 'err'); }
      }
      return next(arg);
    });

    provideService('compaction', {
      settings, compacting,
      contextTokens: estimateContextTokens,
      contextWindow: () => getLlm()?.contextWindow ?? 131072,
      // manual "Compact" from the UI; loop must be idle (the button enforces it)
      async compact() {
        const loop = services.get('loop')?.value;
        if (!loop || !getLlm()) return false;
        try { return await compact(loop.messages); }
        catch (e) { note(loop.messages, `compaction failed: ${e.message}`); return false; }
      },
    });
    onUnmounted(() => log('compaction plugin unmounted', 'warn'));
    return () => null;
  },
};

export default compactionPlugin;
