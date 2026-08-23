import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis';
import { boot } from '@/kernel/boot';
import { harnessRuntime } from '@/kernel/cordis';
import { managerPlugin } from '@/plugins/manager';
import { promptPlugin } from '@/plugins/prompt';
import { statePlugin } from '@/plugins/state';
import { createTaskRuntimePlugin } from '@/plugins/task-runtime';
import { toolsPlugin } from '@/plugins/tools';
import { loopPlugin } from '@/plugins/loop';
import { SYSTEM_PLUGIN_NAMES } from './system-plugin-names';
import type { PluginDefaults } from '@/shared/runtime';

export interface HarnessRuntimeProfile {
  defaults: PluginDefaults;
  infrastructure: Array<{ name: string; plugin: Plugin.Object }>;
  taskScope?: string;
  search?: string;
}

export interface RunningHarnessRuntime {
  ready: Promise<void>;
  shellContext: Promise<Context>;
  fibers: readonly Fiber[];
}

let running: RunningHarnessRuntime | null = null;

/**
 * Compose one sandbox runtime independently from Vue. Core registries and
 * provider adapters are system Fibers; OPFS capabilities still use the public
 * dynamic-plugin host and remain replaceable through HMR.
 */
export function startHarnessRuntime(profile: HarnessRuntimeProfile): RunningHarnessRuntime {
  if (running) return running;
  const fibers: Fiber[] = [];
  const activations: Promise<unknown>[] = [];
  const mount = (name: string, plugin: Plugin.Object) => {
    const handle = harnessRuntime.mountSystem(name, plugin);
    fibers.push(Object.getPrototypeOf(handle) as Fiber);
    activations.push(Promise.resolve(handle));
    return handle;
  };

  for (const item of profile.infrastructure) mount(item.name, item.plugin);
  const shellHandle = mount('shell', { name: 'kernel-shell', apply() {} });
  const shellContext = Promise.resolve(shellHandle).then(() => {
    const context = harnessRuntime.systemContext('shell');
    if (!context) throw new Error('Harness shell Context did not activate.');
    return context;
  });
  mount('tools', toolsPlugin);
  mount('prompt', promptPlugin);
  mount('manager', managerPlugin);
  mount('task-runtime', createTaskRuntimePlugin(profile.taskScope));
  mount('state', statePlugin);
  mount('loop', loopPlugin);

  let resolveBoot!: () => void;
  let rejectBoot!: (error: unknown) => void;
  const bootCompleted = new Promise<void>((resolve, reject) => {
    resolveBoot = resolve;
    rejectBoot = reject;
  });
  mount('boot', {
    name: 'kernel-boot',
    inject: ['fs'],
    apply(ctx) {
      void boot(profile.defaults, {
        ctx,
        search: profile.search,
        reservedNames: SYSTEM_PLUGIN_NAMES,
      }).then(resolveBoot, rejectBoot);
    },
  });

  // Every system Fiber has an activation promise. Await those lifecycle
  // signals directly instead of guessing how many seconds mounting may take.
  const ready = Promise.all([bootCompleted, ...activations]).then(() => undefined);

  running = { ready, shellContext, fibers };
  return running;
}
