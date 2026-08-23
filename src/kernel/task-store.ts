import type { FsService, HarnessMessage, JsonValue } from '@/shared/runtime';
import type {
  HarnessArtifact,
  TaskCheckpoint,
  TaskContext,
  TaskEvent,
  TaskSession,
  TaskStatus,
  TaskStoreSnapshot,
} from '@/shared/task-model';

export const HARNESS_ROOT = '.harness/';
export const SESSION_ROOT = `${HARNESS_ROOT}sessions/`;
export const ARTIFACT_ROOT = `${HARNESS_ROOT}artifacts/`;
export const TASK_TOMBSTONE_ROOT = `${HARNESS_ROOT}tombstones/tasks/`;
interface SessionIndex { activeTaskId: string | null; taskIds: string[] }

export class HarnessTaskStore {
  readonly checkpoints = new Map<string, TaskCheckpoint>();
  private readonly sessionRoot: string;
  private readonly artifactRoot: string;
  private readonly tombstoneRoot: string;
  private readonly sessionIndex: string;

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
    this.checkpoints.clear();
    const index = parseJson<SessionIndex>(this.fs.read(this.sessionIndex), { activeTaskId: null, taskIds: [] });
    const tasks = index.taskIds
      .filter(id => !this.isTaskDeleted(id))
      .map(id => parseJson<TaskSession | null>(this.fs.read(this.metaPath(id)), null))
      .filter((task): task is TaskSession => task !== null);
    const taskIds = new Set(tasks.map(task => task.id));
    const contexts = tasks.flatMap(task => parseJson<TaskContext[]>(this.fs.read(this.contextsPath(task.id)), []));
    const events = tasks.flatMap(task => parseJsonLines<TaskEvent>(this.fs.read(this.eventsPath(task.id))));
    for (const task of tasks) {
      const checkpoint = parseJson<TaskCheckpoint | null>(this.fs.read(this.checkpointPath(task.id)), null);
      if (checkpoint) this.checkpoints.set(task.id, {
        ...checkpoint,
        messages: stableCheckpointMessages(checkpoint.messages),
      });
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
      events,
    };
  }

  newTask(title = 'Untitled task'): TaskSession {
    const timestamp = this.now();
    return {
      id: this.uuid(), title: title.trim() || 'Untitled task', status: 'idle',
      contextIds: [], capabilityIds: [], artifactIds: [],
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

  newEvent(taskId: string, sequence: number, type: string, data: JsonValue = null): TaskEvent {
    return { id: this.uuid(), taskId, sequence, type, timestamp: this.now(), data };
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

  async persistContexts(taskId: string, contexts: TaskContext[]): Promise<void> {
    this.assertTaskWritable(taskId);
    await this.writeJson(this.contextsPath(taskId), contexts);
  }

  async persistArtifact(artifact: HarnessArtifact): Promise<void> {
    this.assertTaskWritable(artifact.taskId);
    await this.writeJson(this.artifactMetaPath(artifact.id), artifact);
  }

  async deleteTask(task: TaskSession): Promise<void> {
    if (!this.isTaskDeleted(task.id)) {
      await this.writeJson(this.tombstonePath(task.id), { taskId: task.id, deletedAt: this.now() });
    }
    const taskPrefix = `${this.sessionRoot}${task.id}/`;
    const relatedArtifactIds = new Set(task.artifactIds);
    for (const path of this.fs.list().filter(path => path.startsWith(this.artifactRoot) && path.endsWith('/meta.json'))) {
      const artifact = parseJson<HarnessArtifact | null>(this.fs.read(path), null);
      if (artifact?.taskId === task.id) relatedArtifactIds.add(artifact.id);
    }
    const artifactPrefixes = [...relatedArtifactIds].map(id => `${this.artifactRoot}${id}/`);
    const paths = this.fs.list().filter(path => path.startsWith(taskPrefix)
      || artifactPrefixes.some(prefix => path.startsWith(prefix)));
    for (const path of paths) await this.fs.remove(path);
    this.checkpoints.delete(task.id);
  }

  async appendEvent(event: TaskEvent): Promise<void> {
    this.assertTaskWritable(event.taskId);
    const path = this.eventsPath(event.taskId);
    const previous = this.fs.read(path);
    await this.fs.write(path, `${previous ? `${previous.trimEnd()}\n` : ''}${JSON.stringify(event)}\n`);
  }

  async persistCheckpoint(taskId: string, messages: HarnessMessage[]): Promise<TaskCheckpoint> {
    this.assertTaskWritable(taskId);
    // Vue messages may be reactive proxies, which structuredClone rejects.
    // JSON is also the persisted checkpoint format, so clone through it here.
    const cloned = JSON.parse(JSON.stringify(stableCheckpointMessages(messages))) as HarnessMessage[];
    const checkpoint: TaskCheckpoint = { id: this.uuid(), taskId, messages: cloned, savedAt: this.now() };
    this.checkpoints.set(taskId, checkpoint);
    await this.writeJson(this.checkpointPath(taskId), checkpoint);
    return checkpoint;
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

function parseJsonLines<T>(source: string | null): T[] {
  if (!source) return [];
  return source.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as T]; }
    catch { return []; }
  });
}
