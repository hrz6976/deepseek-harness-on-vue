import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis';
import { reactive, toRef } from 'vue';
import { type TaskDatabase, emptyTaskDatabase, HarnessTaskStore, stableCheckpointMessages } from '@/kernel/task-store';
import { normalizeSessionLlmConfig } from '@/shared/task-model';
import type { HarnessMessage, JsonValue, TaskRuntimeService } from '@/shared/runtime';
import { log } from '@/kernel/log';

function applyTaskRuntime(ctx: Context, storageScope?: string): void {
  const store = new HarnessTaskStore(ctx.fs, undefined, undefined, storageScope);
  const state = reactive<object>(emptyTaskDatabase()) as TaskDatabase;
  const messages = reactive<HarnessMessage[]>([]);
  const activeTaskId = toRef(state, 'activeTaskId');
  let taskFiber: Fiber | null = null;
  let controller: AbortController | null = null;
  let queue = Promise.resolve();
  let disposed = false;
  let switching = false;
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const activeTask = () => state.tasks.find(task => task.id === activeTaskId.value) ?? null;
  const requireTask = (id = activeTaskId.value) => {
    const task = state.tasks.find(task => task.id === id);
    if (!task) throw new Error(`task "${id ?? ''}" does not exist`);
    return task;
  };
  const assertIdle = () => { if (controller || switching) throw new Error('Stop the active run and wait for the task transition before changing tasks.'); };
  const checkpoint = () => {
    if (activeTaskId.value) state.checkpoints[activeTaskId.value] = clone(stableCheckpointMessages(messages));
  };
  function command<T>(change: () => T | Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      if (disposed) throw new Error('Task runtime is disposed.');
      const previous = clone(state);
      try {
        const value = await change();
        await store.save(state);
        return value;
      } catch (error) {
        Object.assign(state, previous);
        throw error;
      }
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async function transition<T>(change: () => Promise<T>): Promise<T> {
    assertIdle();
    switching = true;
    try {
      const value = await change();
      await resetScope();
      return value;
    } finally {
      switching = false;
    }
  }
  async function resetScope(notify = true): Promise<void> {
    messages.splice(0, messages.length, ...clone(state.checkpoints[activeTaskId.value ?? ''] ?? []));
    await taskFiber?.dispose();
    taskFiber = await ctx.plugin({ name: `task:${activeTaskId.value}`, apply() {} });
    if (notify) await ctx.parallel('task/activated', activeTaskId.value);
  }
  const addTask = (title = 'New task') => {
    const task = store.newTask(title);
    state.tasks.push(task);
    activeTaskId.value = task.id;
    return state.tasks.at(-1)!;
  };
  function record(taskId: string, type: string, data: JsonValue = null) {
    const sequence = (state.events.filter(event => event.taskId === taskId).at(-1)?.sequence ?? 0) + 1;
    const event = { id: crypto.randomUUID(), taskId, sequence, type, timestamp: Date.now(), data };
    state.events.push(event);
    return event;
  }
  function addContext(input: Parameters<TaskRuntimeService['addContext']>[0]) {
    const task = requireTask();
    const existing = state.contexts.find(item => item.taskId === task.id && item.kind === input.kind && item.locator === input.locator);
    if (existing) return existing;
    const context = store.newContext(task.id, input);
    state.contexts.push(context);
    return context;
  }
  function createArtifact(input: Parameters<TaskRuntimeService['createArtifact']>[0]) {
    const artifact = store.newArtifact(requireTask().id, input);
    state.artifacts.push(artifact);
    return artifact;
  }
  const ready = (async () => {
    Object.assign(state, await store.load());
    for (const task of state.tasks) {
      if (task.status !== 'running') continue;
      task.status = 'idle';
      record(task.id, 'task/run-interrupted', { reason: 'runtime-restarted' });
    }
    if (!state.tasks.length) addTask();
    await command(() => undefined);
    await resetScope(false);
  })();
  const service: TaskRuntimeService = {
    ready, messages, activeTaskId, activeTask, scope: () => taskFiber?.ctx ?? ctx,
    get tasks() { return state.tasks; },
    get contexts() { return state.contexts; },
    get artifacts() { return state.artifacts; },
    get signal() { return controller?.signal; },
    async beginRun(next, goal) {
      assertIdle();
      controller = next;
      try {
        await command(() => {
          const task = requireTask();
          task.status = 'running';
          if (task.title === 'New task' && goal?.trim()) {
            task.title = goal.trim().slice(0, 48);
            task.updatedAt = Date.now();
          }
        });
      }
      catch (error) { controller = null; throw error; }
    },
    endRun() {
      const saved = command(() => { checkpoint(); requireTask().status = 'idle'; });
      controller = null;
      return saved;
    },
    refresh: () => transition(async () => {
      await queue;
      await ctx.fs.refresh?.();
      Object.assign(state, await store.load());
    }),
    createTask: title => transition(() => command(() => { checkpoint(); return addTask(title); })),
    activateTask: id => transition(() => command(() => { checkpoint(); const task = requireTask(id); activeTaskId.value = id; return task; })),
    deleteTask: id => transition(() => command(() => {
      state.tasks = state.tasks.filter(task => task.id !== id);
      state.contexts = state.contexts.filter(item => item.taskId !== id);
      state.artifacts = state.artifacts.filter(item => item.taskId !== id);
      state.events = state.events.filter(item => item.taskId !== id);
      delete state.checkpoints[id];
      if (activeTaskId.value === id) activeTaskId.value = state.tasks[0]?.id ?? null;
      if (!state.tasks.length) addTask();
    })),
    renameTask: (id, title) => command(() => { const task = requireTask(id); task.title = title.trim() || task.title; task.updatedAt = Date.now(); }),
    setLlmConfig: config => command(() => { requireTask().llm = normalizeSessionLlmConfig(config); }),
    setModelSelection: (profileId, model) => command(async () => {
      const selection = await store.selectModel(profileId, model);
      for (const task of state.tasks) task.llm = { ...task.llm, ...selection };
    }),
    addContext: (input, event) => command(() => {
      const context = addContext(input);
      if (event) record(context.taskId, event.type, event.data);
      return context;
    }),
    attachFile: path => command(() => {
      const content = ctx.fs.read(path);
      if (content == null) throw new Error(`File "${path}" does not exist.`);
      const context = addContext({ kind: 'file', title: path.split('/').at(-1) || path, locator: path, metadata: { size: content.length } });
      record(context.taskId, 'context/attached', { kind: 'file', path });
      return context;
    }),
    saveMessageArtifact: message => {
      if (message.role !== 'assistant' || !message.text) return Promise.resolve(null);
      return command(() => createArtifact({
        kind: 'report', title: 'Agent report', status: 'ready', source: { type: 'agent' }, content: { text: message.text },
      }));
    },
    removeContext: id => command(() => { state.contexts = state.contexts.filter(item => item.id !== id); }),
    setCapability: (id, attached) => command(() => {
      const task = requireTask();
      task.capabilityIds = [...new Set(attached ? [...task.capabilityIds, id] : task.capabilityIds.filter(value => value !== id))];
    }),
    createArtifact: input => command(() => createArtifact(input)),
    updateArtifact: (id, patch) => command(() => {
      const artifact = state.artifacts.find(item => item.id === id);
      if (!artifact) throw new Error(`artifact "${id}" does not exist`);
      Object.assign(artifact, patch, { version: artifact.version + 1, updatedAt: Date.now() });
      return artifact;
    }),
    appendEvent: (type, data) => command(() => record(requireTask().id, type, data)),
    saveCheckpoint: source => command(() => { state.checkpoints[requireTask().id] = clone(stableCheckpointMessages(source ?? messages)); }),
    async clearConversation() {
      assertIdle();
      await command(() => { state.checkpoints[requireTask().id] = []; });
      messages.splice(0);
    },
  };
  ctx.provide('task', service);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let loopBusy = false;
  let invalidated = false;
  const refreshWorkspace = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (loopBusy || switching || disposed) return;
      invalidated = false;
      void ready.then(() => service.refresh()).catch(error => log(`Workspace refresh failed: ${String(error)}`, 'err'));
    }, 100);
  };
  ctx.on('workspace/invalidated', () => { invalidated = true; refreshWorkspace(); });
  ctx.on('loop/busy', () => { loopBusy = true; });
  ctx.on('loop/idle', () => { loopBusy = false; if (invalidated) refreshWorkspace(); });
  ctx.on('task/activated', () => { if (invalidated) refreshWorkspace(); });
  ctx.effect(() => () => { disposed = true; controller?.abort(); clearTimeout(refreshTimer); }, 'task.owner');
}
export function createTaskRuntimePlugin(scope?: string): Plugin.Object {
  return { name: 'task-runtime', inject: ['fs'], apply: ctx => applyTaskRuntime(ctx, scope) };
}
export default createTaskRuntimePlugin();
