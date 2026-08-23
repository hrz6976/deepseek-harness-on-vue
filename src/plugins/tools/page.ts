import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { ElementRefSchema, LiveRuleSchema, PatchOperationSchema } from '@/sdk';
import type { PageCommand, SiteRecipe, SiteSkill, SiteUserScript } from '@/shared/page-protocol';

async function request(ctx: Context, command: PageCommand): Promise<string> {
  const result = await ctx.broker.request({ provider: 'page', action: 'command', input: { command } });
  return JSON.stringify(result);
}

export const name = 'page';
export const inject = ['tools', 'prompt', 'broker'];

const operationSchema = PatchOperationSchema.describe(
  'A transactional DOM operation. Use targets returned by page_snapshot or page_query unchanged.',
);
const snapshotParameters = z.object({
  selector: z.string().describe('Optional CSS selector used as the snapshot root.').optional(),
  maxNodes: z.number().int().positive().max(10_000).describe('Maximum compressed nodes, default 600.').optional(),
  maxDepth: z.number().int().nonnegative().max(100).describe('Maximum tree depth, default 10.').optional(),
});
const queryParameters = z.object({
  selector: z.string().min(1),
  limit: z.number().int().positive().max(1_000).optional(),
});
const queryPageParameters = z.object({
  selector: z.string().min(1),
  offset: z.number().int().nonnegative().max(1_000_000).optional(),
  limit: z.number().int().positive().max(500).optional(),
});
const targetParameters = z.object({ target: ElementRefSchema });
const styleInspectParameters = targetParameters.extend({
  pseudo: z.enum(['::before', '::after']).describe('Inspect the selected pseudo-element instead of the element itself.').optional(),
  properties: z.array(z.string().trim().min(1).max(200)).max(100)
    .describe('Optional computed CSS properties. Omit to return every property enumerated by getComputedStyle(), including custom properties.').optional(),
  includeMatchedRules: z.boolean().default(true)
    .describe('Include matching rules from readable author stylesheets.'),
  maxRules: z.number().int().positive().max(200).default(100),
});
const typeParameters = z.object({
  target: ElementRefSchema,
  value: z.string().max(1_000_000),
  clear: z.boolean().default(true),
});
const scrollParameters = z.object({
  target: ElementRefSchema.optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  behavior: z.enum(['auto', 'smooth']).optional(),
});
const waitParameters = z.object({
  selector: z.string().min(1),
  state: z.enum(['attached', 'visible', 'hidden', 'detached']).optional(),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
});
const settleParameters = z.object({
  quietMs: z.number().int().nonnegative().max(5_000).optional(),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
});
const patchParameters = z.object({
  label: z.string().min(1),
  operations: z.array(operationSchema).max(1_000),
});
const revertParameters = z.object({ transactionId: z.string().min(1) });
const liveRulesParameters = z.object({ rules: z.array(LiveRuleSchema).min(1).max(500) });
const liveRulesInstallParameters = liveRulesParameters.extend({
  id: z.string().min(1).max(200).describe('Stable rule-set id used to replace or remove this temporary set.'),
  label: z.string().min(1).max(500),
});
const recipeParameters = z.object({
  type: z.enum(['recipe', 'userscript']).default('recipe'),
  id: z.string().min(1).describe('Existing recipe id when updating; omit to create.').optional(),
  name: z.string().min(1).max(200),
  matches: z.array(z.string().min(1)).min(1).max(100).describe('URL patterns such as https://example.com/*.'),
  operations: z.array(operationSchema).max(1_000).default([]),
  liveRules: z.array(LiveRuleSchema).max(500).default([]),
  source: z.string().min(1).max(1_000_000).optional(),
  runAt: z.enum(['document_start', 'document_end', 'document_idle']).default('document_idle'),
  enabled: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.type === 'userscript' && !value.source) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'A userscript needs source.' });
  }
  if (value.type === 'recipe' && !value.operations.length && !value.liveRules.length) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'A recipe needs at least one operation or live rule.' });
  }
  if (value.type === 'recipe' && value.source) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'Recipe source must use type userscript.' });
  }
});
const idParameters = z.object({ id: z.string().min(1) });
const emptyParameters = z.object({});
const scriptParameters = z.object({
  code: z.string().min(1).max(1_000_000),
  world: z.enum(['MAIN', 'USER_SCRIPT']).default('USER_SCRIPT'),
});
const PAGE_DYNAMIC_GROUP = {
  id: 'page.dynamic',
  title: 'Dynamic Page Rules',
  description: 'Observe DOM changes or keep declarative rules active for future matching nodes.',
  scope: 'task',
  tags: ['page', 'dom', 'mutation', 'live-rule'],
} as const;

export function apply(ctx: Context): void {

  const snapshotDescription = 'Read a compressed, framework-neutral DOM snapshot of the active page. Returns stable element references for later patches.';
  const queryDescription = 'Find elements in the active page with a CSS selector and return stable references and fingerprints.';
  const styleInspectDescription = 'Read all computed CSS properties, inline declarations, and matching author rules for a referenced element or its ::before/::after pseudo-element. This is a read-only core inspection and needs no approval.';
  const previewDescription = 'Validate a transactional DOM patch without changing the page. Always preview a non-trivial patch before applying it.';
  const applyDescription = 'Apply and verify a DOM adjustment as one undoable temporary transaction. Ordinary reversible patches need no separate confirmation; persistence still requires explicit approval.';
  const revertDescription = 'Undo an applied page patch by transaction id.';
  const recipeDescription = 'Install an approved page plugin. Use type recipe for declarative DOM changes or type userscript for persistent USER_SCRIPT code. Both reapply after matching navigations.';

  ctx.tools.register({ name: 'page_snapshot', description: snapshotDescription, parameters: snapshotParameters, run: ({ selector, maxNodes, maxDepth }) => request(ctx, { type: 'page/snapshot', options: { selector, maxNodes, maxDepth } }) });
  ctx.tools.register({ name: 'page_query', description: queryDescription, parameters: queryParameters, run: ({ selector, limit }) => request(ctx, { type: 'page/query', selector, limit }) });
  ctx.tools.register({ name: 'page_query_page', description: 'Query a large matching set one bounded page at a time.', parameters: queryPageParameters, run: ({ selector, offset, limit }) => request(ctx, { type: 'page/query-page', selector, offset, limit }) });
  ctx.tools.register({
    name: 'page_style_inspect', description: styleInspectDescription, parameters: styleInspectParameters,
    run: ({ target, pseudo, properties, includeMatchedRules, maxRules }) => request(ctx, {
      type: 'page/style-inspect', target, pseudo, properties, includeMatchedRules, maxRules,
    }),
  });
  ctx.tools.register({ name: 'page_click', description: 'Click a referenced page element through the trusted Page provider. Requires user approval.', parameters: targetParameters, run: ({ target }) => request(ctx, { type: 'page/click', target }) });
  ctx.tools.register({ name: 'page_type', description: 'Enter text into a referenced input or editable element through the trusted Page provider. Requires user approval.', parameters: typeParameters, run: ({ target, value, clear }) => request(ctx, { type: 'page/type', target, value, clear }) });
  ctx.tools.register({ name: 'page_scroll', description: 'Scroll the page or bring a referenced element into view.', parameters: scrollParameters, run: ({ target, x, y, behavior }) => request(ctx, { type: 'page/scroll', target, x, y, behavior }) });
  ctx.tools.register({ name: 'page_wait', description: 'Wait until a selector is attached, visible, hidden, or detached.', parameters: waitParameters, run: ({ selector, state, timeoutMs }) => request(ctx, { type: 'page/wait', selector, state, timeoutMs }) });
  ctx.tools.register({ name: 'page_settle', description: 'Wait for a quiet DOM interval after navigation or interaction.', parameters: settleParameters, run: ({ quietMs, timeoutMs }) => request(ctx, { type: 'page/settle', quietMs, timeoutMs }) });
  ctx.tools.register({ name: 'page_patch_preview', description: previewDescription, parameters: patchParameters, run: ({ label, operations }) => request(ctx, { type: 'page/patch-preview', label, operations }) });
  ctx.tools.register({ name: 'page_patch_apply', description: applyDescription, parameters: patchParameters, run: ({ label, operations }) => request(ctx, { type: 'page/patch-apply', label, operations }) });
  ctx.tools.register({ name: 'page_patch_revert', description: revertDescription, parameters: revertParameters, run: ({ transactionId }) => request(ctx, { type: 'page/patch-revert', transactionId }) });
  ctx.tools.register({ name: 'page_observe_start', description: 'Start publishing debounced DOM mutation events for the attached page.', parameters: emptyParameters, availability: PAGE_DYNAMIC_GROUP, run: () => request(ctx, { type: 'page/observe', enabled: true }) });
  ctx.tools.register({ name: 'page_observe_stop', description: 'Stop publishing page mutation events. Installed live rules remain active.', parameters: emptyParameters, availability: PAGE_DYNAMIC_GROUP, run: () => request(ctx, { type: 'page/observe', enabled: false }) });
  ctx.tools.register({ name: 'page_live_rules_preview', description: 'Validate declarative dynamic-page rules and report how many current elements match, without changing the page.', parameters: liveRulesParameters, availability: PAGE_DYNAMIC_GROUP, run: ({ rules }) => request(ctx, { type: 'page/live-rules-preview', rules }) });
  ctx.tools.register({ name: 'page_live_rules_apply', description: 'Install or replace one temporary declarative rule set. The trusted content runtime reapplies idempotent actions to current and future matching nodes.', parameters: liveRulesInstallParameters, availability: PAGE_DYNAMIC_GROUP, run: ({ id, label, rules }) => request(ctx, { type: 'page/live-rules-install', id, label, rules }) });
  ctx.tools.register({ name: 'page_live_rules_remove', description: 'Stop a temporary declarative live-rule set by id. Existing DOM changes are not reverted.', parameters: idParameters, availability: PAGE_DYNAMIC_GROUP, run: ({ id }) => request(ctx, { type: 'page/live-rules-remove', id }) });
  ctx.tools.register({ name: 'page_picker_start', description: 'Open the visual element picker so the user can click a page element and attach an annotation.', parameters: emptyParameters, run: () => request(ctx, { type: 'page/picker-start' }) });
  ctx.tools.register({ name: 'page_script_run', description: 'Execute one-off JavaScript in the trusted MAIN or USER_SCRIPT page world when typed page tools cannot express the required behavior. Arbitrary code still requires explicit user approval.', parameters: scriptParameters, run: ({ code, world }) => request(ctx, { type: 'page/eval', code, world }) });
  ctx.tools.register({
    name: 'page_recipe_save', description: recipeDescription, parameters: recipeParameters,
    async run({ type, id, name: recipeName, matches, operations, liveRules, source, runAt, enabled }) {
      const now = Date.now();
      const common = { id: id ?? crypto.randomUUID(), name: recipeName, matches, enabled, createdAt: now, updatedAt: now };
      const skill: SiteSkill = type === 'userscript'
        ? {
            ...common,
            type: 'userscript',
            runAt,
            source: source!,
          } satisfies SiteUserScript
        : {
            ...common,
            type: 'recipe',
            world: 'ISOLATED',
            ...(operations.length ? { operations } : {}),
            ...(liveRules.length ? { liveRules } : {}),
          } satisfies SiteRecipe;
      return JSON.stringify(await ctx.broker.request({ provider: 'site-skill', action: 'save', input: { skill } }));
    },
  });
  ctx.tools.register({ name: 'page_recipe_list', description: 'List persisted page plugins, including declarative recipes and userscripts.', parameters: emptyParameters, run: async () => JSON.stringify(await ctx.broker.request({ provider: 'site-skill', action: 'list', input: {} })) });
  ctx.tools.register({ name: 'page_recipe_remove', description: 'Remove a persisted page plugin by id.', parameters: idParameters, run: async ({ id }) => JSON.stringify(await ctx.broker.request({ provider: 'site-skill', action: 'remove', input: { id } })) });

  ctx.prompt.register({
    name: 'page-tools',
    order: 10,
    text: 'The host page is controlled only through framework-neutral page_* tools. Plugins and run_js never run in host DOM. Treat element references as capabilities: obtain and preserve them from snapshots/queries. For visual or CSS work, inspect the exact element and relevant ::before/::after state with page_style_inspect before changing it, then inspect the resulting computed style after applying; never infer the cascade from class names alone. Use page_query_page for large sets. After click/type, wait for an expected state and page_settle before reading again. Click/type cross the trusted approval boundary. Preview non-trivial patches. For DOM that is created or reconciled later, load the page.dynamic tool group with capability_load and use live rules for simple declarative changes. When actual page behavior or arbitrary DOM logic is required, use page_script_run and, after explicit approval, persist the same idempotent source through page_recipe_save with type userscript. Userscripts always use the browser USER_SCRIPT world. If Chrome reports that User Scripts are disabled, explain how to enable them once and do not retry with MAIN.',
  });
}
