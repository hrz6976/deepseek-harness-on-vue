import type { Context } from '@deepseek-ai/cordis';
import { targetParameters, typeParameters, scrollParameters, waitParameters, settleParameters, scriptParameters } from './schemas';
import { request } from './command';

export function registerInteractionTools(ctx: Context): void {
  ctx.tools.register({
    name: 'page_click',
    description: 'Click a referenced page element through the trusted Page provider. Requires user approval.',
    parameters: targetParameters,
    run: ({ target }) => request(ctx, { type: 'page/click', target })
  });

  ctx.tools.register({
    name: 'page_type',
    description: 'Enter text into a referenced input or editable element through the trusted Page provider. Requires user approval.',
    parameters: typeParameters,
    run: ({ target, value, clear }) => request(ctx, { type: 'page/type', target, value, clear })
  });

  ctx.tools.register({
    name: 'page_scroll',
    description: 'Scroll the page or bring a referenced element into view.',
    parameters: scrollParameters,
    run: ({ target, x, y, behavior }) => request(ctx, { type: 'page/scroll', target, x, y, behavior })
  });

  ctx.tools.register({
    name: 'page_wait',
    description: 'Wait until a selector is attached, visible, hidden, or detached.',
    parameters: waitParameters,
    run: ({ selector, state, timeoutMs }) => request(ctx, { type: 'page/wait', selector, state, timeoutMs })
  });

  ctx.tools.register({
    name: 'page_settle',
    description: 'Wait for a quiet DOM interval after navigation or interaction.',
    parameters: settleParameters,
    run: ({ quietMs, timeoutMs }) => request(ctx, { type: 'page/settle', quietMs, timeoutMs })
  });

  ctx.tools.register({
    name: 'page_script_run',
    description: 'Execute one-off JavaScript in the trusted MAIN or USER_SCRIPT page world when typed page tools cannot express the required behavior. The worlds share DOM but not JavaScript globals: a USER_SCRIPT window property missing from MAIN is expected and is not evidence of failed, stale, or truncated injection. Arbitrary code still requires explicit user approval.',
    parameters: scriptParameters,
    run: ({ code, world }) => request(ctx, { type: 'page/eval', code, world })
  });
}
