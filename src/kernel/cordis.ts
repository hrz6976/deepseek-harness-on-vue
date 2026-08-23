import { Context, type Plugin } from '@deepseek-ai/cordis';
import { getCurrentInstance, inject } from 'vue';

/**
 * One Cordis application lives in each sandbox frame.
 *
 * OPFS modules are code transport only. Every executable plugin is applied to
 * this context and receives a real Cordis Fiber for dependency readiness,
 * effects, events, services, failures, and disposal.
 */
export const runtime = new Context();

export function createSystemPlugin(
  name: string,
  plugin: Plugin.Object,
  ready?: (ctx: Context) => void,
): Plugin.Object {
  return {
    name: `kernel:${name}`,
    ...(plugin.inject ? { inject: plugin.inject } : {}),
    apply(ctx, config) {
      ready?.(ctx);
      return plugin.apply(ctx, config);
    },
  };
}

export function systemContextId(ctx: Context): string | null {
  return ctx.fiber.name.startsWith('kernel:') ? ctx.fiber.name.slice(7) : null;
}

/** Vue components contributed by a Cordis plugin inherit its calling scope. */
export const cordisContextKey = Symbol('harness.cordis-context');

export function currentCordisContext(): Context {
  return getCurrentInstance()
    ? inject<Context>(cordisContextKey, runtime)
    : runtime;
}
