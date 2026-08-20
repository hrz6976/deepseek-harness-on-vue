// Service registry: name -> shallowRef(impl). cordis ctx.set / ctx.get.
// Must be shallowReactive: reactive(Map) would deep-reactify stored impls and
// auto-unwrap refs on them (llm.running.value comes back undefined — verified
// in the PoC review the hard way).
import { shallowReactive, shallowRef, computed, getCurrentInstance, onUnmounted } from 'vue';

export const services = shallowReactive(new Map());

// Registration is an effect: providing inside a component auto-revokes on
// unmount. Cleanup is token-guarded — only delete the slot if it still holds
// *our* slot, otherwise a replacement provider that mounted before we
// unmounted would get its fresh registration deleted.
export function provideService(name, impl) {
  const slot = shallowRef(impl);
  services.set(name, slot);
  const dispose = () => { if (services.get(name) === slot) services.delete(name); };
  if (getCurrentInstance()) onUnmounted(dispose);
  return dispose;
}

// Readiness-driven consumption: resolves to null until the service appears,
// re-resolves when it is replaced. Never cache the .value across awaits.
export function useService(name) {
  return computed(() => services.get(name)?.value ?? null);
}
