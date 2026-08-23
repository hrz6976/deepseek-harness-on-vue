import type { Context, Plugin } from '@deepseek-ai/cordis';
import { createSystemPlugin, runtime } from '@/kernel/cordis';
import { createManagerPlugin } from '@/plugins/manager';
import { promptPlugin } from '@/plugins/prompt';
import { createTaskRuntimePlugin } from '@/plugins/task-runtime';
import { toolsPlugin } from '@/plugins/tools';
import { loopPlugin } from '@/plugins/loop';
import { uiKernelPlugin } from '@/kernel/ui';
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
}

let running: RunningHarnessRuntime | null = null;

function harnessKernelPlugin(profile: HarnessRuntimeProfile): Plugin.Object {
  return {
    name: 'harness-kernel',
    apply(ctx) {
      const children: PromiseLike<unknown>[] = [];
      const reservedNames = [...SYSTEM_PLUGIN_NAMES, ...profile.infrastructure.map(item => item.name)];
      const mount = (name: string, plugin: Plugin.Object) => {
        children.push(ctx.plugin(createSystemPlugin(name, plugin)));
      };
      for (const item of profile.infrastructure) mount(item.name, item.plugin);
      for (const [name, plugin] of [
        ['ui', uiKernelPlugin], ['tools', toolsPlugin], ['prompt', promptPlugin],
        ['task-runtime', createTaskRuntimePlugin(profile.taskScope)], ['loop', loopPlugin],
        ['manager', createManagerPlugin({ defaults: profile.defaults, search: profile.search, reservedNames })],
      ] satisfies Array<[string, Plugin.Object]>) mount(name, plugin);
      return Promise.all(children).then(() => undefined);
    },
  };
}

export function startHarnessRuntime(profile: HarnessRuntimeProfile): RunningHarnessRuntime {
  if (running) return running;
  let resolveShell!: (ctx: Context) => void;
  const shellContext = new Promise<Context>(resolve => { resolveShell = resolve; });
  const kernel = createSystemPlugin('shell', harnessKernelPlugin(profile), resolveShell);
  const ready = Promise.resolve(runtime.plugin(kernel)).then(() => undefined);
  return running = { ready, shellContext };
}
