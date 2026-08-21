// remove_plugin tool plugin.
import { getService } from '../../kernel/services';

export const removePluginPlugin = {
  name: 'remove-plugin',
  template: `<AgentTool name="remove_plugin" :description="description" :parameters="parameters" :run="run" />`,
  setup() {
    const description = 'Unmount a plugin and delete its .plugins/ file, reclaiming ALL its effects (tools, UI, prompt sections, event listeners, timers). Works on agent-created and core plugins alike; a removed CORE plugin comes back at factory state on the next page refresh (reseeded). Careful: removing infrastructure you are using (loop, chat, this tool) breaks it immediately.';
    const parameters = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    async function run({ name }: { name: string }) {
      const mgr = getService('manager');
      if (!mgr) return 'Error: manager service not ready';
      return await mgr.remove(name);
    }
    return { description, parameters, run };
  },
};

export default removePluginPlugin;
