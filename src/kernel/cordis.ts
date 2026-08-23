import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis';
import { getCurrentInstance, inject } from 'vue';

/**
 * One Cordis application lives in each sandbox frame.
 *
 * OPFS modules are code transport only. Every executable plugin is applied to
 * this context and receives a real Cordis Fiber for dependency readiness,
 * effects, events, services, failures, and disposal.
 */
export class HarnessRuntime {
  readonly context = new Context();
  readonly #systemFibers = new WeakMap<Fiber, string>();
  readonly #systemContexts = new Map<string, Context>();
  readonly #fibers = new Set<Fiber>();

  mountSystem(name: string, plugin: Plugin.Object): Fiber & PromiseLike<Fiber> {
    const runtime = this;
    const wrapper: Plugin.Object = {
      name: `kernel:${name}`,
      ...(plugin.inject ? { inject: plugin.inject } : {}),
      apply(ctx, config) {
        runtime.#systemFibers.set(ctx.fiber, name);
        runtime.#systemContexts.set(name, ctx);
        runtime.#fibers.add(ctx.fiber);
        ctx.effect(() => () => {
          runtime.#fibers.delete(ctx.fiber);
          if (runtime.#systemContexts.get(name) === ctx) runtime.#systemContexts.delete(name);
        }, `kernel.runtime(${JSON.stringify(name)})`);
        return plugin.apply(ctx, config);
      },
    };
    return this.context.plugin(wrapper);
  }

  systemId(fiber: Fiber): string | null {
    return this.#systemFibers.get(fiber) ?? null;
  }

  systemContext(name: string): Context | null {
    return this.#systemContexts.get(name) ?? null;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#fibers].reverse().map(fiber => fiber.dispose()));
    this.#fibers.clear();
  }
}

export function createHarnessRuntime(): HarnessRuntime {
  return new HarnessRuntime();
}

export const harnessRuntime = createHarnessRuntime();
export const cordis = harnessRuntime.context;

export function systemFiberId(fiber: Fiber): string | null {
  return harnessRuntime.systemId(fiber);
}

/** Vue components contributed by a Cordis plugin inherit its calling scope. */
export const cordisContextKey = Symbol('harness.cordis-context');

export function currentCordisContext(): Context {
  return getCurrentInstance()
    ? inject<Context>(cordisContextKey, cordis)
    : cordis;
}
