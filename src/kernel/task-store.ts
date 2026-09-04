import type { FsService, HarnessMessage, JsonValue } from '@/shared/runtime';
import { normalizeSessionLlmConfig, type HarnessArtifact, type SessionLlmConfig, type TaskCheckpoint, type TaskContext, type TaskEvent, type TaskSession, type TaskStatus, type TaskStoreSnapshot } from '@/shared/task-model';

const HARNESS_ROOT = '.harness/';
interface SessionIndex { activeTaskId: string | null; taskIds: string[] }
type ModelSelection = Pick<SessionLlmConfig, 'profileId' | 'model'>;

export class HarnessTaskStore {
  private readonly eventSequences = new Map<string, number>();
  private readonly sessionRoot: string;
  private readonly artifactRoot: string;
  private readonly tombstoneRoot: string;
  private readonly sessionIndex: string;
  private readonly modelSelectionPath = `${HARNESS_ROOT}model.json`;
  private selectedModel: ModelSelection = pickModel(normalizeSessionLlmConfig());

  constructor(
    private readonly fs: FsService,
    private readonly now = () => Date.now(),
    private readonly uuid = () => crypto.randomUUID(),
    scope?: string,
  ) {
    const root = scope ? `${HARNESS_ROOT}hosts/${encodeURIComponent(scope)}/` : HARNESS_ROOT;
    this.sessionRoot = `${root}sessions/`;
    this.artifactRoot = `${root}artifacts/`;
    this.tombstoneRoot = `${root}tombstones/tasks/`;
    this.sessionIndex = `${this.sessionRoot}index.json`;
  }

  async load(): Promise<TaskStoreSnapshot> {
    await this.fs.ready;
    this.eventSequences.clear();
    const index = parseJson<SessionIndex>(this.fs.read(this.sessionIndex), { activeTaskId: null, taskIds: [] });
    const tasks = index.taskIds
      .filter(id => !this.isTaskDeleted(id))
      .map(id => parseJson<TaskSession | null>(this.fs.read(this.metaPath(id)), null))
      .filter((task): task is TaskSession => task !== null);
    for (const task of tasks) task.llm = normalizeSessionLlmConfig(task.llm);
    const storedModel = parseJson<ModelSelection | null>(this.fs.read(this.modelSelectionPath), null);
    const activeModel = tasks.find(task => task.id === index.activeTaskId)?.llm;
    this.selectedModel = pickModel(normalizeSessionLlmConfig(storedModel ?? activeModel));
    for (const task of tasks) task.llm = { ...task.llm, ...this.selectedModel };
    const taskIds = new Set(tasks.map(task => task.id));
    const contexts = tasks.flatMap(task => parseJson<TaskContext[]>(this.fs.read(this.contextsPath(task.id)), []));
    for (const task of tasks) {
      const eventSource = this.fs.read(this.eventsPath(task.id));
      const lastEvent = parseJson<TaskEvent | null>(eventSource?.trimEnd().split('\n').at(-1) ?? null, null);
      if (lastEvent) this.eventSequences.set(task.id, lastEvent.sequence);
    }
    const artifacts = this.fs.list()
      .filter(path => path.startsWith(this.artifactRoot) && path.endsWith('/meta.json'))
      .map(path => parseJson<HarnessArtifact | null>(this.fs.read(path), null))
      .filter((artifact): artifact is HarnessArtifact => artifact !== null && taskIds.has(artifact.taskId) && !this.isTaskDeleted(artifact.taskId));
    return {
      activeTaskId: tasks.some(task => task.id === index.activeTaskId) ? index.activeTaskId : tasks[0]?.id ?? null,
      tasks,
      contexts,
      artifacts,
    };
  }

  newTask(title = 'Untitled task'): TaskSession {
    const timestamp = this.now();
    return {
      id: this.uuid(), title: title.trim() || 'Untitled task', status: 'idle',
      llm: { ...normalizeSessionLlmConfig(), ...this.selectedModel },
      capabilityIds: [],
      createdAt: timestamp, updatedAt: timestamp,
    };
  }

  newContext(taskId: string, input: Pick<TaskContext, 'kind' | 'title' | 'locator'> & Partial<Pick<TaskContext, 'mimeType' | 'metadata'>>): TaskContext {
    const timestamp = this.now();
    return {
      id: this.uuid(), taskId, kind: input.kind, title: input.title.trim() || input.locator,
      locator: input.locator, ...(input.mimeType ? { mimeType: input.mimeType } : {}), metadata: input.metadata ?? {},
      createdAt: timestamp, updatedAt: timestamp,
    };
  }

  newArtifact(taskId: string, input: Pick<HarnessArtifact, 'kind' | 'title' | 'source'> & Partial<Pick<HarnessArtifact, 'status' | 'contentPath' | 'content' | 'verification'>>): HarnessArtifact {
    const timestamp = this.now();
    return {
      id: this.uuid(), taskId, kind: input.kind, title: input.title.trim() || 'Untitled artifact', version: 1,
      status: input.status ?? 'draft', source: input.source,
      ...(input.contentPath ? { contentPath: input.contentPath } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      verification: input.verification ?? { status: 'unverified' },
      createdAt: timestamp, updatedAt: timestamp,
    };
  }

  checkpointMessages(taskId: string | null): HarnessMessage[] {
    if (!taskId) return [];
    const checkpoint = parseJson<TaskCheckpoint | null>(this.fs.read(this.checkpointPath(taskId)), null);
    return checkpoint ? stableCheckpointMessages(checkpoint.messages) : [];
  }

  async persistIndex(activeTaskId: string | null, tasks: TaskSession[]): Promise<void> {
    const visibleTasks = tasks.filter(task => !this.isTaskDeleted(task.id));
    const visibleActiveTaskId = visibleTasks.some(task => task.id === activeTaskId)
      ? activeTaskId
      : visibleTasks[0]?.id ?? null;
    await this.writeJson(this.sessionIndex, { activeTaskId: visibleActiveTaskId, taskIds: visibleTasks.map(task => task.id) });
  }

  async persistTask(task: TaskSession): Promise<void> {
    this.assertTaskWritable(task.id);
    await this.writeJson(this.metaPath(task.id), task);
  }

  setModelSelection(profileId: string, model: string): ModelSelection {
    this.selectedModel = pickModel(normalizeSessionLlmConfig({ profileId, model }));
    return { ...this.selectedModel };
  }

  async persistModelSelection(): Promise<void> {
    await this.writeJson(this.modelSelectionPath, this.selectedModel);
  }

  async persistContexts(taskId: string, contexts: TaskContext[]): Promise<void> {
    this.assertTaskWritable(taskId);
    await this.writeJson(this.contextsPath(taskId), contexts);
  }

  async persistArtifact(artifact: HarnessArtifact): Promise<void> {
    this.assertTaskWritable(artifact.taskId);
    await this.writeJson(this.artifactMetaPath(artifact.id), artifact);
  }

  async deleteTask(taskId: string): Promise<void> {
    if (!this.isTaskDeleted(taskId)) {
      await this.writeJson(this.tombstonePath(taskId), { taskId, deletedAt: this.now() });
    }
    const taskPrefix = `${this.sessionRoot}${taskId}/`;
    const relatedArtifactIds = new Set<string>();
    for (const path of this.fs.list().filter(path => path.startsWith(this.artifactRoot) && path.endsWith('/meta.json'))) {
      const artifact = parseJson<HarnessArtifact | null>(this.fs.read(path), null);
      if (artifact?.taskId === taskId) relatedArtifactIds.add(artifact.id);
    }
    const artifactPrefixes = [...relatedArtifactIds].map(id => `${this.artifactRoot}${id}/`);
    const paths = this.fs.list().filter(path => path.startsWith(taskPrefix)
      || artifactPrefixes.some(prefix => path.startsWith(prefix)));
    for (const path of paths) await this.fs.remove(path);
    this.eventSequences.delete(taskId);
  }

  async appendEvent(taskId: string, type: string, data: JsonValue = null): Promise<TaskEvent> {
    this.assertTaskWritable(taskId);
    const path = this.eventsPath(taskId);
    const previous = this.fs.read(path);
    const sequence = (this.eventSequences.get(taskId) ?? 0) + 1;
    this.eventSequences.set(taskId, sequence);
    const event = { id: this.uuid(), taskId, sequence, type, timestamp: this.now(), data };
    await this.fs.write(path, `${previous ? `${previous.trimEnd()}\n` : ''}${JSON.stringify(event)}\n`);
    return event;
  }

  async persistCheckpoint(taskId: string, messages: readonly HarnessMessage[]): Promise<void> {
    this.assertTaskWritable(taskId);
    // Vue messages may be reactive proxies, which structuredClone rejects.
    // JSON is also the persisted checkpoint format, so clone through it here.
    const cloned = JSON.parse(JSON.stringify(stableCheckpointMessages(messages))) as HarnessMessage[];
    await this.writeJson(this.checkpointPath(taskId), { taskId, messages: cloned, savedAt: this.now() });
  }

  touch(task: TaskSession, status?: TaskStatus): void {
    task.updatedAt = this.now();
    if (status) task.status = status;
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await this.fs.write(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  private isTaskDeleted(taskId: string): boolean {
    return this.fs.read(this.tombstonePath(taskId)) !== null;
  }

  private assertTaskWritable(taskId: string): void {
    if (this.isTaskDeleted(taskId)) {
      throw new Error(`task "${taskId}" was deleted in another Harness panel`);
    }
  }

  private metaPath(id: string): string { return `${this.sessionRoot}${id}/meta.json`; }
  private contextsPath(id: string): string { return `${this.sessionRoot}${id}/contexts.json`; }
  private eventsPath(id: string): string { return `${this.sessionRoot}${id}/events.jsonl`; }
  private checkpointPath(id: string): string { return `${this.sessionRoot}${id}/checkpoint.json`; }
  private artifactMetaPath(id: string): string { return `${this.artifactRoot}${id}/meta.json`; }
  private tombstonePath(id: string): string { return `${this.tombstoneRoot}${id}.json`; }
}

/** Persist conversation state, not transient runtime diagnostics. */
export function stableCheckpointMessages(messages: readonly HarnessMessage[]): HarnessMessage[] {
  return messages.filter(message => message.role !== 'note'
    && (message.role !== 'assistant' || message.status === 'done'));
}

function parseJson<T>(source: string | null, fallback: T): T {
  if (!source) return fallback;
  try { return JSON.parse(source) as T; }
  catch { return fallback; }
}

function pickModel(config: SessionLlmConfig): ModelSelection {
  return { profileId: config.profileId, model: config.model };
}
