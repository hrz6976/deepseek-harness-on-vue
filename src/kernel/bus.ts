// Event bus: emit / on / waterfall. cordis lifecycle events + middleware.
// waterfall = middleware chain with veto semantics: a listener that does not
// call next() short-circuits the chain and its return value wins.
import { getCurrentInstance, onUnmounted } from 'vue';
import type { JsonObject } from '@/shared/runtime';
import { capabilityForContext, recordCapabilityContribution } from './capabilities';
import { currentCordisContext } from './cordis';
import { log } from './log';

// Runtime-created plugins may introduce event names, so the bus is an open
// dynamic ABI. Explicit `any` is intentionally confined to this boundary;
// typed wrappers below keep builtin call sites precise.
type BusListener = (...args: any[]) => any;
function listen(event: string, fn: BusListener, owner: string) {
  return currentCordisContext().on(event, (...args: unknown[]) => {
    const next = args.at(-1);
    if (typeof next !== 'function') return fn(...args);
    let used = false;
    const guardedNext = (...nextArgs: unknown[]) => {
      if (used) {
        log(`waterfall "${event}": next() called twice by plugin [${owner}]`, 'err');
        return nextArgs[0];
      }
      used = true;
      const replacement = nextArgs[0];
      const current = args[0];
      if (replacement && current && replacement !== current
        && typeof replacement === 'object' && typeof current === 'object') {
        for (const key of Object.keys(current as object)) delete (current as Record<string, unknown>)[key];
        Object.assign(current, replacement);
      }
      return next();
    };
    return fn(...args.slice(0, -1), guardedNext);
  });
}

// Listening is an effect: auto-removed when the owning plugin unmounts.
export function useBusOn(event: string, fn: BusListener) {
  const ctx = currentCordisContext();
  const owner = capabilityForContext(ctx)?.manifest.id ?? ctx.fiber.name;
  const off = listen(event, fn, owner);
  const disposeContribution = recordCapabilityContribution(owner, 'events', event);
  const dispose = () => { off(); disposeContribution(); };
  if (getCurrentInstance()) onUnmounted(dispose);
  return dispose;
}

// Safer sugar over raw (arg, next) — forgetting next() silently vetoes, which
// is a footgun for agent-written plugins. guard(req) returns a denial string
// (veto) or falsy (pass through).
export interface ToolGuardRequest { name: string; args: JsonObject; veto?: string }
export function useToolGuard(guard: (request: ToolGuardRequest) => unknown | Promise<unknown>) {
  return useBusOn('tools/pre-execute', async (req: ToolGuardRequest, next: (value: ToolGuardRequest) => unknown) => {
    const denial = await guard(req);
    return denial ? { ...req, veto: String(denial) } : next(req);
  });
}
export function useRequestTransform<T>(transform: (request: T) => T | null | undefined | Promise<T | null | undefined>) {
  return useBusOn('llm/request', async (req: T, next: (value: T) => unknown) => next((await transform(req)) ?? req));
}
