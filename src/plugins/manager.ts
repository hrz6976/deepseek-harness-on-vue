import { Service, type Context, type Plugin } from '@deepseek-ai/cordis';
import { watch } from 'vue';
import type { WatchStopHandle } from 'vue';
import { log } from '@/kernel/log';
import { compilePlugin } from '@/kernel/compile';
import { plugins, mountPlugin, unmountPlugin } from '@/kernel/host';
import { PLUGIN_DIR } from '@/kernel/boot';
import { bumpCapabilityVersion, capabilities, capabilityHealth, validateCapabilityManifest } from '@/kernel/capabilities';
import { persistCapabilityPackage, readCapabilityManifest } from '@/kernel/capability-package';
import type { CapabilityManifest } from '@/shared/capability-protocol';
import { systemPluginNames } from '@/kernel/system-plugin-names';
import type { ManagerService } from '@/shared/runtime';
import { errorMessage } from '@/shared/runtime';
import { principalForContext } from '@/kernel/broker';
import { assertPrincipalPermission } from '@/shared/capability-policy';

class ManagerRuntime extends Service implements ManagerService {
  constructor(ctx: Context, readonly implementation: ManagerService) {
    super(ctx, 'manager');
  }

  private authorize(): void {
    assertPrincipalPermission(principalForContext(this.ctx), 'capability.manage');
  }

  list(): string[] {
    this.authorize();
    return this.implementation.list();
  }

  catalog() {
    this.authorize();
    return this.implementation.catalog();
  }

  create(name: string, source: string, manifest?: CapabilityManifest): Promise<string> {
    this.authorize();
    return this.implementation.create(name, source, manifest);
  }

  mount(name: string, config?: Record<string, unknown> | null): Promise<string> {
    this.authorize();
    return this.implementation.mount(name, config);
  }

  unmount(name: string): Promise<string> {
    this.authorize();
    return this.implementation.unmount(name);
  }

  remove(name: string): Promise<string> {
    this.authorize();
    return this.implementation.remove(name);
  }
}

export const name = 'manager';
export const inject = ['fs'];

export function apply(ctx: Context): void {
  const loaded = new Map<string, { source: string | null }>();
  const watchers = new Map<string, WatchStopHandle>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingReloads = new Map<string, string>();
  let stopFlush: WatchStopHandle | null = null;

  const fs = ctx.fs;
  const loop = () => ctx.reflect.get('loop') as import('../shared/runtime').LoopService | undefined;
  const task = () => ctx.reflect.get('task') as import('../shared/runtime').TaskRuntimeService | undefined;

  async function loadAndMount(
    pluginName: string,
    source: string,
    plugin: Plugin,
    config?: Record<string, unknown> | null,
    manifestOverride?: CapabilityManifest,
  ) {
    clearTimeout(debounceTimers.get(pluginName));
    const previous = plugins.find(entry => entry.name === pluginName);
    const previousVersion = previous?.version ?? -1;
    const previousManifest = previous?.manifest;
    const previousManifestSource = previous?.manifestSource;
    const previousSource = loaded.get(pluginName)?.source ?? null;
    const nextConfig = config !== undefined ? config : previous?.config ?? null;
    const storedManifest = readCapabilityManifest(fs, pluginName, false);
    const manifest = manifestOverride ?? previousManifest ?? storedManifest?.manifest;
    const manifestSource = manifestOverride
      ? 'declared' as const
      : previousManifestSource ?? storedManifest?.source;

    const entry = await mountPlugin(pluginName, plugin, {
      config: nextConfig,
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
            builtin: previous.builtin,
            config: previous.config,
            manifest: previous.manifest,
            manifestSource: previous.manifestSource,
          });
          restored.version = previous.version;
          restored.hmrError = errorMessage(error);
          loaded.set(pluginName, { source: previousSource });
          attachWatcher(pluginName);
        }
        throw error;
      }
    }
    entry.version = previousVersion + 1;
    if (previous && !manifestOverride) bumpCapabilityVersion(entry);
    entry.hmrError = '';
    if (entry.manifest.scope === 'task') void task()?.attachCapability(entry.manifest.id);
    loaded.set(pluginName, { source });
    attachWatcher(pluginName);
    return entry;
  }

  async function archiveMountedCapability(pluginName: string, source: string): Promise<void> {
    const entry = plugins.find(plugin => plugin.name === pluginName);
    if (entry) await persistCapabilityPackage(fs, entry, source);
  }

  function attachWatcher(pluginName: string): void {
    if (systemPluginNames.has(pluginName)) return;
    if (watchers.has(pluginName)) return;
    const path = PLUGIN_DIR + pluginName + '.js';
    const stop = watch(
      () => fs.read(path),
      content => {
        if (content == null || loaded.get(pluginName)?.source === content) return;
        clearTimeout(debounceTimers.get(pluginName));
        debounceTimers.set(pluginName, setTimeout(() => scheduleReload(pluginName, content), 300));
      },
    );
    watchers.set(pluginName, stop);
  }

  function scheduleReload(pluginName: string, content: string): void {
    if (loop()?.running.value) {
      pendingReloads.set(pluginName, content);
      stopFlush ??= watch(() => loop()?.running.value, running => {
        if (running) return;
        stopFlush?.();
        stopFlush = null;
        const batch = [...pendingReloads];
        pendingReloads.clear();
        for (const [pendingName, pendingSource] of batch) void reload(pendingName, pendingSource);
      });
      log(`HMR: [${pluginName}] changed during a run — reload deferred until the run ends`, 'warn');
      return;
    }
    void reload(pluginName, content);
  }

  async function reload(pluginName: string, content: string): Promise<void> {
    if (!plugins.find(plugin => plugin.name === pluginName)) {
      loaded.set(pluginName, { source: content });
      return;
    }
    try {
      const plugin = await compilePlugin(pluginName, content);
      await loadAndMount(pluginName, content, plugin);
      await archiveMountedCapability(pluginName, content);
      log(`HMR: plugin [${pluginName}] hot-reloaded through a new Cordis fiber`, 'ok');
      ctx.emit('plugin/reloaded', pluginName);
    } catch (error: unknown) {
      const entry = plugins.find(plugin => plugin.name === pluginName);
      if (entry) entry.hmrError = errorMessage(error);
      log(`HMR: new source for [${pluginName}] was rejected (${errorMessage(error)}); the previous plugin is active`, 'err');
    }
  }

  const service: ManagerService = {
    list: () => [...loaded.keys()],
    catalog: () => [...capabilities.values()].map(entry => {
      const health = capabilityHealth(entry);
      return {
        kind: 'capability' as const,
        id: entry.manifest.id,
        name: entry.name,
        title: entry.manifest.title,
        description: entry.manifest.description ?? '',
        scope: entry.manifest.scope,
        version: entry.manifest.version,
        status: entry.status,
        attached: entry.manifest.scope !== 'task' || Boolean(task()?.activeTask()?.capabilityIds.includes(entry.manifest.id)),
        providers: [...(entry.manifest.requires.providers ?? [])],
        permissions: entry.manifest.permissions.map(permission => permission.id),
        contributes: JSON.parse(JSON.stringify(entry.contributions)),
        health: health.state,
        issues: health.issues,
      };
    }),
    async create(pluginName, source, manifest) {
      if (!/^[a-z][a-z0-9_-]*$/iu.test(pluginName || '')) return 'Error: name must start with a letter, only letters/digits/-/_';
      if (systemPluginNames.has(pluginName)) return `Error: ${pluginName} is a reserved system plugin name`;
      let normalizedManifest: CapabilityManifest | undefined;
      try { normalizedManifest = manifest ? validateCapabilityManifest(manifest, pluginName) : undefined; }
      catch (error: unknown) { return `Error: invalid capability manifest: ${errorMessage(error)}`; }

      let plugin: Plugin;
      try { plugin = await compilePlugin(pluginName, source); }
      catch (error: unknown) { return `Error: plugin ${pluginName} failed to compile: ${errorMessage(error)}`; }
      const taskRuntime = task();
      const taskScoped = (normalizedManifest?.scope ?? 'task') === 'task';
      const wasAttached = Boolean(taskRuntime?.activeTask()?.capabilityIds.includes(pluginName));
      if (taskScoped && !wasAttached) await taskRuntime?.attachCapability(pluginName);
      try {
        await loadAndMount(pluginName, source, plugin, undefined, normalizedManifest);
        await archiveMountedCapability(pluginName, source);
        // The editable file is a draft pointer. Publish it only after the
        // candidate Fiber and active capability revision have succeeded.
        await fs.write(PLUGIN_DIR + pluginName + '.js', source);
        return `plugin ${pluginName} compiled and mounted; its Cordis contributions are live`;
      } catch (error) {
        if (taskScoped && !wasAttached) await taskRuntime?.detachCapability(pluginName);
        throw error;
      }
    },
    async mount(pluginName, config) {
      if (systemPluginNames.has(pluginName)) return `Error: ${pluginName} is a bundled system plugin and cannot be mounted from OPFS`;
      const source = fs.read(PLUGIN_DIR + pluginName + '.js');
      if (source == null) return `Error: no source at ${PLUGIN_DIR + pluginName + '.js'}`;
      try {
        const plugin = await compilePlugin(pluginName, source);
        await loadAndMount(pluginName, source, plugin, config ?? null);
        await archiveMountedCapability(pluginName, source);
        return `plugin ${pluginName} mounted`;
      } catch (error: unknown) {
        return `Error: plugin ${pluginName} failed to compile: ${errorMessage(error)}`;
      }
    },
    async unmount(pluginName) {
      if (!await unmountPlugin(pluginName)) return `Error: plugin ${pluginName} is not mounted`;
      await task()?.detachCapability(pluginName);
      return `plugin ${pluginName} unmounted (file kept)`;
    },
    async remove(pluginName) {
      if (systemPluginNames.has(pluginName)) return `Error: ${pluginName} is a bundled system plugin and cannot be removed`;
      const capabilityId = plugins.find(plugin => plugin.name === pluginName)?.manifest.id ?? pluginName;
      if (!plugins.find(plugin => plugin.name === pluginName)) {
        if (fs.read(PLUGIN_DIR + pluginName + '.js') != null) {
          await fs.remove(PLUGIN_DIR + pluginName + '.js');
          loaded.delete(pluginName);
          watchers.get(pluginName)?.();
          watchers.delete(pluginName);
          await task()?.detachCapability(capabilityId);
          return `plugin ${pluginName} was not running; its file was deleted`;
        }
        return `Error: plugin ${pluginName} does not exist (mounted: ${plugins.map(plugin => plugin.name).join(', ') || 'none'})`;
      }
      loaded.delete(pluginName);
      watchers.get(pluginName)?.();
      watchers.delete(pluginName);
      clearTimeout(debounceTimers.get(pluginName));
      pendingReloads.delete(pluginName);
      await unmountPlugin(pluginName);
      await fs.remove(PLUGIN_DIR + pluginName + '.js');
      await task()?.detachCapability(capabilityId);
      return `plugin ${pluginName} unmounted; its Cordis effects and source are gone`;
    },
  };

  new ManagerRuntime(ctx, service);

  // Boot seeds and mounts capabilities after this kernel service is alive.
  // Discover each new editable source as it arrives so first-run files get
  // the same HMR watcher as files restored before startup.
  ctx.on('plugin/mounted', (pluginName: string) => {
    if (systemPluginNames.has(pluginName)) return;
    const source = fs.read(PLUGIN_DIR + pluginName + '.js');
    if (source == null) return;
    if (!loaded.has(pluginName)) loaded.set(pluginName, { source });
    attachWatcher(pluginName);
  });

  void fs.ready.then(() => {
    for (const path of fs.list().filter(path => path.startsWith(PLUGIN_DIR) && path.endsWith('.js'))) {
      const pluginName = path.slice(PLUGIN_DIR.length, -3);
      if (systemPluginNames.has(pluginName)) continue;
      if (!loaded.has(pluginName)) loaded.set(pluginName, { source: fs.read(path) });
      attachWatcher(pluginName);
    }
  });

  ctx.effect(() => () => {
    for (const stop of watchers.values()) stop();
    watchers.clear();
    stopFlush?.();
    stopFlush = null;
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    log('manager plugin unmounted', 'warn');
  }, 'manager.watchers');
}

export const managerPlugin = { name, inject, apply };
export default managerPlugin;
