import type { Context, Fiber } from '@deepseek-ai/cordis';
import { reactive, ref } from 'vue';
import { HarnessTaskStore } from '@/kernel/task-store';
import { normalizeSessionLlmConfig, type HarnessArtifact, type SessionLlmConfig, type TaskContext, type TaskStatus } from '@/shared/task-model';
import type { HarnessMessage, JsonValue } from '@/shared/runtime';

function applyTaskRuntime(ctx: Context, storageScope?: string): void {
    const fs = ctx.fs;
    const store = new HarnessTaskStore(fs, undefined, undefined, storageScope);
    const tasks = reactive<ReturnType<HarnessTaskStore['newTask']>[]>([]);
    const contexts = reactive<TaskContext[]>([]);
    const artifacts = reactive([]) as unknown as HarnessArtifact[];
    const messages = reactive<HarnessMessage[]>([]);
    const activeTaskId = ref<string | null>(null);
    let taskFiber: Fiber | null = null;
    let llmSaveQueue = Promise.resolve();

    const activeTask = () => tasks.find(task => task.id === activeTaskId.value) ?? null;
    const scope = () => taskFiber?.ctx ?? ctx;
    const persistIndex = () => store.persistIndex(activeTaskId.value, tasks);
    const requireTask = (id: string | null) => {
      const task = tasks.find(candidate => candidate.id === id);
      if (!task) throw new Error(id ? `task "${id}" does not exist` : 'no active task');
      return task;
    };
    const requireActive = () => requireTask(activeTaskId.value);
    const loadMessages = (taskId: string | null) => messages.splice(0, messages.length, ...store.checkpointMessages(taskId));

    async function resetScope(taskId: string | null, notify = true): Promise<void> {
      await taskFiber?.dispose();
      taskFiber = null;
      if (taskId) {
        taskFiber = ctx.plugin({ name: `task:${taskId}`, apply() {} }) as Fiber;
        await taskFiber;
      }
      if (notify) await ctx.parallel('task/activated', taskId);
    }

    async function restore(preferCurrentTask: boolean): Promise<void> {
      const previousActiveTaskId = preferCurrentTask ? activeTaskId.value : null;
      const restored = await store.load();
      if (!preferCurrentTask) {
        // A sandbox frame cannot keep executing after its side panel/runtime is
        // destroyed. Reconcile the durable status on the next boot so the UI
        // never advertises a ghost run that has no AbortController behind it.
        const interrupted = restored.tasks.filter(task => task.status === 'running');
        await Promise.all(interrupted.map(async task => {
          store.touch(task, 'idle');
          await store.persistTask(task);
          await store.appendEvent(task.id, 'task/run-interrupted', { reason: 'runtime-restarted' });
        }));
      }
      tasks.splice(0, tasks.length, ...restored.tasks);
      contexts.splice(0, contexts.length, ...restored.contexts);
      artifacts.splice(0, artifacts.length, ...restored.artifacts);
      const nextTaskId = previousActiveTaskId && tasks.some(task => task.id === previousActiveTaskId)
        ? previousActiveTaskId
        : restored.activeTaskId;
      activeTaskId.value = nextTaskId;
      if (!preferCurrentTask || nextTaskId !== previousActiveTaskId) {
        loadMessages(nextTaskId);
        await resetScope(nextTaskId, preferCurrentTask);
      }
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
      if (activeTask()) await saveCheckpoint();
      const task = store.newTask(title);
      tasks.push(task);
      activeTaskId.value = task.id;
      messages.splice(0);
      await resetScope(task.id);
      await store.persistTask(task);
      await persistIndex();
      return task;
    }

    async function activateTask(id: string) {
      const task = requireTask(id);
      if (id === activeTaskId.value) return task;
      if (activeTask()) await saveCheckpoint();
      activeTaskId.value = id;
      loadMessages(id);
      await resetScope(id);
      await persistIndex();
      return task;
    }

    async function deleteTask(id: string): Promise<void> {
      const index = tasks.findIndex(task => task.id === id);
      if (index < 0) return;
      const task = tasks[index]!;
      await store.deleteTask(task.id);
      tasks.splice(index, 1);
      contexts.splice(0, contexts.length, ...contexts.filter(context => context.taskId !== id));
      artifacts.splice(0, artifacts.length, ...artifacts.filter(artifact => artifact.taskId !== id));

      if (activeTaskId.value === id) {
        activeTaskId.value = tasks[Math.min(index, tasks.length - 1)]?.id ?? null;
        loadMessages(activeTaskId.value);
        if (tasks.length) await resetScope(activeTaskId.value);
      }
      if (!tasks.length) await createTask('New task');
      else await persistIndex();
    }

    async function renameTask(id: string, title: string): Promise<void> {
      const task = requireTask(id);
      task.title = title.trim() || task.title;
      store.touch(task);
      await store.persistTask(task);
    }

    async function setStatus(id: string, status: TaskStatus): Promise<void> {
      const task = requireTask(id);
      store.touch(task, status);
      await store.persistTask(task);
    }

    function setLlmConfig(config: SessionLlmConfig): Promise<void> {
      const task = requireActive();
      task.llm = normalizeSessionLlmConfig(config);
      store.touch(task);
      const save = llmSaveQueue.catch(() => undefined).then(() => store.persistTask(task));
      llmSaveQueue = save;
      return save;
    }

    function setModelSelection(profileId: string, model: string): Promise<void> {
      const selection = store.setModelSelection(profileId, model);
      for (const task of tasks) {
        task.llm = { ...task.llm, ...selection };
        store.touch(task);
      }
      const save = llmSaveQueue.catch(() => undefined)
        .then(() => Promise.all([store.persistModelSelection(), ...tasks.map(task => store.persistTask(task))]))
        .then(() => undefined);
      llmSaveQueue = save;
      return save;
    }

    async function addContext(input: Pick<TaskContext, 'kind' | 'title' | 'locator'> & Partial<Pick<TaskContext, 'mimeType' | 'metadata'>>) {
      const task = requireActive();
      const existing = contexts.find(context => context.taskId === task.id && context.kind === input.kind && context.locator === input.locator);
      if (existing) return existing;
      const context = store.newContext(task.id, input);
      contexts.push(context);
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
      store.touch(task);
      await Promise.all([store.persistContexts(task.id, contexts.filter(item => item.taskId === task.id)), store.persistTask(task)]);
    }

    async function setCapability(id: string, attached: boolean): Promise<void> {
      const task = requireActive();
      if (task.capabilityIds.includes(id) === attached) return;
      task.capabilityIds = attached ? [...task.capabilityIds, id] : task.capabilityIds.filter(capabilityId => capabilityId !== id);
      store.touch(task);
      await store.persistTask(task);
      await ctx.parallel(`task/capability-${attached ? 'attached' : 'detached'}`, id);
    }
    const attachCapability = (id: string) => setCapability(id, true);
    const detachCapability = (id: string) => setCapability(id, false);

    async function createArtifact(input: Pick<HarnessArtifact, 'kind' | 'title' | 'source'> & Partial<Pick<HarnessArtifact, 'status' | 'contentPath' | 'content' | 'verification'>>) {
      const task = requireActive();
      const artifact = store.newArtifact(task.id, input);
      artifacts.push(artifact);
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
      return store.appendEvent(task.id, type, data);
    }

    async function saveCheckpoint(source: readonly HarnessMessage[] = messages) {
      const task = requireActive();
      await store.persistCheckpoint(task.id, source);
      store.touch(task);
      await store.persistTask(task);
    }

    ctx.provide('task', {
      ready, messages, tasks, contexts, artifacts, activeTaskId, activeTask, scope,
      refresh,
      createTask, activateTask, deleteTask, renameTask, setStatus, setLlmConfig, setModelSelection, addContext, removeContext, attachCapability, detachCapability,
      createArtifact, updateArtifact, appendEvent, saveCheckpoint,
    });
}

export function createTaskRuntimePlugin(scope?: string) {
  return { name: 'task-runtime', inject: ['fs'], apply: (ctx: Context) => applyTaskRuntime(ctx, scope) };
}
