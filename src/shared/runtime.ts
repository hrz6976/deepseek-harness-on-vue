import type { Component, ComputedRef, Ref, ShallowRef } from 'vue';
import type { BrokerRequest } from './page-protocol';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export interface JsonSchema {
  type?: string;
  description?: string;
  enum?: JsonValue[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  args: string;
  argsObj?: JsonObject;
  result?: string;
  status?: 'pending' | 'running' | 'done';
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface UserMessage { role: 'user'; text: string }
export interface NoteMessage { role: 'note'; text: string }
export interface SummaryMessage { role: 'summary'; text: string; tokensBefore?: number }
export interface AssistantHarnessMessage {
  role: 'assistant';
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  status: 'streaming' | 'done' | 'error';
  usage?: TokenUsage;
}
export type HarnessMessage = UserMessage | NoteMessage | SummaryMessage | AssistantHarnessMessage;

export interface LlmRequest {
  systemPrompt: string;
  messages: HarnessMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
}

export type LlmStreamEvent =
  | { type: 'update' | 'done'; text: string; thinking: string; toolCalls: ToolCall[]; usage?: TokenUsage }
  | { type: 'error'; message: string };

export interface LlmService {
  engineName: Ref<string>;
  contextWindow: number;
  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolDefinition<Args extends JsonObject = JsonObject> {
  description: string;
  parameters: JsonSchema;
  run(args: Args): unknown | Promise<unknown>;
}

export interface NamedToolDefinition<Args extends JsonObject = JsonObject> extends ToolDefinition<Args> {
  name: string;
}

export interface ToolsSnapshot {
  schemas: ToolSchema[];
  call(name: string, args: JsonObject): Promise<unknown>;
}

export interface ToolsService {
  schemas(): ToolSchema[];
  call(name: string, args: JsonObject): Promise<unknown>;
  snapshot(): ToolsSnapshot;
}

export interface FsService {
  files: Map<string, string>;
  ready: Promise<void>;
  read(path: string): string | null;
  list(): string[];
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  clear?(): Promise<void>;
}

export interface PromptService {
  assemble(context?: { fs?: FsService | null }): string;
}

export interface LoopService {
  messages: HarnessMessage[];
  running: Ref<boolean>;
  stop(): void;
  reset(): void;
  run(goal: string): Promise<void>;
}

export interface ManagerService {
  list(): string[];
  create(name: string, source: string): Promise<string>;
  mount(name: string, config?: Record<string, unknown> | null): Promise<string>;
  unmount(name: string): string;
  remove(name: string): Promise<string>;
}

export interface StateService {
  list(): Array<{ name: string; keys: string[] }>;
  read(name: string): string;
}

export interface CompactionService {
  settings: Record<string, unknown>;
  compact(): Promise<boolean>;
  compacting: Ref<boolean>;
  contextTokens(messages: HarnessMessage[]): number;
  contextWindow(): number;
}

export interface BrokerService {
  request(request: BrokerRequest): Promise<JsonValue>;
  stream(request: BrokerRequest): AsyncIterable<JsonValue>;
}

export interface LayoutService {
  regions: Map<string, Element>;
  target(name: string): Element | null;
}

export interface ServiceTypes {
  fs: FsService;
  llm: LlmService;
  tools: ToolsService;
  prompt: PromptService;
  loop: LoopService;
  manager: ManagerService;
  state: StateService;
  layout: LayoutService;
  broker: BrokerService;
  compaction: CompactionService;
  [name: string]: unknown;
}

export type ServiceName = keyof ServiceTypes & string;
export type ServiceSlot<T = unknown> = ShallowRef<T>;

export interface PromptSectionDefinition {
  name: string;
  order?: number;
  text: string | (() => string);
}

export interface PluginEntry {
  name: string;
  def: Component;
  version: number;
  status: 'active' | 'failed';
  error: string;
  hmrError: string;
  builtin: boolean;
  config: Record<string, unknown> | null;
}

export interface PluginDefault {
  source: string;
  autoMount?: boolean;
}

export type PluginDefaults = Record<string, PluginDefault>;

export interface HarnessRuntimeGlobal {
  Vue: typeof import('vue');
  services: Map<string, ServiceSlot>;
  bus: unknown;
  log: unknown;
  modules: Readonly<Record<string, unknown>>;
  useService(name: string): ComputedRef<unknown>;
  [key: string]: unknown;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
