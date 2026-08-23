import type { HarnessMessage } from '@/shared/runtime';

/**
 * Tool-driving assistant turns are provisional: while streaming we do not yet
 * know whether the model will finish with a user-facing answer or a tool call.
 * Mounting their text and removing it once a tool call arrives makes the chat
 * flash between unrelated drafts. Tool calls, however, have stable identities
 * and are useful while running, so expose them as activity records as soon as
 * the protocol has produced one.
 */
export function shouldDisplayMessage(message: HarnessMessage): boolean {
  // A summary is model context, not a chat turn. It must stay in the
  // canonical transcript without leaking the internal checkpoint into the UI.
  if (message.role === 'summary') return false;
  if (message.role !== 'assistant') return true;
  // A length-truncated response can already contain prose or a partially
  // assembled tool call. Neither is a stable protocol record, so keep the
  // whole turn out of the user-facing feed while the loop continues it.
  if (message.status === 'incomplete') return false;
  if (message.toolCalls.length > 0) return true;
  if (message.status !== 'done') return false;
  return Boolean(message.text.trim());
}
