import type { Context, Plugin } from '@deepseek-ai/cordis';
import { z } from 'zod';

const STATE_LIMIT = 8000;

export function serializeState(value: unknown, limit = STATE_LIMIT): string {
  try {
    const json = JSON.stringify(value) ?? '{}';
    return json.length > limit ? json.slice(0, limit) + ` …(truncated, ${json.length} chars total)` : json;
  } catch (error) {
    return `Error: state is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export default {
  name: 'read-state',
  inject: ['ui', 'tools', 'prompt'],
  apply(ctx: Context): void {
    ctx.tools.register({
      name: 'read_state',
      description: 'Read live state exposed by a contributed Vue UI. Without arguments, list readable UI and keys. With a name, read its current JSON state.',
      parameters: z.object({
        name: z.string().min(1).describe('Plugin name; omit to list all readable state.').optional(),
      }),
      run({ name: pluginName }) {
        const all = ctx.ui.listState();
        if (!pluginName) {
          return all.length ? JSON.stringify(all) : 'no plugin currently exposes readable state';
        }
        const state = ctx.ui.readState(pluginName);
        return state ? serializeState(state) : `Error: plugin ${pluginName} exposes no state (currently exposing: ${all.map(entry => entry.name).join(', ') || 'none'})`;
      },
    });
    ctx.prompt.register({
      name: 'read-state',
      order: 35,
      text: () => {
        const all = ctx.ui.listState();
        return all.length
          ? `Plugins expose live readable UI state (read it with read_state): ${all.map(entry => `${entry.name} {${entry.keys.join(', ')}}`).join('; ')}.`
          : '';
      },
    });
  },
} satisfies Plugin.Object;
