// tools: the model-callable tool SERVICE — schemas, live dispatch, and the
// per-request snapshot. Registration happens through the kernel contribution
// ABI (<AgentTool> / useTool in kernel/contrib.js) into the kernel's 'tool'
// collector; this plugin owns only the dispatch policy over it, and is
// therefore safely reloadable: remounting swaps the policy while every
// registered tool survives in the kernel collector.
import { onUnmounted } from 'vue';
import { getCollector } from '../kernel/collector.js';
import { provideService } from '../kernel/services.js';
import { log } from '../kernel/log.js';

const tools = getCollector('tool');

function callWith(map) {
  return async (name, args) => {
    const t = map.get(name);
    if (!t) return `Error: tool ${name} does not exist (available: ${[...map.keys()].join(', ') || 'none'})`;
    try { return await t.run(args ?? {}); } catch (e) { return `Error: ${e.message}`; }
  };
}
const schemasOf = map => [...map.entries()].map(([name, t]) => ({ name, description: t.description, parameters: t.parameters }));

export const toolsPlugin = {
  name: 'tools',
  setup() {
    provideService('tools', {
      schemas: () => schemasOf(tools.snapshot()),
      call: async (name, args) => callWith(tools.snapshot())(name, args), // live dispatch; loop uses snapshot() instead
      // Per-request snapshot: the loop freezes schemas + dispatch table at
      // llm/request time, so HMR or a v-if removing a tool mid-turn cannot
      // race the model's selection of it.
      snapshot() {
        const frozen = tools.snapshot();
        return { schemas: schemasOf(frozen), call: callWith(frozen) };
      },
    });
    onUnmounted(() => log('tools plugin unmounted', 'warn'));
    return () => null;
  },
};
