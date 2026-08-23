import type { Component, Ref } from 'vue';
import type { output, ZodType } from 'zod';
import type { CapabilityManifest, CapabilityRequest } from './capability-protocol';
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis';
export type { Plugin } from '@deepseek-ai/cordis';
import type {
  HarnessArtifact,
  TaskContext,
  TaskEvent,
  TaskSession,
  TaskStatus,
} from './task-model';

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
  responseId?: string;
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  status: 'streaming' | 'done' | 'incomplete' | 'error';
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'insufficient_system_resource' | 'unknown';
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
  | {
      type: 'update' | 'done';
      responseId?: string;
      text: string;
      thinking: string;
      toolCalls: ToolCall[];
      finishReason?: AssistantHarnessMessage['finishReason'];
      usage?: TokenUsage;
    }
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

export interface ToolDefinition<Parameters extends ZodType = ZodType> {
  description: string;
  parameters: Parameters;
  availability?: ToolAvailability;
  run(args: output<Parameters>): unknown | Promise<unknown>;
}

export interface NamedToolDefinition<Parameters extends ZodType = ZodType> extends ToolDefinition<Parameters> {
  name: string;
}

export interface NamedSchemaToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  availability?: ToolAvailability;
  run(args: JsonObject): unknown | Promise<unknown>;
}

export interface ToolAvailability {
  id: string;
  title: string;
  description: string;
  scope: 'task' | 'workspace' | 'site' | 'global';
  tags?: readonly string[];
}

export interface ToolCatalogEntry extends Omit<ToolAvailability, 'tags'> {
  tags?: string[];
  tools: string[];
  loaded: boolean;
}

export interface ToolsSnapshot {
  schemas: ToolSchema[];
  call(name: string, args: JsonObject): Promise<unknown>;
}

export interface ToolsService {
  register<Parameters extends ZodType>(definition: NamedToolDefinition<Parameters>): () => Promise<void>;
  registerSchema(definition: NamedSchemaToolDefinition): () => Promise<void>;
  schemas(): ToolSchema[];
  call(name: string, args: JsonObject): Promise<unknown>;
  snapshot(): ToolsSnapshot;
  catalog(): ToolCatalogEntry[];
  load(id: string): boolean;
  unload(id: string): boolean;
}

export interface FsService {
  ready: Promise<void>;
  read(path: string): string | null;
  list(): string[];
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  refresh?(): Promise<void>;
}

export interface PromptService {
  register(definition: PromptSectionDefinition): () => Promise<void>;
  assemble(context?: { fs?: FsService | null }): string;
}

export interface UiContribution {
  name: string;
  component: Component;
  props?: Record<string, unknown> | null;
  region?: string;
  order?: number;
}

export interface UiService {
  register(definition: UiContribution): () => Promise<void>;
  listState(): Array<{ name: string; keys: string[] }>;
  readState(name: string): unknown | null;
}

export interface LoopService {
  running: Ref<boolean>;
  stop(): void;
  run(goal: string): Promise<void>;
}

export interface ManagerService {
  catalog(): CapabilityCatalogEntry[];
  create(name: string, source: string, manifest?: CapabilityManifest): Promise<string>;
  mount(name: string, config?: Record<string, unknown> | null): Promise<string>;
  unmount(name: string): Promise<string>;
  remove(name: string): Promise<string>;
}

export interface CapabilityCatalogEntry {
  id: string;
  title: string;
  description: string;
  scope: 'task' | 'workspace' | 'site' | 'global';
  version: string;
  status: PluginEntry['status'];
  attached: boolean;
  providers: string[];
  permissions: string[];
  contributes: CapabilityContributionInventory;
  health: 'healthy' | 'degraded' | 'failed';
  issues: string[];
}

export interface CompactionService {
  settings: Record<string, unknown>;
  compact(): Promise<boolean>;
  compacting: Ref<boolean>;
  contextTokens(messages: HarnessMessage[]): number;
  contextWindow(): number;
}

export interface TaskRuntimeService {
  ready: Promise<void>;
  messages: HarnessMessage[];
  refresh(): Promise<void>;
  tasks: TaskSession[];
  contexts: TaskContext[];
  artifacts: HarnessArtifact[];
  activeTaskId: Ref<string | null>;
  activeTask(): TaskSession | null;
  scope(): Context;
  createTask(title?: string): Promise<TaskSession>;
  activateTask(id: string): Promise<TaskSession>;
  deleteTask(id: string): Promise<void>;
  renameTask(id: string, title: string): Promise<void>;
  setStatus(id: string, status: TaskStatus): Promise<void>;
  addContext(input: Pick<TaskContext, 'kind' | 'title' | 'locator'> & Partial<Pick<TaskContext, 'mimeType' | 'metadata'>>): Promise<TaskContext>;
  removeContext(id: string): Promise<void>;
  attachCapability(id: string): Promise<void>;
  detachCapability(id: string): Promise<void>;
  createArtifact(input: Pick<HarnessArtifact, 'kind' | 'title' | 'source'> & Partial<Pick<HarnessArtifact, 'status' | 'contentPath' | 'content' | 'verification'>>): Promise<HarnessArtifact>;
  updateArtifact(id: string, patch: Partial<Pick<HarnessArtifact, 'title' | 'status' | 'contentPath' | 'content' | 'verification'>>): Promise<HarnessArtifact>;
  appendEvent(type: string, data?: JsonValue): Promise<TaskEvent>;
  saveCheckpoint(messages?: readonly HarnessMessage[]): Promise<void>;
}

export interface BrokerService {
  request(request: CapabilityRequest): Promise<JsonValue>;
  stream(request: CapabilityRequest): AsyncIterable<JsonValue>;
}

export interface ServiceTypes {
  fs: FsService;
  llm: LlmService;
  tools: ToolsService;
  prompt: PromptService;
  ui: UiService;
  loop: LoopService;
  manager: ManagerService;
  broker: BrokerService;
  compaction: CompactionService;
  task: TaskRuntimeService;
  [name: string]: unknown;
}

export interface PromptSectionDefinition {
  name: string;
  order?: number;
  text: string | (() => string);
}

export interface CapabilityContributionInventory {
  tools: string[];
  panels: string[];
  prompts: string[];
  services: string[];
  events: string[];
  workflows: string[];
}

export interface PluginEntry {
  manifest: CapabilityManifest;
  manifestSource: 'generated' | 'declared';
  contributions: CapabilityContributionInventory;
  plugin: Plugin;
  fiber: Fiber | null;
  version: number;
  readonly status: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | 'disposed';
  error: string;
  hmrError: string;
  config: Record<string, unknown> | null;
}

export interface PluginDefault {
  source: string;
  autoMount?: boolean;
  manifest?: CapabilityManifest;
}

export type PluginDefaults = Record<string, PluginDefault>;

export interface HarnessRuntimeGlobal {
  modules: Readonly<Record<string, unknown>>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toJsonValue(value: unknown): JsonValue {
  return value === undefined ? null : JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function parseJsonObject(source: string): JsonObject {
  try {
    const value = JSON.parse(source) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
  } catch { return {}; }
}
