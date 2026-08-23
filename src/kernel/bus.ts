// Event bus: emit / on / waterfall. cordis lifecycle events + middleware.
// waterfall = middleware chain with veto semantics: a listener that does not
// call next() short-circuits the chain and its return value wins.
import { getCurrentInstance, onUnmounted, inject } from 'vue';
import type { JsonObject } from '@/shared/runtime';
import { recordCapabilityContribution } from './capabilities';
import { cordis, currentCordisContext } from './cordis';
import { log } from './log';

// Runtime-created plugins may introduce event names, so the bus is an open
// dynamic ABI. Explicit `any` is intentionally confined to this boundary;
// typed wrappers below keep builtin call sites precise.
export type BusListener = (...args: any[]) => any;
export const bus = {
  on(event: string, fn: BusListener, owner = '?') {
    const ctx = currentCordisContext();
    return ctx.on(event, (...args: unknown[]) => {
      const next = args.at(-1);
      if (typeof next !== 'function') return fn(...args);
      let used = false;
      const guardedNext = (...nextArgs: unknown[]) => {
        if (used) {
          log(`waterfall "${event}": next() called twice by plugin [${owner}]`, 'err');
          return nextArgs[0];
        }
        used = true;
        // Cordis waterfall continuations are intentionally argument-less.
        // Preserve the legacy Harness transform face for object requests by
        // copying a replacement into the canonical object before continuing.
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
  },
  emit(event: string, ...args: unknown[]): void {
    cordis.emit(event, ...args);
  },
  async waterfall<T>(event: string, arg: T): Promise<T> {
    return await cordis.waterfall(event, arg, (value: T) => value) as T;
  },
};

// Listening is an effect: auto-removed when the owning plugin unmounts.
export function useBusOn(event: string, fn: BusListener) {
  const inst = getCurrentInstance();
  const owner = inst ? inject('capabilityId', inject('pluginName', inst.type?.name || '?')) : '?';
  const off = bus.on(event, fn, owner);
  const disposeContribution = recordCapabilityContribution(owner, 'events', event);
  const dispose = () => { off(); disposeContribution(); };
  if (inst) onUnmounted(dispose);
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
