// tools: the model-callable tool SERVICE — schemas, live dispatch, and the
// per-request snapshot. Registration happens through the kernel contribution
// ABI (<AgentTool> / useTool in kernel/contrib.js) into the kernel's 'tool'
// collector; this plugin owns only the dispatch policy over it, and is
// therefore safely reloadable: remounting swaps the policy while every
// registered tool survives in the kernel collector.
import { onUnmounted, getCurrentInstance } from 'vue';
import { getCollector } from '../kernel/collector';
import { provideService } from '../kernel/services';
import { log } from '../kernel/log';
import type { JsonObject, ToolDefinition, ToolSchema } from '../shared/runtime';
import { errorMessage } from '../shared/runtime';

const tools = getCollector<ToolDefinition>('tool');

function callWith(map: ReadonlyMap<string, ToolDefinition>) {
  return async (name: string, args: JsonObject): Promise<unknown> => {
    const t = map.get(name);
    if (!t) return `Error: tool ${name} does not exist (available: ${[...map.keys()].join(', ') || 'none'})`;
    try { return await t.run(args ?? {}); } catch (error: unknown) { return `Error: ${errorMessage(error)}`; }
  };
}
const schemasOf = (map: ReadonlyMap<string, ToolDefinition>): ToolSchema[] => [...map.entries()]
  .map(([name, tool]) => ({ name, description: tool.description, parameters: tool.parameters }));

export const toolsPlugin = {
  name: 'tools',
  setup() {
    provideService('tools', {
      schemas: () => schemasOf(tools.snapshot()),
      call: async (name: string, args: JsonObject) => callWith(tools.snapshot())(name, args), // live dispatch; loop uses snapshot() instead
      // Per-request snapshot: the loop freezes schemas + dispatch table at
      // llm/request time, so HMR or a v-if removing a tool mid-turn cannot
      // race the model's selection of it.
      snapshot() {
        const frozen = tools.snapshot();
        return { schemas: schemasOf(frozen), call: callWith(frozen) };
      },
    });
    if (getCurrentInstance()) onUnmounted(() => log('tools plugin unmounted', 'warn'));
    return () => null;
  },
};

export default toolsPlugin;
