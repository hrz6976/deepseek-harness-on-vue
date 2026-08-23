import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { HarnessTaskStore, stableCheckpointMessages } from '@/kernel/task-store';
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

test('task store restores task identity independently from page/tab state', async () => {
  const fs = fakeFs();
  let sequence = 0;
  const store = new HarnessTaskStore(fs, () => 1_700_000_000_000 + sequence, () => `id-${++sequence}`);
  const task = store.newTask('Research launch');
  const page = store.newContext(task.id, { kind: 'page', title: 'Product', locator: 'https://example.test/product', metadata: { tabId: 7 } });
  const file = store.newContext(task.id, { kind: 'file', title: 'brief.md', locator: 'brief.md' });
  const artifact = store.newArtifact(task.id, { kind: 'report', title: 'Launch report', source: { type: 'agent' }, status: 'ready', content: { summary: 'done' } });

  await store.persistTask(task);
  await store.persistContexts(task.id, [page, file]);
  await store.persistArtifact(artifact);
  await store.appendEvent(task.id, 'task/created', { title: task.title });
  await store.persistCheckpoint(task.id, [{ role: 'user', text: 'continue this task' }]);
  await store.persistIndex(task.id, [task]);

  const restoredStore = new HarnessTaskStore(fs);
  const restored = await restoredStore.load();
  assert.equal(restored.activeTaskId, task.id);
  assert.deepEqual(restored.tasks.map(item => item.title), ['Research launch']);
  assert.deepEqual(restored.contexts.map(item => item.kind), ['page', 'file']);
  assert.deepEqual(restored.artifacts.map(item => item.title), ['Launch report']);
  assert.match(fs.read(`.harness/sessions/${task.id}/events.jsonl`)!, /"sequence":1/);
  assert.equal(restoredStore.checkpointMessages(task.id)[0]?.role, 'user');
});

test('each page host has an isolated task list and artifact namespace', async () => {
  const fs = fakeFs();
  const github = new HarnessTaskStore(fs, () => 100, () => 'github-task', 'github.com');
  const yuri = new HarnessTaskStore(fs, () => 200, () => 'yuri-task', 'i-yuri.com');
  const githubTask = github.newTask('Review repository');
  const yuriTask = yuri.newTask('Adjust calendar');
  const githubArtifact = github.newArtifact(githubTask.id, {
    kind: 'report', title: 'GitHub report', source: { type: 'agent' },
  });
  const yuriArtifact = yuri.newArtifact(yuriTask.id, {
    kind: 'site-skill', title: 'YuriSeason skill', source: { type: 'agent' },
  });
  await github.persistTask(githubTask);
  await github.persistArtifact(githubArtifact);
  await github.persistIndex(githubTask.id, [githubTask]);
  await yuri.persistTask(yuriTask);
  await yuri.persistArtifact(yuriArtifact);
  await yuri.persistIndex(yuriTask.id, [yuriTask]);

  const restoredGithub = await new HarnessTaskStore(fs, undefined, undefined, 'github.com').load();
  const restoredYuri = await new HarnessTaskStore(fs, undefined, undefined, 'i-yuri.com').load();
  assert.deepEqual(restoredGithub.tasks.map(task => task.title), ['Review repository']);
  assert.deepEqual(restoredGithub.artifacts.map(artifact => artifact.title), ['GitHub report']);
  assert.deepEqual(restoredYuri.tasks.map(task => task.title), ['Adjust calendar']);
  assert.deepEqual(restoredYuri.artifacts.map(artifact => artifact.title), ['YuriSeason skill']);
  assert.ok(fs.list().some(path => path.startsWith('.harness/hosts/github.com/sessions/')));
  assert.ok(fs.list().some(path => path.startsWith('.harness/hosts/i-yuri.com/sessions/')));
});

test('task deletion removes the session and its artifact metadata', async () => {
  const fs = fakeFs({ 'keep.txt': 'keep' });
  let sequence = 0;
  const store = new HarnessTaskStore(fs, () => 1_700_000_000_000 + sequence, () => `id-${++sequence}`);
  const task = store.newTask('Disposable task');
  const context = store.newContext(task.id, { kind: 'file', title: 'brief.md', locator: 'brief.md' });
  const artifact = store.newArtifact(task.id, {
    kind: 'report',
    title: 'Disposable report',
    source: { type: 'agent' },
    status: 'ready',
    content: { summary: 'temporary' },
  });
  await store.persistTask(task);
  await store.persistContexts(task.id, [context]);
  await store.persistArtifact(artifact);
  await store.appendEvent(task.id, 'task/created');
  await store.persistCheckpoint(task.id, [{ role: 'user', text: 'temporary message' }]);

  await store.deleteTask(task.id);

  assert.equal(fs.list().some(path => path.startsWith(`.harness/sessions/${task.id}/`)), false);
  assert.equal(fs.list().some(path => path.startsWith(`.harness/artifacts/${artifact.id}/`)), false);
  assert.notEqual(fs.read(`.harness/tombstones/tasks/${task.id}.json`), null);
  assert.equal(fs.read('keep.txt'), 'keep');
  assert.deepEqual(store.checkpointMessages(task.id), []);
});

test('a deleted task cannot be resurrected by a stale runtime', async () => {
  const fs = fakeFs();
  let sequence = 0;
  const store = new HarnessTaskStore(fs, () => 1_700_000_000_000 + sequence, () => `id-${++sequence}`);
  const staleStore = new HarnessTaskStore(fs, () => 1_700_000_001_000 + sequence, () => `stale-${++sequence}`);
  const task = store.newTask('Do not restore me');
  await store.persistTask(task);
  await store.persistIndex(task.id, [task]);
  await staleStore.load();

  await store.deleteTask(task.id);
  await store.persistIndex(null, []);

  await assert.rejects(staleStore.persistTask({ ...task, title: 'Resurrected' }), /deleted in another Harness panel/);
  await staleStore.persistIndex(task.id, [task]);
  const restored = await new HarnessTaskStore(fs).load();
  assert.equal(restored.tasks.some(candidate => candidate.id === task.id), false);
  assert.equal(restored.activeTaskId, null);
});

test('task events are append-only JSONL records', async () => {
  const fs = fakeFs();
  let id = 0;
  const store = new HarnessTaskStore(fs, () => 100 + id, () => `event-${++id}`);
  await store.appendEvent('task-1', 'first');
  await store.appendEvent('task-1', 'second', { ok: true });
  const source = fs.read('.harness/sessions/task-1/events.jsonl')!;
  assert.equal(source.trim().split('\n').length, 2);
  assert.match(source, /"type":"first".*\n.*"type":"second"/s);
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
  const firstScope = task.scope();
  task.messages.push({ role: 'user', text: 'first conversation' });

  const second = await task.createTask('Second');
  const secondScope = task.scope();
  assert.equal(firstScope.fiber.uid, null);
  assert.deepEqual(task.messages, []);
  task.messages.push({ role: 'user', text: 'second conversation' });

  await task.activateTask(first.id);
  assert.equal(secondScope.fiber.uid, null);
  assert.equal(task.messages[0]?.text, 'first conversation');
  await task.activateTask(second.id);
  assert.equal(task.messages[0]?.text, 'second conversation');
});
