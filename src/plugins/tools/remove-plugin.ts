import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';

export const name = 'remove-plugin';
export const inject = ['manager', 'tools'];

export function apply(ctx: Context): void {
  ctx.tools.register({
    name: 'remove_plugin',
    description: 'Dispose a plugin Fiber and delete its .plugins/ source, reclaiming its services, tools, UI, prompt sections, listeners, watchers, and effects. A shipped plugin is reseeded on the next factory boot.',
    parameters: z.object({ name: z.string().min(1) }),
    run: ({ name: pluginName }) => ctx.manager.remove(pluginName),
  });
}

export default { name, inject, apply };
