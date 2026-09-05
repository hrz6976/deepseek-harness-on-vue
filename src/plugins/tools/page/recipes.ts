import type { Context } from '@deepseek-ai/cordis';
import type { SiteRecipe, SiteSkill, SiteUserScript } from '@/shared/page-protocol';
import { recipeParameters, idParameters, recipeGetParameters, emptyParameters } from './schemas';

const recipeDescription = 'Install or update an explicitly approved page plugin. Never call this as a diagnostic workaround or after a read-only list/get request. Use type recipe for declarative DOM changes or type userscript for persistent USER_SCRIPT code. An enabled userscript is registered and hot-applied to the current document before this call returns; later matching navigations in the same agent run use the updated registration. Userscript source must be idempotent. Userscripts can use fetch for same-origin and cross-origin http(s) requests.';

export function registerRecipesTools(ctx: Context): void {
  ctx.tools.register({
    name: 'page_recipe_save',
    description: recipeDescription,
    parameters: recipeParameters,
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
      const saved = await ctx.broker.request({ provider: 'site-skill', action: 'save', input: { skill } });
      if (type !== 'userscript' || !enabled) return JSON.stringify(saved);
      const result = await ctx.broker.request({ provider: 'site-skill', action: 'apply', input: { id: common.id } });
      return JSON.stringify({
        saved,
        hotAppliedToCurrentDocument: true,
        result,
      });
    },
  });

  ctx.tools.register({
    name: 'page_recipe_list',
    description: 'List persisted page plugins, including declarative recipes and userscripts.',
    parameters: emptyParameters,
    run: async () => JSON.stringify(await ctx.broker.request({ provider: 'site-skill', action: 'list', input: {} }))
  });

  ctx.tools.register({
    name: 'page_recipe_debug',
    description: 'Read the persisted recipe and Chrome userScripts registration state for one id, including source hashes, exact registration count, and stale Harness ids. Use this before attributing behavior to stale registration. This tool is strictly read-only.',
    parameters: idParameters,
    run: async ({ id }) => JSON.stringify(await ctx.broker.request({ provider: 'site-skill', action: 'inspect', input: { id } }), null, 2),
  });

  ctx.tools.register({
    name: 'page_recipe_get',
    description: 'Read one persisted page plugin by id. Returns a bounded character window of its userscript source or declarative definition; continue with nextOffset instead of searching Harness checkpoints or artifacts.',
    parameters: recipeGetParameters,
    async run({ id, offset, limit }) {
      const value = await ctx.broker.request({ provider: 'site-skill', action: 'list', input: {} });
      const skill = Array.isArray(value)
        ? (value as unknown as SiteSkill[]).find(candidate => candidate.id === id)
        : undefined;
      if (!skill) return `Error: page plugin "${id}" does not exist`;

      const isUserScript = skill.type === 'userscript';
      const contentKind = isUserScript ? 'userscript source' : 'declarative definition';
      const content = isUserScript
        ? skill.source
        : JSON.stringify({ operations: skill.operations ?? [], liveRules: skill.liveRules ?? [] }, null, 2);
      const start = Math.min(offset, content.length);
      const chunk = content.slice(start, start + limit);
      const nextOffset = start + chunk.length < content.length ? start + chunk.length : null;
      return [
        `page plugin: ${skill.name}`,
        `id: ${skill.id}`,
        `type: ${skill.type}`,
        `enabled: ${skill.enabled}`,
        ...(isUserScript ? [`runAt: ${skill.runAt}`] : []),
        `content: ${contentKind}`,
        `offset: ${start}`,
        `totalCharacters: ${content.length}`,
        `nextOffset: ${nextOffset ?? 'none'}`,
        '--- content ---',
        chunk,
      ].join('\n');
    },
  });

  ctx.tools.register({
    name: 'page_recipe_remove',
    description: 'Remove a persisted page plugin by id only when the current user message explicitly authorizes that removal. Never remove and recreate a recipe to diagnose suspected caching.',
    parameters: idParameters,
    run: async ({ id }) => JSON.stringify(await ctx.broker.request({ provider: 'site-skill', action: 'remove', input: { id } }))
  });
}
