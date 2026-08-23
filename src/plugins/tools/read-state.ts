import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';

export const name = 'read-state';
export const inject = ['state', 'tools', 'prompt'];

export function apply(ctx: Context): void {
  ctx.tools.register({
    name: 'read_state',
    description: 'Read live state exposed by a contributed Vue UI. Without arguments, list readable UI and keys. With a name, read its current JSON state.',
    parameters: z.object({
      name: z.string().min(1).describe('Plugin name; omit to list all readable state.').optional(),
    }),
    run({ name: pluginName }) {
      if (!pluginName) {
        const all = ctx.state.list();
        return all.length ? JSON.stringify(all) : 'no plugin currently exposes readable state';
      }
      return ctx.state.read(pluginName);
    },
  });
  ctx.prompt.register({
    name: 'read-state',
    order: 35,
    text: () => {
      const all = ctx.state.list();
      return all.length
        ? `Plugins expose live readable UI state (read it with read_state): ${all.map(entry => `${entry.name} {${entry.keys.join(', ')}}`).join('; ')}.`
        : '';
    },
  });
}

export default { name, inject, apply };
