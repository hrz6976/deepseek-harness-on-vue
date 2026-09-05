import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarnessRuntime } from '@/kernel/runtime-supervisor';
import fsPlugin from '@/plugins/fs';

test('startup reports a system plugin that fails after waiting for an injection', async () => {
  const harness = startHarnessRuntime({
    defaults: {},
    requiredServices: ['modelProfiles'],
    infrastructure: [
      fsPlugin,
      {
        name: 'model-profiles', inject: ['release'],
        apply() { throw new Error('profile initialization failed'); },
      },
      {
        name: 'release',
        apply(ctx) {
          ctx.effect(() => {
            const timer = setTimeout(() => ctx.provide('release', {}), 0);
            return () => clearTimeout(timer);
          });
        },
      },
    ],
  });
  let timeout: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('startup did not report the system failure')), 500);
  });
  try {
    await assert.rejects(Promise.race([harness.ready, timedOut]), /profile initialization failed/);
  } finally {
    clearTimeout(timeout!);
    await (await harness.shellContext).fiber.dispose();
  }
});
