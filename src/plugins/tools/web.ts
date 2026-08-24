import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';

export const name = 'web';
export const inject = ['broker', 'tools', 'prompt'];

export function apply(ctx: Context): void {
  ctx.tools.register({
    name: 'web_search',
    description: 'Search the public web with the user\'s configured browser search provider and return bounded result titles, snippets, and source URLs. Use for current or external information that is not present on the attached page.',
    parameters: z.object({
      query: z.string().trim().min(1).max(500).describe('Focused search query. Include names, dates, or site: filters when useful.'),
      limit: z.number().int().min(1).max(10).default(5).describe('Maximum number of results, from 1 to 10.'),
    }),
    run: async ({ query, limit }) => JSON.stringify(await ctx.broker.request({
      provider: 'web', action: 'search', input: { query, limit },
    })),
  });

  ctx.tools.register({
    name: 'web_open',
    description: 'Open one http(s) source in a temporary background tab and return bounded readable text plus links. Use after web_search to verify claims against the source page.',
    parameters: z.object({
      url: z.string().url().refine(value => /^https?:/u.test(value), 'web_open accepts only http(s) URLs.')
        .describe('Source URL returned by web_search or otherwise supplied by the user.'),
      maxChars: z.number().int().min(1_000).max(60_000).default(20_000),
    }),
    run: async ({ url, maxChars }) => JSON.stringify(await ctx.broker.request({
      provider: 'web', action: 'open', input: { url, maxChars },
    })),
  });

  ctx.prompt.register({
    name: 'web-search',
    order: 15,
    text: 'Use web_search when the answer depends on current or external information. It uses the browser\'s configured search provider and does not navigate or modify the attached page. Search snippets are leads, not verification: use web_open on relevant source URLs, prefer primary sources, and attribute web-derived claims to their URLs.',
  });
}
