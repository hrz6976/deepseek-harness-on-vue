import { getCurrentInstance, onUnmounted, reactive } from 'vue';
import { getService, provideService } from '../kernel/services';
import { log } from '../kernel/log';

export const brokerFsPlugin = {
  name: 'fs',
  setup() {
    const cache = reactive(new Map<string, string>());
    const ready = (async () => {
      const broker = getService('broker');
      if (!broker) throw new Error('Trusted filesystem broker is unavailable.');
      const files = await broker.request({ kind: 'fs/list' }) as Record<string, string>;
      for (const [path, content] of Object.entries(files)) cache.set(path, content);
      if (cache.size) log(`restored ${cache.size} file(s) from extension OPFS`, 'ok');
    })();

    provideService('fs', {
      files: cache,
      ready,
      read: (path: string) => cache.get(path) ?? null,
      list: () => [...cache.keys()].sort(),
      async write(path: string, content: string) {
        cache.set(path, String(content ?? ''));
        const broker = getService('broker');
        if (!broker) throw new Error('Trusted filesystem broker is unavailable.');
        await broker.request({ kind: 'fs/write', path, content: String(content ?? '') });
      },
      async remove(path: string) {
        cache.delete(path);
        const broker = getService('broker');
        if (!broker) throw new Error('Trusted filesystem broker is unavailable.');
        await broker.request({ kind: 'fs/remove', path });
      },
      async clear() {
        cache.clear();
        const broker = getService('broker');
        if (!broker) throw new Error('Trusted filesystem broker is unavailable.');
        await broker.request({ kind: 'fs/clear' });
      },
    });
    if (getCurrentInstance()) onUnmounted(() => log('broker fs plugin unmounted', 'warn'));
    return () => null;
  },
};
