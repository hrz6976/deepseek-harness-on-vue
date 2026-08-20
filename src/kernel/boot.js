// Boot: seed OPFS with the shipped plugin sources, then compile and mount
// EVERYTHING in .plugins/ through the same pipeline that loads agent-created
// plugins. There is no separate "built-in" loading path anymore — the shipped
// plugins are just the initial state of the filesystem, which is what makes
// them agent-editable (file-editor + HMR work on them like on anything else).
// The entry (per-frame) mounts fs and calls boot(defaults); defaults come
// from the build-time 'virtual:plugin-defaults' module:
//   { [name]: { source: string, autoMount?: boolean } }
import { watch } from 'vue';
import { services } from './services.js';
import { log } from './log.js';
import { compilePlugin } from './compile.js';
import { mountPlugin } from './host.js';

// Services are provided when a plugin's component RENDERS, so the fs service
// appears one render pass after mountPlugin('fs') — wait reactively for it.
function serviceReady(name) {
  const current = services.get(name)?.value;
  if (current) return Promise.resolve(current);
  return new Promise(resolve => {
    const stop = watch(() => services.get(name)?.value, v => { if (v) { stop(); resolve(v); } });
  });
}

export const PLUGIN_DIR = '.plugins/';
export const FORMAT_FILE = PLUGIN_DIR + '.format';
// Bump when the plugin dialect changes (see kernel/compile.js), so a
// pre-change OPFS survivor can't brick the boot. '2' = registry imports.
export const PLUGIN_FORMAT_VERSION = '2';

export async function boot(defaults, { search } = {}) {
  const fs = await serviceReady('fs');
  await fs.ready;

  // ?reset — the one escape hatch: wipe .plugins/ and fall through to
  // reseeding. localStorage (model connection config) deliberately survives,
  // which DevTools "clear site data" would not grant.
  const params = new URLSearchParams(search ?? globalThis.location?.search ?? '');
  if (params.has('reset')) {
    for (const p of fs.list().filter(p => p.startsWith(PLUGIN_DIR))) await fs.remove(p);
    log('factory reset: .plugins/ wiped, reseeding shipped defaults', 'warn');
    // strip the param or every refresh keeps wiping
    globalThis.history?.replaceState?.(null, '', globalThis.location?.pathname ?? '/');
  }

  // Seed: write-if-missing ONLY — an agent-modified file is never clobbered.
  // (Consequence for dev: repo-side edits to a shipped plugin reach a browser
  // that already has OPFS state only via ?reset. Documented in README.)
  for (const [name, d] of Object.entries(defaults))
    if (fs.read(PLUGIN_DIR + name + '.js') == null) await fs.write(PLUGIN_DIR + name + '.js', d.source);
  if (fs.read(FORMAT_FILE) == null) await fs.write(FORMAT_FILE, PLUGIN_FORMAT_VERSION);

  // Dialect check: stored sources speak an older dialect. Loading them could
  // half-brick the app, and skipping them WOULD brick it (everything lives in
  // .plugins/ now) — so boot from the shipped defaults instead, files kept.
  const stale = (fs.read(FORMAT_FILE) ?? '').trim() !== PLUGIN_FORMAT_VERSION;
  if (stale)
    log(`stored plugins use format ${(fs.read(FORMAT_FILE) ?? '?').trim()}, this build wants ${PLUGIN_FORMAT_VERSION} — booting from shipped defaults (files kept; use ?reset to migrate)`, 'err');

  // Mount: manifest order first (deterministic), agent-created extras after.
  // Order is otherwise irrelevant — dependencies are readiness-driven through
  // the reactive service registry.
  const stored = fs.list()
    .filter(p => p.startsWith(PLUGIN_DIR) && p.endsWith('.js'))
    .map(p => p.slice(PLUGIN_DIR.length, -3));
  const names = [...Object.keys(defaults), ...stored.filter(n => !(n in defaults))];
  for (const name of names) {
    const d = defaults[name];
    if (d?.autoMount === false) continue; // e.g. llm: mounted by settings, with config
    const source = stale ? d?.source : (fs.read(PLUGIN_DIR + name + '.js') ?? d?.source);
    if (source == null) continue; // stale + agent-created: no shipped fallback exists
    try {
      const def = await compilePlugin(name, source);
      mountPlugin(name, def, { builtin: name in defaults });
    } catch (e) {
      // Fail-soft per plugin: one broken file must not take the app down.
      log(`boot: plugin ${name} failed to compile: ${e.message} — skipped (fix the file, remove_plugin it, or ?reset)`, 'err');
    }
  }
  log(`boot complete: ${names.length} plugin file(s) processed`, 'ok');
}
