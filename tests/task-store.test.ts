import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { emptyTaskDatabase, HarnessTaskStore, stableCheckpointMessages } from '@/kernel/task-store';
import { createTaskRuntimePlugin } from '@/plugins/task-runtime';
import { runtime } from '@/kernel/cordis';
import type { TaskRuntimeService } from '@/shared/runtime';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';

afterEach(async () => { await cleanupTestRuntime(); });

function fakeFs(initial: Record<string, string> = {}) {
  const files = reactive(new Map(Object.entries(initial)));
  return {
    files,
    ready: Promise.resolve(),
    read: (path: string) => files.get(path) ?? null,
    list: () => [...files.keys()].sort(),
    async write(path: string, content: string) { files.set(path, content); },
    async remove(path: string) { files.delete(path); },
  };
}

test('one snapshot restores task, resources, events and annotated conversation together', async () => {
  const fs = fakeFs();
  const store = new HarnessTaskStore(fs);
  const state = await store.load();
  const task = store.newTask('Research launch');
  state.tasks.push(task);
  state.activeTaskId = task.id;
  state.contexts.push(store.newContext(task.id, { kind: 'page', title: 'Product', locator: 'https://example.test' }));
  state.artifacts.push(store.newArtifact(task.id, { kind: 'report', title: 'Report', source: { type: 'agent' } }));
  state.checkpoints[task.id] = [{ role: 'user', text: 'continue' }];
  await store.save(state);
  assert.deepEqual(await new HarnessTaskStore(fs).load(), state);
  assert.deepEqual(fs.list(), ['.harness/tasks.json']);
});

test('legacy task metadata gains a current per-session model profile', async () => {
  const legacy = {
    id: 'legacy-task', title: 'Legacy', status: 'idle', capabilityIds: [], createdAt: 1, updatedAt: 1,
  };
  const fs = fakeFs({
    '.harness/sessions/index.json': JSON.stringify({ activeTaskId: legacy.id, taskIds: [legacy.id] }),
    [`.harness/sessions/${legacy.id}/meta.json`]: JSON.stringify(legacy),
  });
  const restored = await new HarnessTaskStore(fs).load();
  assert.deepEqual(restored.tasks[0]?.llm, {
    profileId: '', model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high',
  });
});

test('each host has its own atomic task database', async () => {
  const fs = fakeFs();
  for (const host of ['github.com', 'i-yuri.com']) {
    const store = new HarnessTaskStore(fs, undefined, undefined, host);
    const state = await store.load();
    const task = store.newTask(host);
    state.tasks.push(task);
    state.activeTaskId = task.id;
    await store.save(state);
  }
  assert.equal((await new HarnessTaskStore(fs, undefined, undefined, 'github.com').load()).tasks[0]?.title, 'github.com');
  assert.equal((await new HarnessTaskStore(fs, undefined, undefined, 'i-yuri.com').load()).tasks[0]?.title, 'i-yuri.com');
});

test('a stale writer cannot resurrect a deleted task or overwrite its resources', async () => {
  const fs = fakeFs();
  const owner = new HarnessTaskStore(fs);
  const state = await owner.load();
  state.tasks.push(owner.newTask('Delete me'));
  await owner.save(state);
  const stale = new HarnessTaskStore(fs);
  const old = await stale.load();
  await owner.save(emptyTaskDatabase());
  await assert.rejects(stale.save(old), /another runtime/);
  assert.deepEqual((await new HarnessTaskStore(fs).load()).tasks, []);
});

test('task deletion commits all related metadata without deleting workspace content', async () => {
  const fs = fakeFs({ 'keep.txt': 'keep' });
  await provideTestService('fs', fs);
  await applyTestPlugin(createTaskRuntimePlugin());
  const task = runtime.task;
  await task.ready;
  const id = task.activeTask()!.id;
  await task.addContext({ kind: 'file', title: 'Keep', locator: 'keep.txt' });
  await task.createArtifact({ kind: 'report', title: 'Report', source: { type: 'agent' } });
  await task.appendEvent('created');
  await task.deleteTask(id);
  const state = await new HarnessTaskStore(fs).load();
  assert.equal(state.tasks.some(item => item.id === id), false);
  assert.deepEqual(state.contexts, []);
  assert.deepEqual(state.artifacts, []);
  assert.deepEqual(state.events, []);
  assert.equal(fs.read('keep.txt'), 'keep');
});

test('concurrent task commands preserve event sequence and both updates', async () => {
  const fs = fakeFs();
  await provideTestService('fs', fs);
  await applyTestPlugin(createTaskRuntimePlugin());
  await runtime.task.ready;
  await Promise.all([runtime.task.appendEvent('first'), runtime.task.appendEvent('second')]);
  const state = await new HarnessTaskStore(fs).load();
  assert.deepEqual(state.events.map(event => [event.sequence, event.type]), [[1, 'first'], [2, 'second']]);
});

test('task checkpoints exclude transient notes and unfinished assistants', async () => {
  const messages = stableCheckpointMessages([
    { role: 'user', text: 'continue' },
    { role: 'note', text: 'LLM call failed: stale error' },
    { role: 'assistant', text: '', thinking: '', toolCalls: [], status: 'streaming' },
    { role: 'assistant', text: 'truncated', thinking: '', toolCalls: [], status: 'incomplete' },
    { role: 'assistant', text: '', thinking: '', toolCalls: [], status: 'error' },
    { role: 'assistant', text: 'stable answer', thinking: '', toolCalls: [], status: 'done' },
    { role: 'summary', text: 'checkpoint' },
  ]);

  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'summary']);
  assert.equal(messages[1]?.role === 'assistant' ? messages[1].status : null, 'done');
});

test('task runtime owns one conversation and checkpoints it across task switches', async () => {
  await provideTestService('fs', fakeFs());
  await applyTestPlugin(createTaskRuntimePlugin());
  const task = runtime.reflect.get('task') as TaskRuntimeService;
  await task.ready;
  const first = task.activeTask()!;
  await task.setModelSelection('opencode-go', 'deepseek-v4-pro');
  await task.setLlmConfig({ ...task.activeTask()!.llm, thinking: true, reasoningEffort: 'max' });
  const firstScope = task.scope();
  task.messages.push({ role: 'user', text: 'first conversation' });

  const second = await task.createTask('Second');
  assert.equal(second.llm.model, 'deepseek-v4-pro');
  const secondScope = task.scope();
  assert.equal(firstScope.fiber.uid, null);
  assert.deepEqual(task.messages, []);
  task.messages.push({ role: 'user', text: 'second conversation' });

  await task.activateTask(first.id);
  assert.deepEqual(task.activeTask()?.llm, { profileId: 'opencode-go', model: 'deepseek-v4-pro', thinking: true, reasoningEffort: 'max' });
  assert.equal(secondScope.fiber.uid, null);
  assert.equal(task.messages[0]?.text, 'first conversation');
  await task.activateTask(second.id);
  assert.equal(task.messages[0]?.text, 'second conversation');
});

test('model selection applies to existing and newly created conversations', async () => {
  await provideTestService('fs', fakeFs());
  await applyTestPlugin(createTaskRuntimePlugin());
  const task = runtime.reflect.get('task') as TaskRuntimeService;
  await task.ready;
  const first = task.activeTask()!;
  const second = await task.createTask('Second');

  await task.setModelSelection('opencode-go', 'remembered-model');
  const third = await task.createTask('Third');

  assert.ok([first, second, third].every(item => item.llm.profileId === 'opencode-go'));
  assert.ok([first, second, third].every(item => item.llm.model === 'remembered-model'));
});

test('model selection is shared across page-scoped conversation stores', async () => {
  const fs = fakeFs();
  const firstStore = new HarnessTaskStore(fs, undefined, undefined, 'first.example');
  await firstStore.selectModel('opencode-go', 'remembered-model');

  const otherStore = new HarnessTaskStore(fs, undefined, undefined, 'other.example');
  await otherStore.load();
  const task = otherStore.newTask('Other page');

  assert.equal(task.llm.profileId, 'opencode-go');
  assert.equal(task.llm.model, 'remembered-model');
});

test('the last selected model survives overlapping saves and runtime restore', async () => {
  const fs = fakeFs();
  const write = fs.write.bind(fs);
  fs.write = async (path, content) => {
    if (content.includes('slow-model')) await new Promise(resolve => setTimeout(resolve, 20));
    await write(path, content);
  };
  await provideTestService('fs', fs);
  await applyTestPlugin(createTaskRuntimePlugin());
  const task = runtime.reflect.get('task') as TaskRuntimeService;
  await task.ready;

  const firstSave = task.setModelSelection('opencode-go', 'slow-model');
  await new Promise(resolve => setTimeout(resolve, 0));
  const lastSave = task.setModelSelection('opencode-go', 'remembered-model');
  await Promise.all([firstSave, lastSave]);

  const restored = await new HarnessTaskStore(fs).load();
  assert.ok(restored.tasks.every(item => item.llm.model === 'remembered-model'));
});

test('task runtime clears a ghost running status after the sandbox restarts', async () => {
  const fs = fakeFs({
    '.harness/sessions/index.json': JSON.stringify({ activeTaskId: 'interrupted', taskIds: ['interrupted'] }),
    '.harness/sessions/interrupted/meta.json': JSON.stringify({
      id: 'interrupted', title: 'Interrupted task', status: 'running',
      llm: { model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high' },
      capabilityIds: [], createdAt: 1, updatedAt: 1,
    }),
    '.harness/sessions/interrupted/checkpoint.json': JSON.stringify({
      taskId: 'interrupted', messages: [{ role: 'user', text: 'keep this prompt' }], savedAt: 1,
    }),
  });
  await provideTestService('fs', fs);
  await applyTestPlugin(createTaskRuntimePlugin());
  const task = runtime.reflect.get('task') as TaskRuntimeService;
  await task.ready;

  assert.equal(task.activeTask()?.status, 'idle');
  assert.equal(task.messages[0]?.text, 'keep this prompt');
  assert.match(fs.read('.harness/tasks.json')!, /"type":"task\/run-interrupted"/);
});

test('task runtime rejects switching and clearing during a run, then clears durably after stop', async () => {
  const fs = fakeFs({ 'keep.txt': 'user content' });
  await provideTestService('fs', fs);
  await applyTestPlugin(createTaskRuntimePlugin());
  const task = runtime.task;
  await task.ready;
  const first = task.activeTask()!.id;
  task.messages.push({ role: 'user', text: 'keep until cleared' });
  const controller = new AbortController();
  await task.beginRun(controller);
  assert.equal(task.signal, controller.signal);
  await assert.rejects(task.createTask('Forbidden'), /Stop the active run/);
  await assert.rejects(task.clearConversation(), /Stop the active run/);
  controller.abort();
  await task.endRun();
  assert.equal(task.signal, undefined);
  await task.clearConversation();
  assert.deepEqual(task.messages, []);
  assert.deepEqual((await new HarnessTaskStore(fs).load()).checkpoints[first], []);
  assert.equal(fs.read('keep.txt'), 'user content');
});

test('a failed snapshot rolls back visible task changes and leaves durable state intact', async () => {
  const fs = fakeFs();
  await provideTestService('fs', fs);
  await applyTestPlugin(createTaskRuntimePlugin());
  await runtime.task.ready;
  const id = runtime.task.activeTask()!.id;
  const activeTaskId = runtime.task.activeTaskId;
  const scope = runtime.task.scope();
  const previous = fs.read('.harness/tasks.json');
  const write = fs.write;
  fs.write = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(runtime.task.renameTask(id, 'Lost edit'), /storage unavailable/);
  assert.equal(runtime.task.activeTask()?.title, 'New task');
  await assert.rejects(runtime.task.createTask('Unsaved task'), /storage unavailable/);
  assert.equal(activeTaskId.value, id);
  assert.equal(runtime.task.tasks.length, 1);
  assert.equal(runtime.task.scope(), scope);
  assert.equal(fs.read('.harness/tasks.json'), previous);
  fs.write = write;
  await runtime.task.renameTask(id, 'Saved edit');
  assert.equal((await new HarnessTaskStore(fs).load()).tasks[0]?.title, 'Saved edit');
  const created = await runtime.task.createTask('Saved task');
  assert.equal(activeTaskId.value, created.id);
  assert.equal((await new HarnessTaskStore(fs).load()).activeTaskId, created.id);
});

test('a pending task transition cannot race another transition or run', async () => {
  const fs = fakeFs();
  await provideTestService('fs', fs);
  await applyTestPlugin(createTaskRuntimePlugin());
  await runtime.task.ready;
  const pending = runtime.task.createTask('Next');
  await assert.rejects(runtime.task.createTask('Race'), /transition/);
  await assert.rejects(runtime.task.beginRun(new AbortController()), /transition/);
  await pending;
  assert.equal(runtime.task.activeTask()?.title, 'Next');
  assert.equal(runtime.task.scope().fiber.name, `task:${runtime.task.activeTask()!.id}`);
});
