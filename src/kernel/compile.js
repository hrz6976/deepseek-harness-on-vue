// Dynamic plugin loading: ESM source string -> component definition.
// Primary path: Blob URL import (real ESM). Fallback: new Function, for
// Safari quirks / stricter contexts where blob: import is unavailable.
//
// THE PLUGIN DIALECT IS PINNED so both paths accept the same source:
//   - exactly one `export default { ... }` (component object)
//   - no import statements — use globalThis.__harness.Vue and injected services
//   - no top-level await
// translateESM only handles this dialect; anything fancier loads on the Blob
// path and breaks on the fallback, which is why TESTING.md forces the
// fallback in one scenario.
import { markRaw } from 'vue';

export function translateESM(source) {
  return source
    .replace(/export\s+default\s/, 'module.exports = ')
    .replace(/export\s+(const|let|var|function|async function)/g, '$1');
}

export async function importPluginSource(source) {
  try {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { return await import(/* @vite-ignore */ url); }
    finally { URL.revokeObjectURL(url); }
  } catch (e) {
    if (e instanceof SyntaxError) throw e; // real parse error: same source won't fare better below
    const mod = { exports: {} };
    new Function('module', 'exports', translateESM(source))(mod, mod.exports);
    return { default: mod.exports };
  }
}

export function normalizePluginDef(raw, name) {
  let def = raw?.default ?? raw;
  if (typeof def === 'function') def = { setup: def }; // bare setup function form
  if (!def || (typeof def.setup !== 'function' && !def.render && !def.template))
    throw new Error('a plugin must export default a component object (with setup / template / render)');
  def.name = def.name || name;
  return def;
}

// Compile-probe: module top-level errors throw HERE, which is what lets
// create/HMR roll back before touching the running instance. setup-time
// errors cannot be probed; PluginHost's onErrorCaptured catches those at
// mount and shows the failed card instead.
export async function compilePlugin(name, source) {
  return markRaw(normalizePluginDef(await importPluginSource(source), name));
}
