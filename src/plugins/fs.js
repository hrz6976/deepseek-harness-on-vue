// fs plugin: raw OPFS with a reactive write-through cache. The cache Map IS
// the HMR change signal — the manager just watches cache entries; no separate
// file-watch machinery. The thin {read,list,write,remove,clear} interface is
// THE backend seam: Phase 2 swaps in a GM_setValue backend behind the same
// shape (OPFS needs a secure context many host pages lack).
import { reactive, onUnmounted } from 'vue';
import { provideService } from '../kernel/services.js';
import { log } from '../kernel/log.js';

export const fsPlugin = {
  name: 'fs',
  setup() {
    const cache = reactive(new Map());
    let rootDir = null;

    async function walk(dir, prefix) {
      for await (const [name, handle] of dir.entries()) {
        const p = prefix + name;
        if (handle.kind === 'directory') await walk(handle, p + '/');
        else cache.set(p, await (await handle.getFile()).text());
      }
    }
    async function resolveDir(path, create) {
      const segs = path.split('/').filter(Boolean);
      let dir = rootDir;
      for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create });
      return { dir, name: segs[segs.length - 1] };
    }
    async function persist(path, content) {
      const { dir, name } = await resolveDir(path, true);
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(content); await w.close();
    }

    const supported = !!navigator.storage?.getDirectory;
    const ready = (async () => {
      if (!supported) { log('OPFS unsupported in this browser, falling back to in-memory fs', 'warn'); return; }
      rootDir = await navigator.storage.getDirectory();
      await walk(rootDir, '');
      if (cache.size) log(`restored ${cache.size} file(s) from OPFS (previous session)`, 'ok');
    })().catch(e => log('OPFS init failed: ' + e.message, 'err'));

    provideService('fs', {
      files: cache, ready,
      read: p => (cache.has(p) ? cache.get(p) : null),
      list: () => [...cache.keys()].sort(),
      async write(p, c) { cache.set(p, String(c ?? '')); if (rootDir) await persist(p, String(c ?? '')); },
      async remove(p) {
        cache.delete(p);
        if (rootDir) { try { const { dir, name } = await resolveDir(p, false); await dir.removeEntry(name, { recursive: true }); } catch {} }
      },
      async clear() {
        cache.clear();
        if (rootDir) for await (const [name] of rootDir.entries()) await rootDir.removeEntry(name, { recursive: true });
      },
    });
    onUnmounted(() => log('fs plugin unmounted', 'warn'));
    return () => null; // renderless
  },
};
