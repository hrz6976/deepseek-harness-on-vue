import type { HarnessMessage, JsonObject, JsonValue } from './runtime';

export type TaskStatus = 'idle' | 'running' | 'waiting' | 'failed' | 'completed';
export type ContextKind = 'page' | 'file' | 'selection' | 'mcp';
export type ArtifactKind = 'change-set' | 'file' | 'site-skill' | 'workflow' | 'dynamic-ui' | 'dataset' | 'report' | 'capability';
export type ArtifactStatus = 'draft' | 'ready' | 'verified' | 'failed' | 'archived';
export type ReasoningEffort = 'low' | 'high' | 'max';

export interface SessionLlmConfig {
  model: string;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
}

export const DEFAULT_SESSION_LLM_CONFIG: Readonly<SessionLlmConfig> = Object.freeze({
  model: 'deepseek-v4-flash',
  thinking: true,
  reasoningEffort: 'high',
});

export function normalizeSessionLlmConfig(value?: Partial<SessionLlmConfig> | null): SessionLlmConfig {
  const effort = value?.reasoningEffort;
  return {
    model: value?.model?.trim() || DEFAULT_SESSION_LLM_CONFIG.model,
    thinking: value?.thinking ?? DEFAULT_SESSION_LLM_CONFIG.thinking,
    reasoningEffort: effort === 'low' || effort === 'high' || effort === 'max'
      ? effort : DEFAULT_SESSION_LLM_CONFIG.reasoningEffort,
  };
}

export interface TaskSession {
  id: string;
  title: string;
  status: TaskStatus;
  llm: SessionLlmConfig;
  capabilityIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskContext {
  id: string;
  taskId: string;
  kind: ContextKind;
  title: string;
  locator: string;
  mimeType?: string;
  metadata: JsonObject;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactVerification {
  status: 'unverified' | 'passed' | 'failed';
  checkedAt?: number;
  summary?: string;
}

export interface HarnessArtifact {
  id: string;
  taskId: string;
  kind: ArtifactKind;
  title: string;
  version: number;
  status: ArtifactStatus;
  source: { type: 'agent' | 'user' | 'capability' | 'provider'; id?: string };
  contentPath?: string;
  content?: JsonValue;
  verification: ArtifactVerification;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  sequence: number;
  type: string;
  timestamp: number;
  data: JsonValue;
}

export interface TaskCheckpoint {
  taskId: string;
  messages: HarnessMessage[];
  savedAt: number;
}

export interface TaskStoreSnapshot {
  activeTaskId: string | null;
  tasks: TaskSession[];
  contexts: TaskContext[];
  artifacts: HarnessArtifact[];
}
