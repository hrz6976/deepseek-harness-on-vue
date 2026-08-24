import type { HarnessMessage } from '@/shared/runtime';

/** Keep internal checkpoints hidden while exposing provider stream progress. */
export function shouldDisplayMessage(message: HarnessMessage): boolean {
  // A summary is model context, not a chat turn. It must stay in the
  // canonical transcript without leaking the internal checkpoint into the UI.
  if (message.role === 'summary') return false;
  if (message.role !== 'assistant') return true;
  // A length-truncated response can already contain prose or a partially
  // assembled tool call. Neither is a stable protocol record, so keep the
  // whole turn out of the user-facing feed while the loop continues it.
  if (message.status === 'incomplete') return false;
  // Both provider channels are cumulative stream state. Tool-driving prose is
  // retained beside its eventual tool card instead of disappearing when the
  // call arrives.
  return Boolean(message.thinking.trim() || message.text.trim() || message.toolCalls.length);
}
