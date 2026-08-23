import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { CapabilityManifestSchema } from '@/sdk';

const RECIPE = `You can build task capabilities with create_plugin. A capability is a Cordis plugin running in the Harness sandbox. It may explicitly register tools, prompts, services, events, effects, workflows, and real Vue UI, but neither its code nor its CapabilityManifest grants trusted authority. Host-page access remains limited to page_* tools. Source, manifest, and versions persist under .harness/capabilities/<id>/ while .plugins/<id>.js remains the editable HMR entry. Generated capabilities default to task scope. Use injected services to share behavior; do not cross-import another plugin.

import { ref, defineComponent } from 'vue';
import { z } from 'zod';

export const name = 'my-plugin';
export const inject = ['tools', 'prompt', 'ui'];

export function apply(ctx) {
  const last = ref(0);
  const parameters = z.object({ sides: z.number().int().positive().default(6) });

  ctx.tools.register({
    name: 'dice',
    description: 'Roll an N-sided die',
    parameters,
    run: ({ sides = 6 }) => String(last.value = 1 + Math.floor(Math.random() * sides)),
  });
  ctx.prompt.register({ name: 'dice', order: 60, text: 'You have a dice tool.' });

  // Templates are for actual UI only; they are not a contribution manifest.
  ctx.ui.register({
    name: 'dice-panel',
    region: 'main',
    order: 50,
    component: defineComponent({
      name: 'DicePanel',
      template: '<div>Last roll: {{ last }}</div>',
      setup(_, { expose }) { expose({ last }); return { last }; },
    }),
  });

  ctx.on('task/reset', () => { last.value = 0; });
  // Host-page lifecycle is a typed Cordis event. Listening grants no DOM
  // authority; inspect or modify through broker-backed page_* tools.
  ctx.on('page/event', (event) => {
    if (event.type === 'page/route-changed') last.value = 0;
  });
}

Key points:
- Plugins are functions, classes, or objects with apply(ctx, config). Named name/inject/apply exports are the clearest authoring form.
- Register contributions explicitly through ctx.tools.register, ctx.prompt.register, and ctx.ui.register; include UI when the user expects a visible surface. Cordis binds every registration, listener, service, timer cleanup, and nested plugin to the calling Fiber.
- "Create a plugin" means call create_plugin in the current turn, not merely write a workspace file or artifact. Pure logic and tool-only plugins appear in the capability inspector but intentionally render no page surface.
- UI placement is declarative: use region ('main' or 'side') and order; the component must not Teleport into shell DOM.
- Declare required services in inject. A Fiber stays pending until they exist and is automatically restarted if a required service changes.
- Use ctx.provide(name, service), ctx.on/emit/waterfall, and ctx.effect for custom services, events, middleware, and resources.
- The trusted shell emits host lifecycle as ctx.on('page/event', listener). Vue setup code may import usePageEvent from @harness/sdk. Load page.dynamic and call page_observe_start when mutation events are actually needed; prefer declarative LiveRules for automatic future-node changes.
- Generated task manifests have no trusted provider grants. If code injects broker/fs/llm or manages capabilities, pass a declared manifest with the matching provider and permission: page.read/page.modify/page.interact, site-skill.read/site-skill.manage, workspace.read/workspace.write, llm.use, storage.read/storage.write, mcp.connect/mcp.use, or capability.manage.
- Dynamic imports are limited to vue, zod, @deepseek-ai/cordis, the model SDK, and @harness/sdk. Kernel/root/mount/compiler modules are private.
- Remove a capability with remove_plugin.`;

export const name = 'create-plugin';
export const inject = ['tools', 'prompt', 'manager'];

const parameters = z.object({
  name: z.string()
    .regex(/^[a-z][a-z0-9_-]*$/iu, 'plugin name must start with a letter and contain only letters, digits, - or _')
    .describe('Plugin name: letter first, then letters, digits, - or _.'),
  source: z.string().min(1).describe('ESM source with named name/inject/apply exports or a default Cordis plugin.'),
  manifest: CapabilityManifestSchema
    .describe('Optional CapabilityManifest. id must equal name. Omit for an auto-generated task-scope manifest.')
    .optional(),
});

export function apply(ctx: Context): void {
  const description = 'Create and immediately load a sandbox-side Cordis plugin. It can explicitly register tools, prompts, services, events, effects, workflows, and Vue UI. It cannot access or style the host page; use page_* tools for that. Source persists to OPFS and auto-restores after refresh.';

  ctx.tools.register({
    name: 'create_plugin',
    description,
    parameters,
    async run({ name: pluginName, source, manifest }) {
      return ctx.manager.create(pluginName, source, manifest);
    },
  });
  ctx.prompt.register({ name: 'create-plugin', order: 30, text: RECIPE });
}
