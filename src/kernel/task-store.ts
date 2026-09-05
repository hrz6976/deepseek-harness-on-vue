import type { FsService, HarnessMessage } from '@/shared/runtime';
import { normalizeSessionLlmConfig, type HarnessArtifact, type SessionLlmConfig, type TaskContext, type TaskEvent, type TaskSession, type TaskStoreSnapshot } from '@/shared/task-model';

type ModelSelection = Pick<SessionLlmConfig, 'profileId' | 'model'>;
export interface TaskDatabase extends TaskStoreSnapshot {
  checkpoints: Record<string, HarnessMessage[]>;
  events: TaskEvent[];
}
export const emptyTaskDatabase = (): TaskDatabase => ({ activeTaskId: null, tasks: [], contexts: [], artifacts: [], checkpoints: {}, events: [] });

/** One revision replaces the entire host task database; no partial task commits. */
export class HarnessTaskStore {
  readonly path: string;
  private readonly root: string;
  private revision: string | null = null;
  private selectedModel: ModelSelection = pickModel(normalizeSessionLlmConfig());
  constructor(private readonly fs: FsService, private readonly now = () => Date.now(), private readonly uuid = () => crypto.randomUUID(), scope?: string) {
    this.root = scope ? `.harness/hosts/${encodeURIComponent(scope)}/` : '.harness/';
    this.path = `${this.root}tasks.json`;
  }

  async load(): Promise<TaskDatabase> {
    await this.fs.ready;
    this.revision = this.fs.read(this.path);
    // Existing databases must parse successfully: silently resetting corrupt data loses tasks.
    const state: TaskDatabase = this.revision === null ? this.importLegacy() : JSON.parse(this.revision);
    const model = this.fs.read('.harness/model.json');
    this.selectedModel = pickModel(normalizeSessionLlmConfig(model ? JSON.parse(model) : state.tasks.find(task => task.id === state.activeTaskId)?.llm));
    for (const task of state.tasks) task.llm = { ...normalizeSessionLlmConfig(task.llm), ...this.selectedModel };
    return state;
  }

  async save(state: TaskDatabase): Promise<void> {
    if (this.fs.read(this.path) !== this.revision) throw new Error('Task database changed in another runtime. Refresh before writing.');
    const source = JSON.stringify(state);
    await this.fs.write(this.path, source);
    this.revision = source;
  }

  async selectModel(profileId: string, model: string): Promise<ModelSelection> {
    const selection = pickModel(normalizeSessionLlmConfig({ profileId, model }));
    await this.fs.write('.harness/model.json', JSON.stringify(selection));
    this.selectedModel = selection;
    return selection;
  }

  /** Read the former multi-file layout once. Future commits use tasks.json exclusively. */
  private importLegacy(): TaskDatabase {
    const read = <T>(path: string, fallback: T): T => {
      const source = this.fs.read(`${this.root}${path}`);
      return source === null ? fallback : JSON.parse(source) as T;
    };
    const state = emptyTaskDatabase();
    const index = read('sessions/index.json', { activeTaskId: null as string | null, taskIds: [] as string[] });
    for (const id of index.taskIds) {
      if (this.fs.read(`${this.root}tombstones/tasks/${id}.json`) !== null) continue;
      const task = read<TaskSession | null>(`sessions/${id}/meta.json`, null);
      if (!task) continue;
      state.tasks.push(task);
      state.contexts.push(...read<TaskContext[]>(`sessions/${id}/contexts.json`, []));
      state.checkpoints[id] = stableCheckpointMessages(read(`sessions/${id}/checkpoint.json`, { messages: [] as HarnessMessage[] }).messages);
      const events = this.fs.read(`${this.root}sessions/${id}/events.jsonl`);
      if (events?.trim()) state.events.push(...events.trim().split('\n').map(line => JSON.parse(line) as TaskEvent));
    }
    for (const path of this.fs.list().filter(path => path.startsWith(`${this.root}artifacts/`) && path.endsWith('/meta.json'))) {
      const artifact = JSON.parse(this.fs.read(path)!) as HarnessArtifact;
      if (state.tasks.some(task => task.id === artifact.taskId)) state.artifacts.push(artifact);
    }
    state.activeTaskId = state.tasks.find(task => task.id === index.activeTaskId)?.id ?? state.tasks[0]?.id ?? null;
    return state;
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

}

/** Persist conversation state, not transient runtime diagnostics. */
export function stableCheckpointMessages(messages: readonly HarnessMessage[]): HarnessMessage[] {
  return messages.filter(message => message.role !== 'note' && (message.role !== 'assistant' || message.status === 'done'));
}
function pickModel(config: SessionLlmConfig): ModelSelection { return { profileId: config.profileId, model: config.model }; }
