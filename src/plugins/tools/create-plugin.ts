import type { Context, Plugin } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { CapabilityManifestSchema } from '@/sdk';

const RECIPE = `Use create_plugin to build and immediately load a Cordis capability in the Harness sandbox. A capability may register tools, prompts, services, event listeners, effects, and Vue UI. Its manifest defines broker-scoped authority but cannot bypass the trusted broker; capability code cannot access the host DOM directly, so page access must use broker-backed operations. Generated capabilities default to task scope, persist in the virtual workspace, and reload through HMR.

import { z } from 'zod';

export default {
  name: 'my-plugin',
  inject: ['tools', 'ui'],
  apply(ctx) {
    ctx.tools.register({
      name: 'dice',
      description: 'Roll an N-sided die',
      parameters: z.object({ sides: z.number().int().positive().default(6) }),
      run: ({ sides }) => String(1 + Math.floor(Math.random() * sides)),
    });
    ctx.ui.register({
      name: 'dice-panel', region: 'main', order: 50,
      component: { template: '<section>Dice ready</section>' },
    });
  },
}

Rules:
- When the user asks to create a capability, call create_plugin in the current turn; do not merely write a file or artifact.
- Export a native Cordis object with name, inject, and apply(ctx). Declare every required service in inject and register contributions explicitly through ctx.tools, ctx.prompt, ctx.ui, or ctx.provide.
- Include real Vue UI through ctx.ui.register when the user expects a visible surface. Tool-only capabilities intentionally have no panel.
- Cordis owns registered contributions, listeners, timers, watchers, and nested plugins through the calling Fiber; register cleanup with ctx.effect when needed. Use typed ctx.on/emit/waterfall events to coordinate capabilities instead of cross-importing them.
- Request only the broker providers and permissions actually needed: page uses page.read/page.interact/page.modify/page.eval; workspace uses workspace.read/workspace.write; site-skill uses site-skill.read/site-skill.manage; storage uses storage.read/storage.write; llm uses llm.use; mcp uses mcp.connect/mcp.use; web uses web.read.
- Dynamic imports are limited to vue, zod, @deepseek-ai/cordis, the model SDK, and @harness/sdk. Kernel and runtime internals are private.
- Remove a capability with remove_plugin.`;

const parameters = z.object({
  name: z.string()
    .regex(/^[a-z][a-z0-9_-]*$/iu, 'plugin name must start with a letter and contain only letters, digits, - or _')
    .describe('Plugin name: letter first, then letters, digits, - or _.'),
  source: z.string().min(1).describe('ESM source with named name/inject/apply exports or a default Cordis plugin.'),
  manifest: CapabilityManifestSchema
    .describe('Optional CapabilityManifest. id must equal name. Omit for an auto-generated task-scope manifest.')
    .optional(),
});

export default {
  name: 'create-plugin',
  inject: ['tools', 'prompt', 'manager'],
  apply(ctx: Context): void {
    const description = 'Create and immediately load a sandbox-side Cordis plugin. It can explicitly register tools, prompts, services, event listeners, effects, and Vue UI. It cannot access the host DOM directly; declared page authority still goes through the trusted broker. Source persists to OPFS and auto-restores after refresh.';

    ctx.tools.register({
      name: 'create_plugin',
      description,
      parameters,
      async run({ name: pluginName, source, manifest }) {
        return ctx.manager.create(pluginName, source, manifest);
      },
    });
    ctx.prompt.register({ name: 'create-plugin', order: 30, text: RECIPE });
  },
} satisfies Plugin.Object;
