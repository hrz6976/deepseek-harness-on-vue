import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis';
import { getCurrentInstance, inject } from 'vue';

/**
 * One Cordis application lives in each sandbox frame.
 *
 * OPFS modules are code transport only. Every executable plugin is applied to
 * this context and receives a real Cordis Fiber for dependency readiness,
 * effects, events, services, failures, and disposal.
 */
export const runtime = new Context();

// Cordis exposes FiberState as a const enum, not a browser runtime export.
const fiberStatuses = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const;
export const fiberStatus = (fiber: Fiber) => fiberStatuses[fiber.state];

export function createSystemPlugin(
  name: string,
  plugin: Plugin.Object,
  ready?: (ctx: Context) => void,
): Plugin.Object {
  return {
    ...plugin,
    name: `kernel:${name}`,
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
