import { Service, type Context, type Plugin } from '@deepseek-ai/cordis';
import { log } from '@/kernel/log';
import { unmountPlugin } from '@/kernel/host';
import { capabilities, capabilityHealth, emptyContributionInventory, legacyCapabilityManifest, validateCapabilityManifest } from '@/kernel/capabilities';
import { CAPABILITY_PACKAGE_ROOT, PLUGIN_DIR, installedCapabilityIds, readCapabilityPackage } from '@/kernel/capability-package';
import type { CapabilityManifest } from '@/shared/capability-protocol';
import { SYSTEM_PLUGIN_NAMES } from '@/kernel/system-plugin-names';
import { isPluginSourceLocked, pluginPolicy } from '@/kernel/plugin-policy';
import type { CapabilityCatalogEntry, ManagerService } from '@/shared/runtime';
import { errorMessage } from '@/shared/runtime';
import { createReloadQueue } from './manager/reload-queue';
import { createActivator } from './manager/activation';
import { initializeCapabilities } from './manager/bootstrap';
import type { PluginDefaults } from '@/shared/runtime';
import { principalForContext } from '@/kernel/broker';
import { assertPrincipalPermission } from '@/shared/capability-policy';

export interface ManagerBootstrap { defaults: PluginDefaults; search?: string; reservedNames?: readonly string[] }

function applyManager(ctx: Context, bootstrap?: ManagerBootstrap): void | Promise<void> {
  const reserved = new Set(bootstrap?.reservedNames ?? SYSTEM_PLUGIN_NAMES);

  const fs = ctx.fs;
  let operations = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = operations.then(operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  }
  const task = () => ctx.get('task');
  const parentFor = (scope = 'task') => scope === 'task' ? task()?.scope() ?? ctx : ctx;
  const queue = createReloadQueue((name, content) => serial(() => reload(name, content)));
  const tryActivate = createActivator(fs, parentFor, queue.cancel, async manifest => ctx.get('broker')?.request({ provider: 'runtime', action: 'authorize', input: { manifest } }, ctx.get('task')?.signal));

  async function reload(pluginName: string, content: string): Promise<void> {
    if (!capabilities.has(pluginName) || readCapabilityPackage(fs, pluginName)?.source === content) return;
    const result = await tryActivate(pluginName, content);
    if (result.entry) return log(`HMR: plugin [${pluginName}] hot-reloaded through a new Cordis fiber`, 'ok');
    const entry = capabilities.get(pluginName);
    if (entry) entry.hmrError = result.error;
    log(`HMR: new source for [${pluginName}] was rejected (${result.error}); inspect runtime status before retrying`, 'err');
  }

  function catalogEntry(pluginName: string): CapabilityCatalogEntry | null {
    if (reserved.has(pluginName)) return null;
    const entry = capabilities.get(pluginName);
    const policy = pluginPolicy(pluginName);
    let manifest = entry?.manifest;
    try {
      manifest ??= policy.source === 'protected' && bootstrap?.defaults[pluginName]
        ? legacyCapabilityManifest(pluginName, true)
        : readCapabilityPackage(fs, pluginName)?.manifest ?? legacyCapabilityManifest(pluginName, false);
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
      contributes: emptyContributionInventory(entry?.contributions),
      health: health?.state ?? 'healthy', issues: health?.issues ?? [],
      source: policy.source, editable: policy.source === 'editable', reloadBoundary: policy.reload,
    };
  }

  const service: ManagerService = {
    catalog: () => [...new Set([
      ...capabilities.keys(),
      ...installedCapabilityIds(fs),
    ])].map(catalogEntry).filter((entry): entry is CapabilityCatalogEntry => Boolean(entry)),
    create: (pluginName, source, manifest) => serial(async () => {
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
      });
      if (!result.entry) return `Error: plugin ${pluginName} failed to activate: ${result.error}`;
      // The editable file is a draft pointer. Publish it only after the
      // candidate Fiber and active capability revision have succeeded.
      await fs.write(draftPath, source);
      return `plugin ${pluginName} compiled and mounted; ${result.entry.contributions.panels.length ? `visible UI: ${result.entry.contributions.panels.join(', ')}` : 'no UI panel registered'}`;
    }),
    mount: (pluginName, config) => serial(async () => {
      if (reserved.has(pluginName)) return `Error: ${pluginName} is a bundled system plugin and cannot be mounted from OPFS`;
      const definition = bootstrap?.defaults[pluginName];
      const protectedSource = pluginPolicy(pluginName).source === 'protected';
      if (protectedSource && !definition) return `Error: plugin ${pluginName} is protected and has no trusted bundled source`;
      const source = protectedSource ? definition!.source : fs.read(PLUGIN_DIR + pluginName + '.js') ?? readCapabilityPackage(fs, pluginName)?.source;
      if (source == null) return `Error: no source at ${PLUGIN_DIR + pluginName + '.js'}`;
      const result = await tryActivate(pluginName, source, {
        config: config ?? null,
        ...(protectedSource ? {
          builtin: true,
          manifest: legacyCapabilityManifest(pluginName, true),
        } : {}),
      });
      if (!result.entry) return `Error: plugin ${pluginName} failed to activate: ${result.error}`;
      return `plugin ${pluginName} mounted`;
    }),
    unmount: pluginName => serial(async () => {
      if (!await unmountPlugin(pluginName)) return `Error: plugin ${pluginName} is not mounted`;
      await task()?.setCapability(pluginName, false);
      return `plugin ${pluginName} unmounted (file kept)`;
    }),
    remove: pluginName => serial(async () => {
      if (reserved.has(pluginName)) return `Error: ${pluginName} is a bundled system plugin and cannot be removed`;
      if (isPluginSourceLocked(pluginName)) return `Error: plugin ${pluginName} is protected and cannot be removed`;
      const mounted = capabilities.has(pluginName);
      const path = PLUGIN_DIR + pluginName + '.js';
      if (!mounted && fs.read(path) == null) return `Error: plugin ${pluginName} does not exist (mounted: ${[...capabilities.keys()].join(', ') || 'none'})`;
      queue.cancel(pluginName);
      if (mounted) await unmountPlugin(pluginName);
      await fs.remove(path);
      for (const packagePath of fs.list().filter(path => path.startsWith(`${CAPABILITY_PACKAGE_ROOT}${pluginName}/`))) await fs.remove(packagePath);
      await task()?.setCapability(pluginName, false);
      return mounted
        ? `plugin ${pluginName} unmounted; its Cordis effects and source are gone`
        : `plugin ${pluginName} was not running; its file was deleted`;
    }),
  };

  new ManagerRuntime(ctx, service);

  ctx.on('task/activated', async () => {
    for (const id of task()?.activeTask()?.capabilityIds ?? []) {
      if (!capabilities.has(id)) await service.mount(id);
    }
  });
  ctx.on('loop/busy', () => { queue.setBusy(true); });
  ctx.on('loop/safe-point', async () => {
    // A tool may have written its own source only milliseconds ago. Treat the
    // turn boundary as a commit barrier instead of waiting out the editor's
    // ordinary 300-ms debounce, so the next request sees the new generation.
    await queue.flush();
  });
  ctx.on('loop/idle', async () => {
    queue.setBusy(false);
    await queue.flush();
  });
  ctx.on('workspace/changed', (path: string, content: string | null) => {
    if (!path.startsWith(PLUGIN_DIR) || !path.endsWith('.js') || content == null) return;
    const pluginName = path.slice(PLUGIN_DIR.length, -3);
    if (reserved.has(pluginName) || isPluginSourceLocked(pluginName)) return;
    if (readCapabilityPackage(fs, pluginName)?.source === content) {
      // Undoing an edit back to the active revision must also cancel a queued
      // or debouncing revision; otherwise that stale source could mount at
      // the next safe point even though the workspace no longer contains it.
      queue.cancel(pluginName);
      return;
    }
    queue.arm(pluginName, content);
  });

  ctx.effect(() => () => {
    queue.dispose();
    log('manager plugin unmounted', 'warn');
  }, 'manager.hmr');
  return bootstrap ? serial(() => initializeCapabilities(bootstrap, fs, reserved, task, tryActivate)) : undefined;
}

// Public calls validate the traced caller. The implementation closure owns
// manager-authorized persistence and internal task/HMR callbacks.
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

export function createManagerPlugin(bootstrap?: ManagerBootstrap, requireTask = Boolean(bootstrap)): Plugin.Object {
  return {
    name: 'manager',
    inject: requireTask ? ['fs', 'task'] : ['fs'],
    apply: ctx => applyManager(ctx, bootstrap),
  };
}
export default createManagerPlugin();
