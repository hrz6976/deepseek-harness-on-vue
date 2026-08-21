// manager plugin: plugin lifecycle POLICY — create/remove/mount/unmount and
// HMR. The boot-time loading itself lives in kernel/boot.js (the kernel seeds
// and mounts; this plugin governs changes afterwards). Editing any
// .plugins/<name>.js through the fs service triggers a hot reload; the
// reactive fs cache is itself the change signal. Since the manager is loaded
// from .plugins/ too, it can hot-reload ITSELF: the old instance's watchers
// stop on unmount and the new instance re-attaches from fs.list().
import { watch, onUnmounted, getCurrentInstance } from 'vue';
import type { Component, WatchStopHandle } from 'vue';
import { getService, provideService } from '../kernel/services';
import { bus } from '../kernel/bus';
import { log } from '../kernel/log';
import { compilePlugin } from '../kernel/compile';
import { plugins, mountPlugin, unmountPlugin } from '../kernel/host';
import { PLUGIN_DIR } from '../kernel/boot';
import { errorMessage } from '../shared/runtime';

export const managerPlugin = {
  name: 'manager',
  setup() {
    const loaded = new Map<string, { source: string | null }>();   // name -> { source } baseline (HMR diff + own-write dedupe)
    const watchers = new Map<string, WatchStopHandle>(); // name -> watch stop handle
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const fsSvc = () => getService('fs');

    function loadAndMount(name: string, source: string, def: Component, config?: Record<string, unknown> | null): void {
      clearTimeout(debounceTimers.get(name)); // cancel any HMR timer our own write scheduled — avoids a double mount
      const entry = plugins.find(p => p.name === name);
      if (entry) { entry.def = def; entry.version++; entry.status = 'active'; entry.error = ''; entry.hmrError = ''; if (config !== undefined) entry.config = config; }
      else mountPlugin(name, def, { config: config ?? null });
      loaded.set(name, { source });
      attachWatcher(name);
    }

    function attachWatcher(name: string): void {
      if (watchers.has(name)) return;
      const path = PLUGIN_DIR + name + '.js';
      const stop = watch(
        () => fsSvc()?.read(path),
        content => {
          if (content == null) return; // deletion is handled by remove()
          if (loaded.get(name)?.source === content) return; // unchanged (our own write) — skip
          clearTimeout(debounceTimers.get(name));
          debounceTimers.set(name, setTimeout(() => scheduleReload(name, content), 300));
        },
      );
      watchers.set(name, stop);
    }

    // A reload mid-run would remount live machinery under the agent's feet
    // (the loop itself, chat, a tool the model already selected) — defer ALL
    // reloads until the run ends, then flush.
    const pendingReloads = new Map<string, string>(); // name -> content
    let stopFlush: WatchStopHandle | null = null;
    function scheduleReload(name: string, content: string): void {
      if (getService('loop')?.running.value) {
        pendingReloads.set(name, content);
        stopFlush ??= watch(() => getService('loop')?.running.value, running => {
          if (running) return;
          stopFlush?.(); stopFlush = null;
          const batch = [...pendingReloads]; pendingReloads.clear();
          for (const [n, c] of batch) void reload(n, c);
        });
        log(`HMR: [${name}] changed during a run — reload deferred until the run ends`, 'warn');
        return;
      }
      void reload(name, content);
    }

    // HMR rollback semantics: compile-probe first (module top-level errors are
    // caught there); only then swap def + version++ (key change = clean whole
    // remount). Compile failure -> the OLD version keeps running, hmrError set.
    // A plugin that is present on disk but NOT mounted (llm while disconnected)
    // only gets its baseline refreshed — no surprise configless mount.
    async function reload(name: string, content: string): Promise<void> {
      if (!plugins.find(p => p.name === name)) { loaded.set(name, { source: content }); return; }
      try {
        const def = await compilePlugin(name, content);
        loadAndMount(name, content, def);
        log(`HMR: plugin [${name}] hot-reloaded`, 'ok');
        bus.emit('plugin/reloaded', name);
      } catch (error: unknown) {
        const entry = plugins.find(p => p.name === name);
        if (entry) entry.hmrError = errorMessage(error);
        log(`HMR: new source for [${name}] failed to compile (${errorMessage(error)}), old version keeps running`, 'err');
      }
    }

    provideService('manager', {
      list: () => [...loaded.keys()], // every managed FILE (mounted or not); the plugins array is the mounted truth
      async create(name: string, source: string) {
        if (!/^[a-z][a-z0-9_-]*$/i.test(name || '')) return 'Error: name must start with a letter, only letters/digits/-/_';
        let def: Component;
        try { def = await compilePlugin(name, source); } // probe first: a broken source is never mounted or persisted
        catch (error: unknown) { return `Error: plugin ${name} failed to compile: ${errorMessage(error)}`; }
        const fs = fsSvc();
        if (fs) await fs.write(PLUGIN_DIR + name + '.js', source); // the self-modification, persisted
        loadAndMount(name, source, def);
        return `plugin ${name} compiled and mounted; its tools/UI/prompt sections are live now`;
      },
      // mount/unmount without touching the file — the connect/disconnect
      // lifecycle (settings uses this for llm, passing the connection config
      // through as component props via PluginHost).
      async mount(name: string, config?: Record<string, unknown> | null) {
        const source = fsSvc()?.read(PLUGIN_DIR + name + '.js');
        if (source == null) return `Error: no source at ${PLUGIN_DIR + name + '.js'}`;
        try {
          const def = await compilePlugin(name, source);
          loadAndMount(name, source, def, config ?? null);
          return `plugin ${name} mounted`;
        } catch (error: unknown) { return `Error: plugin ${name} failed to compile: ${errorMessage(error)}`; }
      },
      unmount(name: string) {
        if (!unmountPlugin(name)) return `Error: plugin ${name} is not mounted`;
        return `plugin ${name} unmounted (file kept)`;
      },
      async remove(name: string) {
        if (!plugins.find(p => p.name === name)) {
          // Not running (corrupt source failed boot, or unmounted llm) but the
          // file lingers -> allow cleanup, or it haunts every boot forever.
          const fs0 = fsSvc();
          if (fs0?.read(PLUGIN_DIR + name + '.js') != null) {
            await fs0.remove(PLUGIN_DIR + name + '.js');
            loaded.delete(name);
            watchers.get(name)?.(); watchers.delete(name);
            return `plugin ${name} was not running; its file was deleted`;
          }
          return `Error: plugin ${name} does not exist (mounted: ${plugins.map(p => p.name).join(', ') || 'none'})`;
        }
        loaded.delete(name);
        watchers.get(name)?.(); watchers.delete(name);
        clearTimeout(debounceTimers.get(name));
        pendingReloads.delete(name);
        unmountPlugin(name);
        const fs = fsSvc();
        if (fs) await fs.remove(PLUGIN_DIR + name + '.js');
        // A shipped (core) plugin's file will be RESEEDED from the bundled
        // default on next boot — remove = "gone now, factory copy on refresh".
        return `plugin ${name} unmounted; its tools/UI/listeners are gone`;
      },
    });

    // Adopt what boot (or a previous manager instance, on self-HMR) loaded:
    // baseline every existing .plugins/ file and watch it. Unmounted files
    // (llm while disconnected, boot-skipped corrupt sources) get baselines
    // too, so a later edit is detected without being surprise-mounted.
    (async () => {
      const fs = fsSvc();
      if (!fs) return;
      await fs.ready;
      for (const p of fs.list().filter(p => p.startsWith(PLUGIN_DIR) && p.endsWith('.js'))) {
        const name = p.slice(PLUGIN_DIR.length, -3);
        if (!loaded.has(name)) loaded.set(name, { source: fs.read(p) });
        attachWatcher(name);
      }
    })();

    if (getCurrentInstance()) onUnmounted(() => {
      for (const stop of watchers.values()) stop();
      watchers.clear();
      stopFlush?.(); stopFlush = null;
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      log('manager plugin unmounted', 'warn');
    });
    return () => null;
  },
};

export default managerPlugin;
