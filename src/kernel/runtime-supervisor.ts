import type { Context, Plugin } from '@deepseek-ai/cordis';
import { createSystemPlugin, fiberStatus, runtime } from '@/kernel/cordis';
import { createManagerPlugin } from '@/plugins/manager';
import promptPlugin from '@/plugins/prompt';
import { createTaskRuntimePlugin } from '@/plugins/task-runtime';
import toolsPlugin from '@/plugins/tools';
import loopPlugin from '@/plugins/loop';
import uiKernelPlugin from '@/kernel/ui';
import { SYSTEM_PLUGIN_NAMES } from './system-plugin-names';
import type { PluginDefaults } from '@/shared/runtime';

export interface HarnessRuntimeProfile {
  defaults: PluginDefaults;
  infrastructure: Plugin.Object[];
  requiredServices?: string[];
  taskScope?: string;
  search?: string;
}

export interface RunningHarnessRuntime {
  ready: Promise<void>;
  shellContext: Promise<Context>;
}

let running: RunningHarnessRuntime | null = null;

export function startHarnessRuntime(profile: HarnessRuntimeProfile): RunningHarnessRuntime {
  if (running) return running;
  let resolveShell!: (ctx: Context) => void;
  const shellContext = new Promise<Context>(resolve => { resolveShell = resolve; });
  const ready = new Promise<void>((resolve, reject) => {
    const kernel = createSystemPlugin('shell', {
      apply(ctx) {
        // Missing injections initially settle as PENDING. Later failures must
        // also reject startup instead of leaving the ready barrier waiting.
        ctx.on('internal/status', fiber => {
          if (fiber.parent.fiber === ctx.fiber && fiberStatus(fiber) === 'failed') {
            void fiber.await().catch(reject);
          }
        });
        const children: PromiseLike<unknown>[] = [];
        const reservedNames = [...SYSTEM_PLUGIN_NAMES, ...profile.infrastructure.map(pluginName)];
        const mount = (plugin: Plugin.Object) => {
          children.push(ctx.plugin(createSystemPlugin(pluginName(plugin), plugin)));
        };
        for (const plugin of [
          ...profile.infrastructure, uiKernelPlugin, toolsPlugin, promptPlugin,
          createTaskRuntimePlugin(profile.taskScope), loopPlugin,
          createManagerPlugin({ defaults: profile.defaults, search: profile.search, reservedNames }),
        ]) mount(plugin);
        const startup = [...children];
        mount({
          name: 'ready',
          inject: [...new Set(['fs', 'ui', 'tools', 'prompt', 'task', 'loop', 'manager', ...(profile.requiredServices ?? [])])],
          async apply(readyContext) {
            await Promise.all([readyContext.fs.ready, readyContext.task.ready]);
            // Await again after injection resolves: PENDING alone is not ready.
            await Promise.all(startup);
            resolve();
          },
        });
        void Promise.all(children).catch(reject);
      },
    }, resolveShell);
    void Promise.resolve(runtime.plugin(kernel)).catch(reject);
  });
  return running = { ready, shellContext };
}

function pluginName(plugin: Plugin.Object): string {
  if (!plugin.name) throw new Error('System plugins must declare a stable name.');
  return plugin.name;
}
