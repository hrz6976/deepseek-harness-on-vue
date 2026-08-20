// remove_plugin tool plugin.
import { services } from '../../kernel/services.js';

export const removePluginPlugin = {
  name: 'tool:remove-plugin',
  template: `<AgentTool name="remove_plugin" :description="description" :parameters="parameters" :run="run" />`,
  setup() {
    const description = 'Unmount a dynamic plugin the agent previously created, reclaiming ALL its effects (tools, UI, prompt sections, event listeners, timers)';
    const parameters = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    async function run({ name }) {
      const mgr = services.get('manager')?.value;
      if (!mgr) return 'Error: manager service not ready';
      return await mgr.remove(name);
    }
    return { description, parameters, run };
  },
};
