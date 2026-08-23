import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computed } from 'vue';
import { useSandboxInspector } from '@/extension/sandbox-inspector';
import type { TaskRuntimeService } from '@/shared/runtime';

test('task drawer derives resource counts without removed TaskSession fields', async () => {
  const task = { id: 'task-1', title: 'Visible task', status: 'idle', capabilityIds: [], createdAt: 1, updatedAt: 1 };
  const service = {
    tasks: [task], contexts: [{ taskId: task.id }, { taskId: 'other' }],
    artifacts: [{ taskId: task.id }, { taskId: task.id }],
  } as unknown as TaskRuntimeService;
  const inspector = useSandboxInspector(
    computed(() => service), computed(() => null), computed(() => null), computed(() => null),
    async () => null, () => {}, () => {},
  );

  assert.deepEqual(inspector.taskRows.value.map(row => [row.task.title, row.contextCount, row.artifactCount]), [
    ['Visible task', 1, 2],
  ]);
  const template = await readFile(new URL('../src/extension/sandbox-app.html', import.meta.url), 'utf8');
  assert.match(template, /@click="createTask">新建任务/);
  assert.doesNotMatch(template, /task\.(?:contextIds|artifactIds)/);
});
