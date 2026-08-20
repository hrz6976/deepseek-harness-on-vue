// create_plugin tool plugin — the self-modifying entry point. Carries the
// plugin-authoring recipe as its own prompt section: the recipe travels WITH
// the capability (unmount this plugin and the model no longer sees it).
// Note how short the recipe is vs the PoC's: declarative contributions
// removed all disposer discipline from the agent's job.
import { services } from '../../kernel/services.js';

const RECIPE = `You can build yourself new capabilities with create_plugin (self-modifying). A plugin is a Vue component object; its source is persisted and auto-restored after refresh, and editing .plugins/<name>.js triggers hot reload. Dialect (STRICT): exactly one \`export default {...}\`, NO import statements, NO top-level await.

export default {
  name: 'my-plugin',
  // optional UI panel, rendered in the Plugins area; omit template for a pure-logic plugin
  template: \`<div>
    <AgentTool name="dice" description="Roll an N-sided die" :parameters="params" :run="roll" />
    <PromptSection name="dice" :order="60" text="You have a dice tool." />
    rolled: {{ last }}
  </div>\`,
  setup(props, ctx) {
    const { ref } = __harness.Vue;              // Vue API: ref, computed, watch, ...
    const params = { type: 'object', properties: { sides: { type: 'number' } } };
    const last = ref(0);
    const roll = ({ sides = 6 }) => String(last.value = 1 + Math.floor(Math.random() * sides));
    ctx.expose({ last });                       // agent-readable state: read back via read_state
    return { params, last, roll };              // template bindings
  },
}

Key points:
- <AgentTool> / <PromptSection> in the template register a model-callable tool / a system-prompt fragment. Mounting registers, unmounting cleans up — no manual disposal needed, ever. v-if on them is a live feature toggle. Duplicate names across plugins throw.
- State the user can change through your UI (game boards, scores, form inputs, toggles) should be exposed with ctx.expose({ board, score }) so you can read it back with read_state at any later turn — that is how you observe what the user did in your UI. Un-exposed state is invisible to you.
- Services: __harness.useService('fs'|'tools'|'llm'|'loop'|'manager'|'layout') returns a computed; read .value at use time.
- Intercept agent behavior: __harness.useToolGuard(req => req.name === 'run_js' ? 'not allowed' : null) vetoes tool calls; __harness.useBusOn('tools/post-execute', fn) observes. All auto-removed on unmount.
- Remove a plugin with remove_plugin.`;

export const createPluginPlugin = {
  name: 'tool:create-plugin',
  template: `
    <AgentTool name="create_plugin" :description="description" :parameters="parameters" :run="run" />
    <PromptSection name="create-plugin" :order="30" :text="recipe" />
  `,
  setup() {
    const description = 'Create and immediately load a new plugin (self-modifying): a Vue component object, runtime-compiled and mounted. It can register new tools, render a UI panel, contribute prompt sections, and listen to events. Source persists to OPFS and auto-restores after refresh; editing its source file triggers hot reload (HMR).';
    const parameters = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'plugin name: letter first, then letters/digits/-/_' },
        source: { type: 'string', description: 'ESM source, export default a component object { name?, template?, setup() {} }' },
      },
      required: ['name', 'source'],
    };
    async function run({ name, source }) {
      const mgr = services.get('manager')?.value;
      if (!mgr) return 'Error: manager service not ready';
      return await mgr.create(name, String(source ?? ''));
    }
    return { description, parameters, recipe: RECIPE, run };
  },
};
