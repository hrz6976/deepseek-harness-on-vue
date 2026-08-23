import type { Context } from '@deepseek-ai/cordis';
import { reactive, ref } from 'vue';
import { HarnessTaskStore } from '@/kernel/task-store';
import type { HarnessArtifact, TaskContext, TaskEvent, TaskStatus } from '@/shared/task-model';
import type { HarnessMessage, JsonValue } from '@/shared/runtime';

export const name = 'task-runtime';
export const inject = ['fs'];

function applyTaskRuntime(ctx: Context, scope?: string): void {
    const fs = ctx.fs;
    const store = new HarnessTaskStore(fs, undefined, undefined, scope);
    const tasks = reactive<ReturnType<HarnessTaskStore['newTask']>[]>([]);
    const contexts = reactive<TaskContext[]>([]);
    // JsonValue is recursively typed; keep Vue's deep UnwrapRef expansion out
    // of the public service type while retaining a fully reactive array.
    const artifacts = reactive([]) as unknown as HarnessArtifact[];
    const events = reactive([]) as unknown as TaskEvent[];
    const activeTaskId = ref<string | null>(null);

    const activeTask = () => tasks.find(task => task.id === activeTaskId.value) ?? null;
    const persistIndex = () => store.persistIndex(activeTaskId.value, tasks);
    const requireActive = () => {
      const task = activeTask();
      if (!task) throw new Error('no active task');
      return task;
    };

    async function restore(preferCurrentTask: boolean): Promise<void> {
      const previousActiveTaskId = preferCurrentTask ? activeTaskId.value : null;
      const restored = await store.load();
      tasks.splice(0, tasks.length, ...restored.tasks);
      contexts.splice(0, contexts.length, ...restored.contexts);
      artifacts.splice(0, artifacts.length, ...restored.artifacts);
      events.splice(0, events.length, ...restored.events);
      activeTaskId.value = previousActiveTaskId && tasks.some(task => task.id === previousActiveTaskId)
        ? previousActiveTaskId
        : restored.activeTaskId;
    }

    const ready = (async () => {
      await restore(false);
      if (!tasks.length) await createTask('New task');
    })();

    async function refresh(): Promise<void> {
      await restore(true);
      if (!tasks.length) await createTask('New task');
    }

    async function createTask(title = 'New task') {
      const task = store.newTask(title);
      tasks.push(task);
      activeTaskId.value = task.id;
      await store.persistTask(task);
      await persistIndex();
      return task;
    }

    async function activateTask(id: string) {
      const task = tasks.find(candidate => candidate.id === id);
      if (!task) throw new Error(`task "${id}" does not exist`);
      activeTaskId.value = id;
      await persistIndex();
      return task;
    }

    async function deleteTask(id: string): Promise<void> {
      const index = tasks.findIndex(task => task.id === id);
      if (index < 0) return;
      const task = tasks[index]!;
      await store.deleteTask(task);
      tasks.splice(index, 1);
      contexts.splice(0, contexts.length, ...contexts.filter(context => context.taskId !== id));
      artifacts.splice(0, artifacts.length, ...artifacts.filter(artifact => artifact.taskId !== id));
      events.splice(0, events.length, ...events.filter(event => event.taskId !== id));

      if (activeTaskId.value === id) {
        activeTaskId.value = tasks[Math.min(index, tasks.length - 1)]?.id ?? null;
      }
      if (!tasks.length) await createTask('New task');
      else await persistIndex();
    }

    async function renameTask(id: string, title: string): Promise<void> {
      const task = tasks.find(candidate => candidate.id === id);
      if (!task) throw new Error(`task "${id}" does not exist`);
      task.title = title.trim() || task.title;
      store.touch(task);
      await store.persistTask(task);
    }

    async function setStatus(id: string, status: TaskStatus): Promise<void> {
      const task = tasks.find(candidate => candidate.id === id);
      if (!task) throw new Error(`task "${id}" does not exist`);
      store.touch(task, status);
      await store.persistTask(task);
    }

    async function addContext(input: Pick<TaskContext, 'kind' | 'title' | 'locator'> & Partial<Pick<TaskContext, 'mimeType' | 'metadata'>>) {
      const task = requireActive();
      const existing = contexts.find(context => context.taskId === task.id && context.kind === input.kind && context.locator === input.locator);
      if (existing) return existing;
      const context = store.newContext(task.id, input);
      contexts.push(context);
      task.contextIds.push(context.id);
      store.touch(task);
      await Promise.all([store.persistContexts(task.id, contexts.filter(item => item.taskId === task.id)), store.persistTask(task)]);
      return context;
    }

    async function removeContext(id: string): Promise<void> {
      const index = contexts.findIndex(context => context.id === id);
      if (index < 0) return;
      const [context] = contexts.splice(index, 1);
      if (!context) return;
      const task = tasks.find(candidate => candidate.id === context.taskId);
      if (!task) return;
      task.contextIds = task.contextIds.filter(contextId => contextId !== id);
      store.touch(task);
      await Promise.all([store.persistContexts(task.id, contexts.filter(item => item.taskId === task.id)), store.persistTask(task)]);
    }

    async function attachCapability(id: string): Promise<void> {
      const task = requireActive();
      if (task.capabilityIds.includes(id)) return;
      task.capabilityIds.push(id);
      store.touch(task);
      await store.persistTask(task);
    }

    async function detachCapability(id: string): Promise<void> {
      const task = requireActive();
      if (!task.capabilityIds.includes(id)) return;
      task.capabilityIds = task.capabilityIds.filter(capabilityId => capabilityId !== id);
      store.touch(task);
      await store.persistTask(task);
    }

    async function createArtifact(input: Pick<HarnessArtifact, 'kind' | 'title' | 'source'> & Partial<Pick<HarnessArtifact, 'status' | 'contentPath' | 'content' | 'verification'>>) {
      const task = requireActive();
      const artifact = store.newArtifact(task.id, input);
      artifacts.push(artifact);
      task.artifactIds.push(artifact.id);
      store.touch(task);
      await Promise.all([store.persistArtifact(artifact), store.persistTask(task)]);
      return artifact;
    }

    async function updateArtifact(id: string, patch: Partial<Pick<HarnessArtifact, 'title' | 'status' | 'contentPath' | 'content' | 'verification'>>) {
      const artifact = artifacts.find(candidate => candidate.id === id);
      if (!artifact) throw new Error(`artifact "${id}" does not exist`);
      Object.assign(artifact, patch, { version: artifact.version + 1, updatedAt: Date.now() });
      await store.persistArtifact(artifact);
      return artifact;
    }

    async function appendEvent(type: string, data: JsonValue = null) {
      const task = requireActive();
      const sequence = events.filter(event => event.taskId === task.id).reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
      const event = store.newEvent(task.id, sequence, type, data);
      events.push(event);
      await store.appendEvent(event);
      return event;
    }

    async function saveCheckpoint(messages: HarnessMessage[]) {
      const task = requireActive();
      const checkpoint = await store.persistCheckpoint(task.id, messages);
      task.checkpointId = checkpoint.id;
      store.touch(task);
      await store.persistTask(task);
      return checkpoint;
    }

    ctx.provide('task', {
      ready, tasks, contexts, artifacts, events, activeTaskId, activeTask,
      refresh,
      createTask, activateTask, deleteTask, renameTask, setStatus, addContext, removeContext, attachCapability, detachCapability,
      createArtifact, updateArtifact, appendEvent, saveCheckpoint,
      loadCheckpoint: (taskId?: string) => store.checkpoints.get(taskId ?? activeTaskId.value ?? '') ?? null,
    });
}

export function apply(ctx: Context): void {
  applyTaskRuntime(ctx);
}

export function createTaskRuntimePlugin(scope?: string) {
  return { name, inject, apply: (ctx: Context) => applyTaskRuntime(ctx, scope) };
}

export const taskRuntimePlugin = { name, inject, apply };

export default taskRuntimePlugin;
