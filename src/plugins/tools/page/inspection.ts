import type { Context } from '@deepseek-ai/cordis';
import { snapshotParameters, queryParameters, queryPageParameters, styleInspectParameters, emptyParameters } from './schemas';
import { request } from './command';

const snapshotDescription = 'Read a compressed, framework-neutral DOM snapshot of the active page. Returns stable element references for later patches.';
const queryDescription = 'Find elements in the active page with a CSS selector and return stable references and fingerprints.';
const styleInspectDescription = 'Read all computed CSS properties, inline declarations, and matching author rules for a referenced element or its ::before/::after pseudo-element. This is a read-only core inspection and needs no approval.';

export function registerInspectionTools(ctx: Context): void {
  ctx.tools.register({
    name: 'page_snapshot',
    description: snapshotDescription,
    parameters: snapshotParameters,
    run: ({ selector, maxNodes, maxDepth }) => request(ctx, { type: 'page/snapshot', options: { selector, maxNodes, maxDepth } })
  });

  ctx.tools.register({
    name: 'page_query',
    description: queryDescription,
    parameters: queryParameters,
    run: ({ selector, limit }) => request(ctx, { type: 'page/query', selector, limit })
  });

  ctx.tools.register({
    name: 'page_query_page',
    description: 'Query a large matching set one bounded page at a time.',
    parameters: queryPageParameters,
    run: ({ selector, offset, limit }) => request(ctx, { type: 'page/query-page', selector, offset, limit })
  });

  ctx.tools.register({
    name: 'page_style_inspect',
    description: styleInspectDescription,
    parameters: styleInspectParameters,
    run: ({ target, pseudo, properties, includeMatchedRules, maxRules }) => request(ctx, {
      type: 'page/style-inspect', target, pseudo, properties, includeMatchedRules, maxRules,
    }),
  });

  ctx.tools.register({
    name: 'page_picker_start',
    description: 'Open the visual element picker so the user can click a page element and attach an annotation.',
    parameters: emptyParameters,
    run: () => request(ctx, { type: 'page/picker-start' })
  });
}
