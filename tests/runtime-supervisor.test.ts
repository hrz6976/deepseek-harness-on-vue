import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '@/kernel/cordis';
import { startHarnessRuntime } from '@/kernel/runtime-supervisor';
import { fsPlugin } from '@/plugins/fs';

test('runtime readiness waits for every required Cordis service', async () => {
  const requiredServices = ['fs', 'modelProfiles', 'tools', 'prompt', 'loop', 'task'];
  const harness = startHarnessRuntime({
    defaults: {},
    infrastructure: [
      { name: 'workspace', plugin: fsPlugin },
      {
        name: 'delayed-profile-service',
        plugin: {
          name: 'delayed-profile-service',
          apply(ctx) {
            setTimeout(() => ctx.provide('modelProfiles', {}), 20);
          },
        },
      },
    ],
    requiredServices,
  });

  let ready = false;
  void harness.ready.then(() => { ready = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ready, false);

  await harness.ready;
  assert.deepEqual(requiredServices.filter(name => !runtime.reflect.get(name)), []);
});
