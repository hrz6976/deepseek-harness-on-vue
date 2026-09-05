import type { AssistantHarnessMessage, LlmStreamEvent } from '@/shared/runtime';
const STREAM_RENDER_INTERVAL_MS = 50;
type AssistantSnapshot = Extract<LlmStreamEvent, { type: 'update' | 'done' }>;
export function applySnapshot(message: AssistantHarnessMessage, snapshot: AssistantSnapshot): void {
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
