// fs plugin: raw OPFS with a reactive write-through cache. The cache Map IS
// the HMR change signal — the manager just watches cache entries; no separate
// file-watch machinery. The thin {read,list,write,remove,clear} interface is
// THE backend seam: Phase 2 swaps in a GM_setValue backend behind the same
// shape (OPFS needs a secure context many host pages lack).
import { reactive, onUnmounted, getCurrentInstance } from 'vue';
import { provideService } from '../kernel/services';
import { log } from '../kernel/log';
import { errorMessage } from '../shared/runtime';

type OpfsDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
};

export const fsPlugin = {
  name: 'fs',
  setup() {
    const cache = reactive(new Map<string, string>());
    let rootDir: OpfsDirectoryHandle | null = null;

    async function walk(dir: OpfsDirectoryHandle, prefix: string): Promise<void> {
      for await (const [name, handle] of dir.entries()) {
        const p = prefix + name;
        if (handle.kind === 'directory') await walk(handle as OpfsDirectoryHandle, p + '/');
        else cache.set(p, await (await handle.getFile()).text());
      }
    }
    async function resolveDir(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
      const segs = path.split('/').filter(Boolean);
      if (!rootDir) throw new Error('OPFS root is not ready');
      let dir: FileSystemDirectoryHandle = rootDir;
      for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create });
      const name = segs.at(-1);
      if (!name) throw new Error('file path is empty');
      return { dir, name };
    }
    async function persist(path: string, content: string): Promise<void> {
      const { dir, name } = await resolveDir(path, true);
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(content); await w.close();
    }

    const supported = !!navigator.storage?.getDirectory;
    const ready = (async () => {
      if (!supported) { log('OPFS unsupported in this browser, falling back to in-memory fs', 'warn'); return; }
      rootDir = await navigator.storage.getDirectory() as OpfsDirectoryHandle;
      await walk(rootDir, '');
      if (cache.size) log(`restored ${cache.size} file(s) from OPFS (previous session)`, 'ok');
    })().catch((error: unknown) => log('OPFS init failed: ' + errorMessage(error), 'err'));

    provideService('fs', {
      files: cache, ready,
      read: (p: string) => cache.get(p) ?? null,
      list: () => [...cache.keys()].sort(),
      async write(p: string, c: string) { cache.set(p, String(c ?? '')); if (rootDir) await persist(p, String(c ?? '')); },
      async remove(p: string) {
        cache.delete(p);
        if (rootDir) { try { const { dir, name } = await resolveDir(p, false); await dir.removeEntry(name, { recursive: true }); } catch {} }
      },
      async clear() {
        cache.clear();
        if (rootDir) for await (const [name] of rootDir.entries()) await rootDir.removeEntry(name, { recursive: true });
      },
    });
    if (getCurrentInstance()) onUnmounted(() => log('fs plugin unmounted', 'warn'));
    return () => null; // renderless
  },
};
