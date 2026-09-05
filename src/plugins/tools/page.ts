import type { Context, Plugin } from '@deepseek-ai/cordis';
import { registerInspectionTools } from './page/inspection';
import { registerInteractionTools } from './page/interaction';
import { registerPatchesTools } from './page/patches';
import { registerDynamicTools } from './page/dynamic';
import { registerRecipesTools } from './page/recipes';

export default {
  name: 'page',
  inject: ['tools', 'prompt', 'broker'],
  apply(ctx: Context): void {
    registerInspectionTools(ctx);
    registerInteractionTools(ctx);
    registerPatchesTools(ctx);
    registerDynamicTools(ctx);
    registerRecipesTools(ctx);
    ctx.prompt.register({
      name: 'page-tools',
      order: 10,
      text: `Treat element references as capabilities: obtain and preserve them from snapshots or queries. Use page_query_page for large result sets. After click or type, wait for the expected state and call page_settle before reading again.

For visual or CSS work, inspect the exact element and relevant ::before/::after state with page_style_inspect before changing it, then inspect the resulting computed style; never infer the cascade from class names alone. Preview non-trivial patches.

For DOM created or reconciled later, load the page.dynamic tool group with capability_load and prefer live rules for simple declarative behavior. Read existing persisted source with page_recipe_get and follow nextOffset for long results instead of searching Harness checkpoints or artifacts.`,
    });
  },
} satisfies Plugin.Object;
