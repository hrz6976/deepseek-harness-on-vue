// Boot: seed OPFS with shipped capability sources, then compile and mount them
// through the same pipeline as agent-created capabilities. Framework services
// (fs/tools/prompt/manager/task/state/loop) are bundled system Fibers and never
// loaded from editable workspace state. The entry calls boot(defaults);
// defaults come from the build-time 'virtual:plugin-defaults' module:
//   { [name]: { source: string, autoMount?: boolean } }
import type { Context } from '@deepseek-ai/cordis';
import { cordis } from './cordis';
import { log } from './log';
import { compilePlugin } from './compile';
import { mountPlugin, plugins, unmountPlugin } from './host';
import { bumpCapabilityVersion } from './capabilities';
import type { FsService, PluginDefaults } from '@/shared/runtime';
import { errorMessage } from '@/shared/runtime';
import {
  CAPABILITY_PACKAGE_ROOT,
  capabilityIndexPath,
  persistCapabilityPackage,
  readCapabilityManifest,
} from './capability-package';

export const PLUGIN_DIR = '.plugins/';

export async function boot(
  defaults: PluginDefaults,
  {
    search,
    ctx = cordis,
    reservedNames = [],
  }: { search?: string; ctx?: Context; reservedNames?: readonly string[] } = {},
): Promise<void> {
  const fs = ctx.fs as FsService;
  const refreshedShippedCapabilities = new Set<string>();
  await fs.ready;

  // ?reset — the one escape hatch: wipe .plugins/ and fall through to
  // reseeding. localStorage (model connection config) deliberately survives,
  // which DevTools "clear site data" would not grant.
  const params = new URLSearchParams(search ?? globalThis.location?.search ?? '');
  if (params.has('reset')) {
    for (const p of fs.list().filter(p => p.startsWith(PLUGIN_DIR) || p.startsWith(CAPABILITY_PACKAGE_ROOT))) await fs.remove(p);
    log('factory reset: capability packages wiped, reseeding shipped defaults', 'warn');
    // strip the param or every refresh keeps wiping
    globalThis.history?.replaceState?.(null, '', globalThis.location?.pathname ?? '/');
  }

  // Framework services used to be editable OPFS plugins. Remove only those
  // now-reserved legacy copies so stale runtime state can never shadow bundled
  // protocol code. User capability names remain untouched.
  for (const name of reservedNames) {
    const pluginPath = PLUGIN_DIR + name + '.js';
    const packageRoot = `${CAPABILITY_PACKAGE_ROOT}${name}/`;
    const legacyPaths = fs.list().filter(path => path === pluginPath || path.startsWith(packageRoot));
    for (const path of legacyPaths) await fs.remove(path);
    if (legacyPaths.length) log(`boot: removed legacy OPFS copy of system plugin [${name}]`, 'ok');
  }

  // Seed new builtins and advance clean generated base revisions. A successful
  // agent edit bumps the capability version; an uncompiled/broken draft also
  // differs from the last active index. Both cases are preserved. This lets a
  // rebuilt extension update untouched framework plugins without requiring a
  // destructive ?reset or clobbering real user work.
  for (const [name, d] of Object.entries(defaults)) {
    const path = PLUGIN_DIR + name + '.js';
    const workingSource = fs.read(path);
    if (workingSource == null) {
      await fs.write(path, d.source);
      continue;
    }
    if (workingSource === d.source) continue;
    let storedManifest: ReturnType<typeof readCapabilityManifest> = null;
    try { storedManifest = readCapabilityManifest(fs, name, true); }
    catch { /* activation below reports malformed manifests without overwriting their source */ }
    const activeSource = fs.read(capabilityIndexPath(name));
    const cleanGeneratedBase = storedManifest?.source === 'generated'
      && storedManifest.manifest.version === '0.1.0'
      && activeSource === workingSource;
    if (!cleanGeneratedBase) continue;
    await fs.write(path, d.source);
    refreshedShippedCapabilities.add(name);
    log(`boot: updated untouched shipped capability [${name}]`, 'ok');
  }

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
    const source = fs.read(PLUGIN_DIR + name + '.js') ?? d?.source;
    if (source == null) continue;
    const activate = async (candidateSource: string) => {
      const previousActiveSource = fs.read(capabilityIndexPath(name));
      const def = await compilePlugin(name, candidateSource);
      const builtin = name in defaults;
      const storedManifest = readCapabilityManifest(fs, name, builtin);
      const entry = await mountPlugin(name, def, {
        builtin,
        ...(storedManifest ? { manifest: storedManifest.manifest, manifestSource: storedManifest.source } : {}),
      });
      if (entry.fiber && entry.fiber.state !== 0) await entry.fiber.await();
      if (!refreshedShippedCapabilities.has(name)
        && previousActiveSource != null
        && previousActiveSource !== candidateSource
        && entry.manifestSource === 'generated') {
        bumpCapabilityVersion(entry);
      }
      await persistCapabilityPackage(fs, entry, candidateSource);
      return entry;
    };
    try {
      await activate(source);
    } catch (error: unknown) {
      if (plugins.some(plugin => plugin.name === name)) await unmountPlugin(name);
      const activeSource = fs.read(capabilityIndexPath(name));
      if (activeSource && activeSource !== source) {
        try {
          const entry = await activate(activeSource);
          entry.hmrError = `Working draft rejected during boot: ${errorMessage(error)}`;
          log(`boot: plugin ${name} working draft was rejected; restored the last active revision`, 'warn');
          continue;
        } catch (fallbackError) {
          if (plugins.some(plugin => plugin.name === name)) await unmountPlugin(name);
          log(`boot: plugin ${name} and its last active revision failed: ${errorMessage(fallbackError)}`, 'err');
          continue;
        }
      }
      // Fail-soft per plugin: one broken file must not take the app down.
      log(`boot: plugin ${name} failed to activate: ${errorMessage(error)} — skipped (fix the draft, remove_plugin it, or ?reset)`, 'err');
    }
  }
  log(`boot complete: ${names.length} plugin file(s) processed`, 'ok');
}
