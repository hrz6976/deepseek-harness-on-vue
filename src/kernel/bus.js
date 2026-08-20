// Event bus: emit / on / waterfall. cordis lifecycle events + middleware.
// waterfall = middleware chain with veto semantics: a listener that does not
// call next() short-circuits the chain and its return value wins.
import { getCurrentInstance, onUnmounted, inject } from 'vue';
import { log } from './log.js';

const listeners = new Map(); // event -> Set<{ fn, owner }>

export const bus = {
  on(event, fn, owner = '?') {
    if (!listeners.has(event)) listeners.set(event, new Set());
    const entry = { fn, owner };
    listeners.get(event).add(entry);
    return () => listeners.get(event)?.delete(entry);
  },
  emit(event, ...args) {
    for (const { fn, owner } of [...(listeners.get(event) || [])]) {
      try { fn(...args); }
      catch (e) { log(`listener for "${event}" (plugin [${owner}]) threw: ${e.message}`, 'err'); }
    }
  },
  async waterfall(event, arg) {
    const chain = [...(listeners.get(event) || [])];
    const run = async (i, value) => {
      if (i >= chain.length) return value;
      let used = false;
      const next = v => {
        if (used) { // double next() corrupts the chain; flag loudly, ignore the second call
          log(`waterfall "${event}": next() called twice by plugin [${chain[i].owner}]`, 'err');
          return v;
        }
        used = true;
        return run(i + 1, v);
      };
      return chain[i].fn(value, next);
    };
    return run(0, arg);
  },
};

// Listening is an effect: auto-removed when the owning plugin unmounts.
export function useBusOn(event, fn) {
  const inst = getCurrentInstance();
  const owner = inst ? inject('pluginName', inst.type?.name || '?') : '?';
  const off = bus.on(event, fn, owner);
  if (inst) onUnmounted(off);
  return off;
}

// Safer sugar over raw (arg, next) — forgetting next() silently vetoes, which
// is a footgun for agent-written plugins. guard(req) returns a denial string
// (veto) or falsy (pass through).
export function useToolGuard(guard) {
  return useBusOn('tools/pre-execute', async (req, next) => {
    const denial = await guard(req);
    return denial ? { ...req, veto: String(denial) } : next(req);
  });
}
export function useRequestTransform(transform) {
  return useBusOn('llm/request', async (req, next) => next((await transform(req)) ?? req));
}
