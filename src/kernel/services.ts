// Reactive Vue facade over Cordis services. Cordis is the source of truth;
// this map exists only so Vue computeds update when a service appears,
// disappears, or is replaced after a Fiber restart.
// Must be shallowReactive: reactive(Map) would deep-reactify stored impls and
// auto-unwrap refs on them (llm.running.value comes back undefined — verified
// in the PoC review the hard way).
import { shallowReactive, shallowRef, computed, getCurrentInstance, onUnmounted, inject } from 'vue';
import type { ComputedRef, ShallowRef } from 'vue';
import type { ServiceTypes } from '@/shared/runtime';
import { recordCapabilityContribution } from './capabilities';
import { cordis, currentCordisContext } from './cordis';

export const services = shallowReactive(new Map<string, ShallowRef<unknown>>());

cordis.on('internal/service', (name, value) => {
  if (value === undefined) services.delete(name);
  else services.set(name, shallowRef(value));
});

// Registration is an effect: providing inside a component auto-revokes on
// unmount. Cleanup is token-guarded — only delete the slot if it still holds
// *our* slot, otherwise a replacement provider that mounted before we
// unmounted would get its fresh registration deleted.
export function provideService<K extends keyof ServiceTypes & string>(name: K, impl: ServiceTypes[K]): () => void;
export function provideService<T>(name: string, impl: T): () => void;
export function provideService<T>(name: string, impl: T): () => void {
  const ctx = currentCordisContext();
  const slot = shallowRef(impl);
  services.set(name, slot as ShallowRef<unknown>);
  const capabilityId = getCurrentInstance()
    ? inject<string | null>('capabilityId', inject<string | null>('pluginName', null))
    : ctx.fiber.name === 'root' ? null : ctx.fiber.name;
  const disposeContribution = recordCapabilityContribution(capabilityId, 'services', name);
  const disposeCordis = ctx.reflect.provide(name, impl);
  const dispose = () => {
    void disposeCordis();
    if (services.get(name) === slot) services.delete(name);
    disposeContribution();
  };
  if (getCurrentInstance()) onUnmounted(dispose);
  return dispose;
}

// Readiness-driven consumption: resolves to null until the service appears,
// re-resolves when it is replaced. Never cache the .value across awaits.
export function useService<K extends keyof ServiceTypes & string>(name: K): ComputedRef<ServiceTypes[K] | null>;
export function useService<T = unknown>(name: string): ComputedRef<T | null>;
export function useService<T = unknown>(name: string): ComputedRef<T | null> {
  const ctx = currentCordisContext();
  return computed(() => {
    // Touch the Vue facade so service lifecycle changes invalidate this
    // computed, but resolve through the caller's Cordis Context. Service
    // proxies can then preserve the capability/Fiber identity of UI callers.
    if (!services.get(name)?.value) return null;
    return (ctx.reflect.get(name) as T | undefined) ?? null;
  });
}

export function getService<K extends keyof ServiceTypes & string>(name: K): ServiceTypes[K] | null;
export function getService<T = unknown>(name: string): T | null;
export function getService<T = unknown>(name: string): T | null {
  return (currentCordisContext().reflect.get(name) as T | undefined)
    ?? (services.get(name)?.value as T | undefined)
    ?? null;
}
