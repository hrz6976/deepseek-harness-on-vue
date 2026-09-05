import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarnessRuntime } from '@/kernel/runtime-supervisor';
import { capabilities } from '@/kernel/capabilities';
import { emptyTaskDatabase } from '@/kernel/task-store';
import { normalizeSessionLlmConfig } from '@/shared/task-model';

test('startup restores attached plugins without deadlocking task readiness against manager bootstrap', async () => {
  const state = emptyTaskDatabase();
  state.activeTaskId = 'existing';
  state.tasks.push({ id: 'existing', title: 'Existing', status: 'idle', capabilityIds: ['restored'], llm: normalizeSessionLlmConfig(), createdAt: 1, updatedAt: 1 });
  const files = new Map([
    ['.harness/tasks.json', JSON.stringify(state)],
    ['.plugins/restored.js', 'export default { apply() {} };'],
  ]);
  const running = startHarnessRuntime({ defaults: {}, infrastructure: [{
    name: 'workspace', apply(ctx) { ctx.provide('fs', {
      ready: Promise.resolve(), read: (path: string) => files.get(path) ?? null, list: () => [...files.keys()],
      async write(path: string, source: string) { files.set(path, source); }, async remove(path: string) { files.delete(path); },
    }); },
  }] });
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([running.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('startup deadlocked')), 1000); })]);
    assert.equal(capabilities.get('restored')?.status, 'active');
    assert.equal(capabilities.get('restored')?.fiber?.parent.fiber.name, 'task:existing');
  } finally { clearTimeout(timer!); }
});
