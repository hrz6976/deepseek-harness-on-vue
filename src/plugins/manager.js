// manager plugin: dynamic (agent-created) plugin lifecycle — create/remove,
// OPFS persistence, boot restore, and HMR. Editing .plugins/<name>.js through
// the fs service triggers a reload; the reactive fs cache is itself the
// change signal (no watcher machinery beyond a Vue watch on the cache entry).
import { watch, onUnmounted } from 'vue';
import { services, provideService } from '../kernel/services.js';
import { bus } from '../kernel/bus.js';
import { log } from '../kernel/log.js';
import { compilePlugin } from '../kernel/compile.js';
import { plugins, mountPlugin, unmountPlugin } from '../kernel/host.js';

export const PLUGIN_DIR = '.plugins/';
const FORMAT_FILE = PLUGIN_DIR + '.format';
// Bump when the pinned plugin dialect changes (see kernel/compile.js), so a
// pre-change OPFS survivor can't brick the boot restore.
export const PLUGIN_FORMAT_VERSION = '1';

export const managerPlugin = {
  name: 'manager',
  setup() {
    const loaded = new Map();   // name -> { source } currently mounted (HMR diff baseline)
    const watchers = new Map(); // name -> watch stop handle
    const debounceTimers = new Map();

    function loadAndMount(name, source, def) {
      clearTimeout(debounceTimers.get(name)); // cancel any HMR timer our own write scheduled — avoids a double mount
      const entry = plugins.find(p => p.name === name);
      if (entry) { entry.def = def; entry.version++; entry.status = 'active'; entry.error = ''; entry.hmrError = ''; }
      else mountPlugin(name, def, { builtin: false });
      loaded.set(name, { source });
      attachWatcher(name);
    }

    function attachWatcher(name) {
      if (watchers.has(name)) return;
      const path = PLUGIN_DIR + name + '.js';
      const stop = watch(
        () => services.get('fs')?.value?.read(path),
        content => {
          if (content == null) return; // deletion is handled by remove()
          if (loaded.get(name)?.source === content) return; // unchanged (our own write) — skip
          clearTimeout(debounceTimers.get(name));
          debounceTimers.set(name, setTimeout(() => reload(name, content), 300));
        },
      );
      watchers.set(name, stop);
    }

    // HMR rollback semantics: compile-probe first (module top-level errors are
    // caught there); only then swap def + version++ (key change = clean whole
    // remount). Compile failure -> the OLD version keeps running, hmrError set.
    async function reload(name, content) {
      try {
        const def = await compilePlugin(name, content);
        loadAndMount(name, content, def);
        log(`HMR: plugin [${name}] hot-reloaded`, 'ok');
        bus.emit('plugin/reloaded', name);
      } catch (e) {
        const entry = plugins.find(p => p.name === name);
        if (entry) entry.hmrError = e.message;
        log(`HMR: new source for [${name}] failed to compile (${e.message}), old version keeps running`, 'err');
      }
    }

    provideService('manager', {
      list: () => [...loaded.keys()],
      async create(name, source) {
        if (!/^[a-z][a-z0-9_-]*$/i.test(name || '')) return 'Error: name must start with a letter, only letters/digits/-/_';
        let def;
        try { def = await compilePlugin(name, source); } // probe first: a broken source is never mounted or persisted
        catch (e) { return `Error: plugin ${name} failed to compile: ${e.message}`; }
        const fs = services.get('fs')?.value;
        if (fs) {
          if (fs.read(FORMAT_FILE) == null) await fs.write(FORMAT_FILE, PLUGIN_FORMAT_VERSION);
          await fs.write(PLUGIN_DIR + name + '.js', source); // the self-modification, persisted
        }
        loadAndMount(name, source, def);
        return `plugin ${name} compiled and mounted; its tools/UI/prompt sections are live now`;
      },
      async remove(name) {
        if (!loaded.has(name)) {
          // Not running (e.g. corrupt source failed boot restore) but the file
          // lingers -> allow cleanup, or it haunts every boot forever.
          const fs0 = services.get('fs')?.value;
          if (fs0?.read(PLUGIN_DIR + name + '.js') != null) {
            await fs0.remove(PLUGIN_DIR + name + '.js');
            return `plugin ${name} was not running (corrupt source); its leftover file was deleted`;
          }
          return `Error: dynamic plugin ${name} does not exist (current: ${[...loaded.keys()].join(', ') || 'none'})`;
        }
        loaded.delete(name);
        watchers.get(name)?.(); watchers.delete(name);
        clearTimeout(debounceTimers.get(name));
        unmountPlugin(name);
        const fs = services.get('fs')?.value;
        if (fs) await fs.remove(PLUGIN_DIR + name + '.js');
        return `plugin ${name} unmounted; its tools/UI/listeners are gone`;
      },
    });

    // Boot restore: bring back what the agent built last session.
    (async () => {
      const fs = services.get('fs')?.value;
      if (!fs) return;
      await fs.ready;
      const format = fs.read(FORMAT_FILE);
      if (format != null && format.trim() !== PLUGIN_FORMAT_VERSION) {
        log(`stored plugins use format ${format.trim()}, this build wants ${PLUGIN_FORMAT_VERSION} — skipping restore (files kept)`, 'err');
        return;
      }
      for (const p of fs.list().filter(p => p.startsWith(PLUGIN_DIR) && p.endsWith('.js'))) {
        const name = p.slice(PLUGIN_DIR.length, -3);
        try {
          const def = await compilePlugin(name, fs.read(p));
          loadAndMount(name, fs.read(p), def);
          log(`restored dynamic plugin ${name} from OPFS`, 'ok');
        } catch (e) { log(`failed to restore plugin ${name}: ${e.message} (remove_plugin can clean it up)`, 'err'); }
      }
    })();

    onUnmounted(() => {
      for (const stop of watchers.values()) stop();
      watchers.clear();
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      log('manager plugin unmounted', 'warn');
    });
    return () => null;
  },
};
