// Contribution ABI — the stable glue between plugins: the declarative
// components (<AgentTool>, <PromptSection>), their composable twins, and the
// layout-target helper. Kernel-owned so the ABI outlives any plugin reload:
// tools.js / prompt.js provide the SERVICES (dispatch/assembly policy) and
// are agent-editable, but the registration channel itself must not be — a
// channel re-created by a reloading module would orphan every other plugin's
// contributions. Same reason the collectors live in kernel/collector.js's
// keyed registry rather than at plugin-module scope.
import { computed } from 'vue';
import { getCollector } from './collector.js';
import { useService } from './services.js';

// ---- tools ------------------------------------------------------------------
export function useTool(def) {
  const { name, description, parameters, run } = def;
  if (typeof run !== 'function') throw new Error(`tool "${name}" needs a run function`);
  return getCollector('tool').add(name, { description, parameters, run });
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

// ---- prompt sections --------------------------------------------------------
export function usePromptSection(def) {
  const { name, order = 50, text } = def;
  return getCollector('prompt section').add(name, { order, text });
}

export const PromptSection = {
  name: 'PromptSection',
  props: {
    name: { type: String, required: true },
    order: { type: Number, default: 50 },
    text: { type: [String, Function], required: true }, // prose in props, never slot text
  },
  setup(props) {
    usePromptSection(props);
    return () => null;
  },
};

// ---- layout -----------------------------------------------------------------
// No panel registry — a plugin's render output IS its panel; placement uses
// native <Teleport> into target ELEMENTS handed out by the layout service
// (never #id selectors: host-page id collisions are a Phase-2 hazard). The
// v-if on the target covers mount timing: the target element registers
// reactively when the layout frame mounts.
export function useLayoutTarget(region) {
  const layout = useService('layout');
  return computed(() => layout.value?.regions.get(region) ?? null);
}
