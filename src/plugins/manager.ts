import { Service, type Context } from '@deepseek-ai/cordis';
import { log } from '@/kernel/log';
import { compilePlugin } from '@/kernel/compile';
import { mountPlugin, unmountPlugin } from '@/kernel/host';
import {
  bumpCapabilityVersion, capabilities, capabilityHealth, emptyContributionInventory,
  legacyCapabilityManifest, validateCapabilityManifest,
} from '@/kernel/capabilities';
import {
  CAPABILITY_PACKAGE_ROOT, PLUGIN_DIR, capabilityIndexPath, persistCapabilityPackage, readCapabilityManifest,
} from '@/kernel/capability-package';
import type { CapabilityManifest } from '@/shared/capability-protocol';
import { SYSTEM_PLUGIN_NAMES } from '@/kernel/system-plugin-names';
import { isPluginSourceLocked, pluginPolicy } from '@/kernel/plugin-policy';
import type { CapabilityCatalogEntry, ManagerService, PluginDefaults } from '@/shared/runtime';
import { errorMessage } from '@/shared/runtime';
import { principalForContext } from '@/kernel/broker';
import { assertPrincipalPermission } from '@/shared/capability-policy';

class ManagerRuntime extends Service implements ManagerService {
  constructor(ctx: Context, private readonly implementation: ManagerService) {
    super(ctx, 'manager');
  }

  private authorized<T>(run: () => T): T {
    assertPrincipalPermission(principalForContext(this.ctx), 'capability.manage');
    return run();
  }

  catalog() { return this.authorized(() => this.implementation.catalog()); }
  create(name: string, source: string, manifest?: CapabilityManifest) { return this.authorized(() => this.implementation.create(name, source, manifest)); }
  mount(name: string, config?: Record<string, unknown> | null) { return this.authorized(() => this.implementation.mount(name, config)); }
  unmount(name: string) { return this.authorized(() => this.implementation.unmount(name)); }
  remove(name: string) { return this.authorized(() => this.implementation.remove(name)); }
}

type ReloadState =
  | { phase: 'debouncing'; source: string; timer: ReturnType<typeof setTimeout> }
  | { phase: 'queued'; source: string };

interface ManagerBootstrap { defaults: PluginDefaults; search?: string; reservedNames?: readonly string[] }
interface ActivateOptions {
  builtin?: boolean;
  config?: Record<string, unknown> | null;
  manifest?: CapabilityManifest;
  manifestSource?: 'generated' | 'declared';
  bumpManifest?: boolean;
}

const name = 'manager';
const inject = ['fs'];

function apply(ctx: Context, bootstrap?: ManagerBootstrap): void | Promise<void> {
  const reloads = new Map<string, ReloadState>();
  const reserved = new Set(bootstrap?.reservedNames ?? SYSTEM_PLUGIN_NAMES);
  let loopBusy = false;

  const fs = ctx.fs;
  const task = () => ctx.reflect.get('task') as import('../shared/runtime').TaskRuntimeService | undefined;
  const parentFor = (scope = 'task') => scope === 'task' ? task()?.scope() ?? ctx : ctx;
  const cancelReload = (pluginName: string, source?: string) => {
    const state = reloads.get(pluginName);
    if (source !== undefined && state?.source !== source) return;
    if (state?.phase === 'debouncing') clearTimeout(state.timer);
    reloads.delete(pluginName);
  };

  async function activate(pluginName: string, source: string, options: ActivateOptions = {}) {
    const plugin = await compilePlugin(pluginName, source);
    // Do not discard an edit that arrived while this source was compiling.
    cancelReload(pluginName, source);
    const previous = capabilities.get(pluginName);
    const previousVersion = previous?.version ?? -1;
    const storedManifest = options.manifest
      ? null
      : readCapabilityManifest(fs, pluginName, options.builtin ?? false);
    const manifest = options.manifest ?? previous?.manifest ?? storedManifest?.manifest;
    const manifestSource = options.manifestSource ?? previous?.manifestSource ?? storedManifest?.source;

    const entry = await mountPlugin(pluginName, plugin, {
      builtin: options.builtin,
      config: options.config !== undefined ? options.config : previous?.config ?? null,
      parent: parentFor(manifest?.scope),
      ...(manifest ? { manifest, manifestSource } : {}),
    });
    // A compile probe cannot see apply-time failures. When dependencies are
    // already satisfied, wait for activation and restore the previous plugin
    // definition if the new Fiber fails. PENDING is a valid stable state and
    // must not block HMR while a declared service is absent.
    if (entry.fiber && entry.fiber.state !== 0) {
      try {
        await entry.fiber.await();
      } catch (error) {
        await unmountPlugin(pluginName);
        if (previous) {
          const restored = await mountPlugin(pluginName, previous.plugin, {
            config: previous.config,
            parent: parentFor(previous.manifest.scope),
            manifest: previous.manifest,
            manifestSource: previous.manifestSource,
          });
          restored.version = previous.version;
          restored.hmrError = errorMessage(error);
        }
        throw error;
      }
    }
    entry.version = previousVersion + 1;
    if (options.bumpManifest ?? Boolean(previous && !options.manifest)) bumpCapabilityVersion(entry);
    entry.hmrError = '';
    await persistCapabilityPackage(fs, entry, source);
    return entry;
  }

  async function tryActivate(pluginName: string, source: string, options: ActivateOptions = {}) {
    try { return { entry: await activate(pluginName, source, options), error: '' }; }
    catch (error) { return { entry: null, error: errorMessage(error) }; }
  }

  function armReload(pluginName: string, source: string): void {
    cancelReload(pluginName);
    const timer = setTimeout(() => {
      const state = reloads.get(pluginName);
      if (state?.phase !== 'debouncing' || state.timer !== timer) return;
      if (loopBusy) {
        reloads.set(pluginName, { phase: 'queued', source: state.source });
        log(`HMR: [${pluginName}] changed during a run — reload queued for the next safe point`, 'warn');
      } else {
        reloads.delete(pluginName);
        void reload(pluginName, state.source);
      }
    }, 300);
    reloads.set(pluginName, { phase: 'debouncing', source, timer });
  }

  function takeReloadBatch(): Array<[pluginName: string, source: string]> {
    const states = [...reloads];
    reloads.clear();
    for (const [, state] of states) if (state.phase === 'debouncing') clearTimeout(state.timer);
    return states.map(([pluginName, state]) => [pluginName, state.source]);
  }

  async function flushReloads(): Promise<void> {
    for (const [pluginName, source] of takeReloadBatch()) await reload(pluginName, source);
  }

  async function reload(pluginName: string, content: string): Promise<void> {
    if (!capabilities.has(pluginName) || fs.read(capabilityIndexPath(pluginName)) === content) return;
    const result = await tryActivate(pluginName, content);
    if (result.entry) return log(`HMR: plugin [${pluginName}] hot-reloaded through a new Cordis fiber`, 'ok');
    const entry = capabilities.get(pluginName);
    if (entry) entry.hmrError = result.error;
    log(`HMR: new source for [${pluginName}] was rejected (${result.error}); the previous plugin is active`, 'err');
  }

  async function initialize({ defaults, search }: ManagerBootstrap): Promise<void> {
    const refreshed = new Set<string>();
    await Promise.all([fs.ready, task()?.ready]);
    const params = new URLSearchParams(search ?? globalThis.location?.search ?? '');
    if (params.has('reset')) {
      for (const path of fs.list().filter(path => path.startsWith(PLUGIN_DIR) || path.startsWith(CAPABILITY_PACKAGE_ROOT))) await fs.remove(path);
      log('factory reset: capability packages wiped, reseeding shipped defaults', 'warn');
      globalThis.history?.replaceState?.(null, '', globalThis.location?.pathname ?? '/');
    }

    for (const pluginName of reserved) {
      const packageRoot = `${CAPABILITY_PACKAGE_ROOT}${pluginName}/`;
      const legacyPaths = fs.list().filter(path => path === `${PLUGIN_DIR}${pluginName}.js` || path.startsWith(packageRoot));
      for (const path of legacyPaths) await fs.remove(path);
      if (legacyPaths.length) log(`boot: removed legacy OPFS copy of system plugin [${pluginName}]`, 'ok');
    }

    for (const [pluginName, definition] of Object.entries(defaults)) {
      if (reserved.has(pluginName)) continue;
      const path = `${PLUGIN_DIR}${pluginName}.js`;
      const workingSource = fs.read(path);
      if (pluginPolicy(pluginName).source === 'protected') {
        if (workingSource !== definition.source) {
          await fs.write(path, definition.source);
          if (workingSource != null) log(`boot: restored locked shipped capability [${pluginName}]`, 'warn');
        }
        continue;
      }
      if (workingSource == null) { await fs.write(path, definition.source); continue; }
      if (workingSource === definition.source) continue;
      let storedManifest: ReturnType<typeof readCapabilityManifest> = null;
      try { storedManifest = readCapabilityManifest(fs, pluginName, true); }
      catch { /* activation reports malformed manifests without overwriting their source */ }
      const activeSource = fs.read(capabilityIndexPath(pluginName));
      if (storedManifest?.source !== 'generated' || storedManifest.manifest.version !== '0.1.0' || activeSource !== workingSource) continue;
      await fs.write(path, definition.source);
      refreshed.add(pluginName);
      log(`boot: updated untouched shipped capability [${pluginName}]`, 'ok');
    }

    const stored = fs.list()
      .filter(path => path.startsWith(PLUGIN_DIR) && path.endsWith('.js'))
      .map(path => path.slice(PLUGIN_DIR.length, -3));
    const names = [...Object.keys(defaults).filter(pluginName => !reserved.has(pluginName)),
      ...stored.filter(pluginName => !reserved.has(pluginName) && !(pluginName in defaults))];
    for (const pluginName of names) {
      const definition = defaults[pluginName];
      if (definition?.autoMount === false) continue;
      const policy = pluginPolicy(pluginName);
      const protectedSource = policy.source === 'protected';
      const source = protectedSource ? definition?.source : fs.read(`${PLUGIN_DIR}${pluginName}.js`) ?? definition?.source;
      if (source == null) continue;
      const builtin = pluginName in defaults;
      let storedManifest: ReturnType<typeof readCapabilityManifest> = null;
      try { if (!protectedSource) storedManifest = readCapabilityManifest(fs, pluginName, builtin); }
      catch { /* activate reports the stored manifest error */ }
      const trustedManifest = protectedSource ? legacyCapabilityManifest(pluginName, true) : storedManifest?.manifest;
      const scope = trustedManifest?.scope ?? (builtin ? 'global' : 'task');
      if (task() && scope === 'task' && !task()?.activeTask()?.capabilityIds.includes(pluginName)) continue;
      const activeSource = fs.read(capabilityIndexPath(pluginName));
      const options: ActivateOptions = {
        builtin,
        ...(trustedManifest ? {
          manifest: trustedManifest,
          manifestSource: protectedSource ? 'generated' as const : storedManifest!.source,
        } : {}),
        bumpManifest: !protectedSource && !refreshed.has(pluginName) && activeSource != null && activeSource !== source
          && (storedManifest?.source ?? 'generated') === 'generated',
      };
      const result = await tryActivate(pluginName, source, options);
      if (result.entry) continue;
      const fallbackSource = protectedSource ? null : fs.read(capabilityIndexPath(pluginName));
      if (!fallbackSource || fallbackSource === source) {
        log(`boot: plugin ${pluginName} failed to activate: ${result.error} — skipped (fix the draft, remove_plugin it, or ?reset)`, 'err');
        continue;
      }
      const fallback = capabilities.get(pluginName)
        ? { entry: capabilities.get(pluginName)!, error: '' }
        : await tryActivate(pluginName, fallbackSource, { ...options, bumpManifest: false });
      if (!fallback.entry) {
        if (capabilities.has(pluginName)) await unmountPlugin(pluginName);
        log(`boot: plugin ${pluginName} and its last active revision failed: ${fallback.error}`, 'err');
        continue;
      }
      fallback.entry.hmrError = `Working draft rejected during boot: ${result.error}`;
      log(`boot: plugin ${pluginName} working draft was rejected; restored the last active revision`, 'warn');
    }
    log(`boot complete: ${names.length} plugin file(s) processed`, 'ok');
  }

  function catalogEntry(pluginName: string): CapabilityCatalogEntry | null {
    if (reserved.has(pluginName)) return null;
    const entry = capabilities.get(pluginName);
    const policy = pluginPolicy(pluginName);
    let manifest = entry?.manifest;
    try {
      manifest ??= policy.source === 'protected' && bootstrap?.defaults[pluginName]
        ? legacyCapabilityManifest(pluginName, true)
        : readCapabilityManifest(fs, pluginName, false)?.manifest ?? legacyCapabilityManifest(pluginName, false);
    }
    catch { return null; }
    const health = entry ? capabilityHealth(entry) : null;
    return {
      id: manifest.id, title: manifest.title,
      description: manifest.description ?? '', scope: manifest.scope, version: manifest.version,
      status: entry?.status ?? 'disposed',
      attached: manifest.scope !== 'task' || Boolean(task()?.activeTask()?.capabilityIds.includes(manifest.id)),
      providers: [...(manifest.requires.providers ?? [])],
      permissions: manifest.permissions.map(permission => permission.id),
      contributes: emptyContributionInventory(entry?.contributions ?? manifest.contributes),
      health: health?.state ?? 'healthy', issues: health?.issues ?? [],
      source: policy.source, editable: policy.source === 'editable', reloadBoundary: policy.reload,
    };
  }

  const service: ManagerService = {
    catalog: () => [...new Set([
      ...capabilities.keys(),
      ...fs.list().filter(path => path.startsWith(PLUGIN_DIR) && path.endsWith('.js')).map(path => path.slice(PLUGIN_DIR.length, -3)),
    ])].map(catalogEntry).filter((entry): entry is CapabilityCatalogEntry => Boolean(entry)),
    async create(pluginName, source, manifest) {
      if (!/^[a-z][a-z0-9_-]*$/iu.test(pluginName || '')) return 'Error: name must start with a letter, only letters/digits/-/_';
      if (reserved.has(pluginName)) return `Error: ${pluginName} is a reserved system plugin name`;
      if (isPluginSourceLocked(pluginName)) return `Error: plugin ${pluginName} is protected and cannot be replaced by Agent source`;
      const draftPath = PLUGIN_DIR + pluginName + '.js';
      if (capabilities.has(pluginName) || fs.read(draftPath) != null) {
        return `Error: capability ${pluginName} already exists; edit ${draftPath} for HMR or remove it before creating a replacement`;
      }
      let normalizedManifest: CapabilityManifest | undefined;
      try { normalizedManifest = manifest ? validateCapabilityManifest(manifest, pluginName) : undefined; }
      catch (error: unknown) { return `Error: invalid capability manifest: ${errorMessage(error)}`; }

      const result = await tryActivate(pluginName, source, {
        manifest: normalizedManifest ?? legacyCapabilityManifest(pluginName, false),
        manifestSource: normalizedManifest ? 'declared' : 'generated',
      });
      if (!result.entry) return `Error: plugin ${pluginName} failed to activate: ${result.error}`;
      // The editable file is a draft pointer. Publish it only after the
      // candidate Fiber and active capability revision have succeeded.
      await fs.write(draftPath, source);
      if (result.entry.manifest.scope === 'task') await task()?.attachCapability(result.entry.manifest.id);
      return `plugin ${pluginName} compiled and mounted; ${result.entry.contributions.panels.length ? `visible UI: ${result.entry.contributions.panels.join(', ')}` : 'no UI panel registered'}`;
    },
    async mount(pluginName, config) {
      if (reserved.has(pluginName)) return `Error: ${pluginName} is a bundled system plugin and cannot be mounted from OPFS`;
      const definition = bootstrap?.defaults[pluginName];
      const protectedSource = pluginPolicy(pluginName).source === 'protected';
      if (protectedSource && !definition) return `Error: plugin ${pluginName} is protected and has no trusted bundled source`;
      const source = protectedSource ? definition!.source : fs.read(PLUGIN_DIR + pluginName + '.js');
      if (source == null) return `Error: no source at ${PLUGIN_DIR + pluginName + '.js'}`;
      const result = await tryActivate(pluginName, source, {
        config: config ?? null,
        ...(protectedSource ? {
          builtin: true,
          manifest: legacyCapabilityManifest(pluginName, true),
          manifestSource: 'generated' as const,
        } : {}),
      });
      if (!result.entry) return `Error: plugin ${pluginName} failed to activate: ${result.error}`;
      if (result.entry.manifest.scope === 'task') await task()?.attachCapability(result.entry.manifest.id);
      return `plugin ${pluginName} mounted`;
    },
    async unmount(pluginName) {
      if (!await unmountPlugin(pluginName)) return `Error: plugin ${pluginName} is not mounted`;
      await task()?.detachCapability(pluginName);
      return `plugin ${pluginName} unmounted (file kept)`;
    },
    async remove(pluginName) {
      if (reserved.has(pluginName)) return `Error: ${pluginName} is a bundled system plugin and cannot be removed`;
      if (isPluginSourceLocked(pluginName)) return `Error: plugin ${pluginName} is protected and cannot be removed`;
      const mounted = capabilities.has(pluginName);
      const path = PLUGIN_DIR + pluginName + '.js';
      if (!mounted && fs.read(path) == null) return `Error: plugin ${pluginName} does not exist (mounted: ${[...capabilities.keys()].join(', ') || 'none'})`;
      cancelReload(pluginName);
      if (mounted) await unmountPlugin(pluginName);
      await fs.remove(path);
      await task()?.detachCapability(pluginName);
      return mounted
        ? `plugin ${pluginName} unmounted; its Cordis effects and source are gone`
        : `plugin ${pluginName} was not running; its file was deleted`;
    },
  };

  new ManagerRuntime(ctx, service);

  const mountIfMissing = async (id: string) => { if (!capabilities.has(id)) await service.mount(id); };
  ctx.on('task/activated', async () => {
    for (const id of task()?.activeTask()?.capabilityIds ?? []) await mountIfMissing(id);
  });
  ctx.on('task/capability-attached', mountIfMissing);
  ctx.on('task/capability-detached', async (id: string) => {
    const entry = capabilities.get(id);
    if (entry?.manifest.scope === 'task') await unmountPlugin(id);
  });
  ctx.on('loop/busy', () => { loopBusy = true; });
  ctx.on('loop/safe-point', async () => {
    // A tool may have written its own source only milliseconds ago. Treat the
    // turn boundary as a commit barrier instead of waiting out the editor's
    // ordinary 300-ms debounce, so the next request sees the new generation.
    await flushReloads();
  });
  ctx.on('loop/idle', async () => {
    loopBusy = false;
    await flushReloads();
  });
  ctx.on('workspace/changed', (path: string, content: string | null) => {
    if (!path.startsWith(PLUGIN_DIR) || !path.endsWith('.js') || content == null) return;
    const pluginName = path.slice(PLUGIN_DIR.length, -3);
    if (reserved.has(pluginName) || isPluginSourceLocked(pluginName)) return;
    if (fs.read(capabilityIndexPath(pluginName)) === content) {
      // Undoing an edit back to the active revision must also cancel a queued
      // or debouncing revision; otherwise that stale source could mount at
      // the next safe point even though the workspace no longer contains it.
      cancelReload(pluginName);
      return;
    }
    armReload(pluginName, content);
  });

  ctx.effect(() => () => {
    for (const state of reloads.values()) if (state.phase === 'debouncing') clearTimeout(state.timer);
    reloads.clear();
    log('manager plugin unmounted', 'warn');
  }, 'manager.hmr');
  return bootstrap ? initialize(bootstrap) : undefined;
}

export function createManagerPlugin(bootstrap?: ManagerBootstrap, requireTask = Boolean(bootstrap)) {
  return { name, inject: requireTask ? [...inject, 'task'] : inject, apply: (ctx: Context) => apply(ctx, bootstrap) };
}

export const managerPlugin = createManagerPlugin();
