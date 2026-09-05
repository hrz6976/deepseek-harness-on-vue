import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '@/kernel/cordis';
import { startHarnessRuntime } from '@/kernel/runtime-supervisor';
import { capabilities } from '@/kernel/capabilities';

test('runtime readiness waits for required services, workspace/task restoration, and capability bootstrap', async () => {
  let loadWorkspace!: () => void;
  let saveTask!: () => void;
  let provideProfiles!: () => void;
  const workspaceReady = new Promise<void>(resolve => { loadWorkspace = resolve; });
  const taskSaved = new Promise<void>(resolve => { saveTask = resolve; });
  const files = new Map<string, string>();
  const harness = startHarnessRuntime({
    defaults: { alpha: { source: 'export function apply() {}', autoMount: true } },
    infrastructure: [
      {
        name: 'workspace',
        apply(ctx) {
          ctx.provide('fs', {
            ready: workspaceReady, files,
            read: (path: string) => files.get(path) ?? null,
            list: () => [...files.keys()],
            async write(path: string, content: string) {
              await taskSaved;
              files.set(path, content);
            },
            async remove(path: string) { files.delete(path); },
          });
        },
      },
      {
        name: 'model-profiles',
        apply(ctx) { provideProfiles = () => { ctx.provide('modelProfiles', {}); }; },
      },
    ],
    requiredServices: ['modelProfiles'],
  });
  let ready = false;
  void harness.ready.then(() => { ready = true; });
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  await tick();
  assert.ok(runtime.get('task'), 'service registration alone is not readiness');
  assert.equal(ready, false);
  provideProfiles();
  await tick();
  assert.equal(ready, false, 'workspace still loading');
  loadWorkspace();
  await tick();
  assert.equal(ready, false, 'initial task still saving');
  saveTask();
  await harness.ready;
  assert.ok(runtime.task.activeTask());
  assert.equal(capabilities.get('alpha')?.status, 'active');
});
