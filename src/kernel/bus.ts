// Event bus: emit / on / waterfall. cordis lifecycle events + middleware.
// waterfall = middleware chain with veto semantics: a listener that does not
// call next() short-circuits the chain and its return value wins.
import { getCurrentInstance, onUnmounted, inject } from 'vue';
import { log } from './log';
import type { JsonObject } from '../shared/runtime';

// Runtime-created plugins may introduce event names, so the bus is an open
// dynamic ABI. Explicit `any` is intentionally confined to this boundary;
// typed wrappers below keep builtin call sites precise.
export type BusListener = (...args: any[]) => any;
interface ListenerEntry { fn: BusListener; owner: string }
const listeners = new Map<string, Set<ListenerEntry>>(); // event -> Set<{ fn, owner }>

export const bus = {
  on(event: string, fn: BusListener, owner = '?') {
    const eventListeners = listeners.get(event) ?? new Set<ListenerEntry>();
    listeners.set(event, eventListeners);
    const entry = { fn, owner };
    eventListeners.add(entry);
    return () => eventListeners.delete(entry);
  },
  emit(event: string, ...args: unknown[]): void {
    for (const { fn, owner } of [...(listeners.get(event) || [])]) {
      try { fn(...args); }
      catch (error: unknown) {
        log(`listener for "${event}" (plugin [${owner}]) threw: ${error instanceof Error ? error.message : String(error)}`, 'err');
      }
    }
  },
  async waterfall<T>(event: string, arg: T): Promise<T> {
    const chain = [...(listeners.get(event) || [])];
    const run = async (i: number, value: T): Promise<T> => {
      if (i >= chain.length) return value;
      let used = false;
      const listener = chain[i]!;
      const next = (v: T): Promise<T> | T => {
        if (used) { // double next() corrupts the chain; flag loudly, ignore the second call
          log(`waterfall "${event}": next() called twice by plugin [${listener.owner}]`, 'err');
          return v;
        }
        used = true;
        return run(i + 1, v);
      };
      return await listener.fn(value, next) as T;
    };
    return run(0, arg);
  },
};

// Listening is an effect: auto-removed when the owning plugin unmounts.
export function useBusOn(event: string, fn: BusListener) {
  const inst = getCurrentInstance();
  const owner = inst ? inject('pluginName', inst.type?.name || '?') : '?';
  const off = bus.on(event, fn, owner);
  if (inst) onUnmounted(off);
  return off;
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
