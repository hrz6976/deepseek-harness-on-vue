import type { Context, Plugin } from '@deepseek-ai/cordis';
import { z } from 'zod';

export default {
  name: 'remove-plugin',
  inject: ['manager', 'tools'],
  apply(ctx: Context): void {
    ctx.tools.register({
      name: 'remove_plugin',
      description: 'Dispose a plugin Fiber and delete its .plugins/ source, reclaiming its services, tools, UI, prompt sections, listeners, watchers, and effects. A shipped plugin is reseeded on the next factory boot.',
      parameters: z.object({ name: z.string().min(1) }),
      run: ({ name: pluginName }) => ctx.manager.remove(pluginName),
    });
  },
} satisfies Plugin.Object;
