// read_state tool plugin — the model's window into component state that
// plugins exposed via ctx.expose(). Pull-based on purpose: state costs tokens
// only when the model asks for it; discoverability comes from a function-
// typed prompt section (re-evaluated at request time by prompt.assemble), so
// the index is always current and vanishes entirely while nothing is exposed.
import { services } from '../../kernel/services.js';

export const readStatePlugin = {
  name: 'tool:read-state',
  template: `
    <AgentTool name="read_state" :description="description" :parameters="parameters" :run="run" />
    <PromptSection name="read-state" :order="35" :text="index" />
  `,
  setup() {
    const description = 'Read the live state a plugin exposed with ctx.expose(). Without arguments: list every readable plugin and its state keys. With a name: that plugin\'s current state as JSON. State is read at call time, so it reflects user interaction with the plugin UI since your last turn.';
    const parameters = {
      type: 'object',
      properties: { name: { type: 'string', description: 'plugin name; omit to list all readable state' } },
    };
    function run({ name } = {}) {
      const state = services.get('state')?.value;
      if (!state) return 'Error: state service not ready';
      if (!name) {
        const all = state.list();
        return all.length ? JSON.stringify(all) : 'no plugin currently exposes readable state';
      }
      return state.read(name);
    }
    const index = () => {
      const all = services.get('state')?.value?.list() ?? [];
      return all.length
        ? `Plugins expose live readable state (user interaction with their UI updates it; read it with read_state): ${all.map(e => `${e.name} {${e.keys.join(', ')}}`).join('; ')}.`
        : '';
    };
    return { description, parameters, run, index };
  },
};
