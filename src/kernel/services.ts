// Vue invalidates service computeds when Cordis changes; service values remain
// owned by Cordis and are always resolved through the caller Context.
import { computed, shallowRef } from 'vue';
import type { ComputedRef } from 'vue';
import type { ServiceTypes } from '@/shared/runtime';
import { currentCordisContext, runtime } from './cordis';

const serviceRevision = shallowRef(0);
runtime.on('internal/service', () => { serviceRevision.value++; });

// Readiness-driven consumption: resolves to null until the service appears,
// re-resolves when it is replaced. Never cache the .value across awaits.
export function useService<K extends keyof ServiceTypes & string>(name: K): ComputedRef<ServiceTypes[K] | null>;
export function useService<T = unknown>(name: string): ComputedRef<T | null>;
export function useService<T = unknown>(name: string): ComputedRef<T | null> {
  const ctx = currentCordisContext();
  return computed(() => {
    void serviceRevision.value;
    return (ctx.reflect.get(name) as T | undefined) ?? null;
  });
}
