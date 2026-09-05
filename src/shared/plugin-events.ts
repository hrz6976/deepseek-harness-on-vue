import type { HarnessMessage, JsonObject, LlmRequest } from './runtime';
import type { PageEvent } from './page-protocol';

export interface TurnStart { messages: HarnessMessage[]; signal: AbortSignal }
export interface LlmFailure extends TurnStart { message: string; retry: boolean }
export interface ToolInvocation { name: string; args: JsonObject; veto?: string }
export interface ToolResult { name: string; args: JsonObject; result: string }
export type SafePointReason = 'recovery-retry' | 'truncation-continuation' | 'tool-calls-complete';
type Middleware<T> = (value: T, next: (value: T) => T | Promise<T>) => T | Promise<T>;

/** Known lifecycle events are typed; third-party event names remain extensible. */
export interface HarnessEvents {
  'workspace/changed': (path: string, content: string | null) => void;
  'workspace/invalidated': () => void;
  'task/activated': (taskId: string | null) => void;
  'loop/busy': () => void;
  'loop/idle': () => void;
  'loop/safe-point': (point: { turn: number; reason: SafePointReason }) => void;
  'loop/turn-start': Middleware<TurnStart>;
  'loop/llm-error': Middleware<LlmFailure>;
  'llm/request': Middleware<LlmRequest>;
  'tools/pre-execute': Middleware<ToolInvocation>;
  'tools/post-execute': Middleware<ToolResult>;
  'page/event': (event: PageEvent) => void;
}
