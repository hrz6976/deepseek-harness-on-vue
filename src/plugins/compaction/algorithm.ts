import { normalizeSessionLlmConfig, userMessageTextForModel } from '@/sdk';
import type { ModelLimits } from '@/shared/model-limits';
import type { HarnessMessage, LlmRequest, LlmService } from '@/shared/runtime';
import type { SessionLlmConfig } from '@/shared/task-model';
import { SUMMARIZATION_SYSTEM_PROMPT, SUMMARIZATION_PROMPT } from './prompts';

export interface CompactionSettings { enabled: boolean; safetyTokens: number; keepRecentTokens: number }

export const DEFAULT_SETTINGS = { enabled: true, safetyTokens: 32_000, keepRecentTokens: 128_000 };
const TOOL_RESULT_MAX = 2000; // chars per tool result in the transcript sent to the summarizer
const ARGS_MAX = 300;

// ---- pure helpers (unit-tested in tests/compaction.test.js) -----------------

export function estimateMessageTokens(message: HarnessMessage): number {
  const m = message;
  if (m.role === 'note') return 0;
  let chars = (m.role === 'user' ? userMessageTextForModel(m) : m.text).length
    + (m.role === 'assistant' ? m.thinking.length : 0);
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
  for (let i = messages.length - 1;i >= 0;i--) {
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
  for (let i = last + 1;i < messages.length;i++) tokens += estimateMessageTokens(messages[i]!);
  return tokens;
}

// Walk backwards accumulating estimated tokens until >= keepRecentTokens;
// the message where we cross the budget is the first KEPT message. Returns 0
// (nothing to compact) when the whole log fits in the budget.
export function findCutIndex(messages: HarnessMessage[], keepRecentTokens: number): number {
  let acc = 0;
  for (let i = messages.length - 1;i >= 0;i--) {
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
    else if (m.role === 'user') parts.push(`[User]: ${userMessageTextForModel(m)}`);
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
// The compaction itself: pick the cut, summarize the prefix, splice.
// Bypasses the 'llm/request' waterfall on purpose — plugins that rewrite
// AGENT requests must not touch the summarizer's request.
export async function runCompaction(
  messages: HarnessMessage[],
  { llm, settings, signal = new AbortController().signal, sessionConfig }: {
    llm: LlmService;
    settings: CompactionSettings;
    signal?: AbortSignal;
    sessionConfig?: SessionLlmConfig;
  },
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
    sessionConfig: { ...normalizeSessionLlmConfig(sessionConfig), thinking: false },
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

export function compactionThreshold(limits: ModelLimits, safetyTokens: number): number {
  return Math.max(1, limits.contextWindow - limits.requestOutputTokens - Math.max(0, safetyTokens));
}
