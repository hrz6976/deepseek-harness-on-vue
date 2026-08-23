import type { HarnessMessage, JsonObject, JsonValue } from './runtime';

export type TaskStatus = 'idle' | 'running' | 'waiting' | 'failed' | 'completed';
export type ContextKind = 'page' | 'file' | 'selection' | 'mcp';
export type ArtifactKind = 'change-set' | 'file' | 'site-skill' | 'workflow' | 'dynamic-ui' | 'dataset' | 'report' | 'capability';
export type ArtifactStatus = 'draft' | 'ready' | 'verified' | 'failed' | 'archived';

export interface TaskSession {
  id: string;
  title: string;
  status: TaskStatus;
  contextIds: string[];
  capabilityIds: string[];
  artifactIds: string[];
  checkpointId?: string;
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
  id: string;
  taskId: string;
  messages: HarnessMessage[];
  savedAt: number;
}

export interface TaskStoreSnapshot {
  activeTaskId: string | null;
  tasks: TaskSession[];
  contexts: TaskContext[];
  artifacts: HarnessArtifact[];
  events: TaskEvent[];
}
