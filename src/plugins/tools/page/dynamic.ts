import type { Context } from '@deepseek-ai/cordis';
import { liveRulesParameters, liveRulesInstallParameters, idParameters, emptyParameters, PAGE_DYNAMIC_GROUP } from './schemas';
import { request } from './command';

export function registerDynamicTools(ctx: Context): void {
  ctx.tools.register({
    name: 'page_observe_start',
    description: 'Start publishing debounced DOM mutation events for the attached page.',
    parameters: emptyParameters,
    availability: PAGE_DYNAMIC_GROUP,
    run: () => request(ctx, { type: 'page/observe', enabled: true })
  });

  ctx.tools.register({
    name: 'page_observe_stop',
    description: 'Stop publishing page mutation events. Installed live rules remain active.',
    parameters: emptyParameters,
    availability: PAGE_DYNAMIC_GROUP,
    run: () => request(ctx, { type: 'page/observe', enabled: false })
  });

  ctx.tools.register({
    name: 'page_live_rules_preview',
    description: 'Validate declarative dynamic-page rules and report how many current elements match, without changing the page.',
    parameters: liveRulesParameters,
    availability: PAGE_DYNAMIC_GROUP,
    run: ({ rules }) => request(ctx, { type: 'page/live-rules-preview', rules })
  });

  ctx.tools.register({
    name: 'page_live_rules_apply',
    description: 'Install or replace one temporary declarative rule set. The trusted content runtime reapplies idempotent actions to current and future matching nodes.',
    parameters: liveRulesInstallParameters,
    availability: PAGE_DYNAMIC_GROUP,
    run: ({ id, label, rules }) => request(ctx, { type: 'page/live-rules-install', id, label, rules })
  });

  ctx.tools.register({
    name: 'page_live_rules_remove',
    description: 'Stop a temporary declarative live-rule set by id. Existing DOM changes are not reverted.',
    parameters: idParameters,
    availability: PAGE_DYNAMIC_GROUP,
    run: ({ id }) => request(ctx, { type: 'page/live-rules-remove', id })
  });
}
