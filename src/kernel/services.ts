// Service registry: name -> shallowRef(impl). cordis ctx.set / ctx.get.
// Must be shallowReactive: reactive(Map) would deep-reactify stored impls and
// auto-unwrap refs on them (llm.running.value comes back undefined — verified
// in the PoC review the hard way).
import { shallowReactive, shallowRef, computed, getCurrentInstance, onUnmounted } from 'vue';
import type { ComputedRef, ShallowRef } from 'vue';
import type { ServiceTypes } from '../shared/runtime';

export const services = shallowReactive(new Map<string, ShallowRef<unknown>>());

// Registration is an effect: providing inside a component auto-revokes on
// unmount. Cleanup is token-guarded — only delete the slot if it still holds
// *our* slot, otherwise a replacement provider that mounted before we
// unmounted would get its fresh registration deleted.
export function provideService<K extends keyof ServiceTypes & string>(name: K, impl: ServiceTypes[K]): () => void;
export function provideService<T>(name: string, impl: T): () => void;
export function provideService<T>(name: string, impl: T): () => void {
  const slot = shallowRef(impl);
  services.set(name, slot as ShallowRef<unknown>);
  const dispose = () => { if (services.get(name) === slot) services.delete(name); };
  if (getCurrentInstance()) onUnmounted(dispose);
  return dispose;
}

// Readiness-driven consumption: resolves to null until the service appears,
// re-resolves when it is replaced. Never cache the .value across awaits.
export function useService<K extends keyof ServiceTypes & string>(name: K): ComputedRef<ServiceTypes[K] | null>;
export function useService<T = unknown>(name: string): ComputedRef<T | null>;
export function useService<T = unknown>(name: string): ComputedRef<T | null> {
  return computed(() => (services.get(name)?.value as T | undefined) ?? null);
}

export function getService<K extends keyof ServiceTypes & string>(name: K): ServiceTypes[K] | null;
export function getService<T = unknown>(name: string): T | null;
export function getService<T = unknown>(name: string): T | null {
  return (services.get(name)?.value as T | undefined) ?? null;
}
