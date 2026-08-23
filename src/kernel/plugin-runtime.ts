import type { Plugin } from '@deepseek-ai/cordis';

type PluginModule = Record<string, unknown> & { default?: unknown };

/** Normalize an imported namespace to the real Cordis Plugin union. */
export function normalizePlugin(raw: unknown, name: string): Plugin {
  const module = raw as PluginModule | null;
  let candidate: unknown = module?.default;

  // Cordis-style named module: metadata and apply are explicit exports.
  if (candidate === undefined && typeof module?.apply === 'function') {
    candidate = {
      name: typeof module.name === 'string' ? module.name : name,
      ...(module.inject ? { inject: module.inject } : {}),
      ...(module.Config ? { Config: module.Config } : {}),
      apply: module.apply,
    };
  }

  if (typeof candidate === 'function') {
    // Runtime identity is the capability/package id, never an independently
    // chosen export name. Fiber ownership and manifest policy share it.
    try { Object.defineProperty(candidate, 'name', { value: name, configurable: true }); } catch { /* diagnostics only */ }
    return candidate as Plugin;
  }

  if (candidate && typeof candidate === 'object' && typeof (candidate as { apply?: unknown }).apply === 'function') {
    const plugin = candidate as Plugin.Object;
    return { ...plugin, name };
  }

  throw new Error('a plugin must export a Cordis function/class/{ apply } plugin');
}
