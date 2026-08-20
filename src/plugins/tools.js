// tools: model-callable tool registry with two equal-citizen faces over one
// name-keyed collector —
//   declarative: <AgentTool name=".." :description=".." :parameters=".." :run="fn" />
//     mount = register, unmount = dispose; v-if is a live feature toggle
//   composable:  useTool(def)   for logic-only plugins
// Model-facing prose travels in PROPS, never slot text (vnode-walking cannot
// extract {{ interpolation }} — ensemble-verified).
import { onUnmounted } from 'vue';
import { createCollector } from '../kernel/collector.js';
import { provideService } from '../kernel/services.js';
import { log } from '../kernel/log.js';

const tools = createCollector('tool');

export function useTool(def) {
  const { name, description, parameters, run } = def;
  if (typeof run !== 'function') throw new Error(`tool "${name}" needs a run function`);
  return tools.add(name, { description, parameters, run });
}

export const AgentTool = {
  name: 'AgentTool',
  props: {
    name: { type: String, required: true },
    description: { type: String, required: true },
    parameters: { type: Object, required: true }, // plain JSON Schema; pi-ai's typebox accepts it structurally
    run: { type: Function, required: true },
  },
  setup(props) {
    useTool(props); // props are reactive-shallow; contribution identity is fixed at mount, remount to change
    return () => null;
  },
};

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
