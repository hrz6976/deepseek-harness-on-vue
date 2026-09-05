import { log } from '@/kernel/log';

export function createReloadQueue(reload: (name: string, source: string) => Promise<void>) {
  const reloads = new Map<string, { source: string; timer?: ReturnType<typeof setTimeout> }>();
  let loopBusy = false;
  const cancelReload = (pluginName: string, source?: string) => {
    const state = reloads.get(pluginName);
    if (source !== undefined && state?.source !== source) return;
    clearTimeout(state?.timer);
    reloads.delete(pluginName);
  };

  function armReload(pluginName: string, source: string): void {
    cancelReload(pluginName);
    const timer = setTimeout(() => {
      const state = reloads.get(pluginName);
      if (state?.timer !== timer) return;
      state.timer = undefined;
      if (loopBusy) {
        log(`HMR: [${pluginName}] changed during a run — reload queued for the next safe point`, 'warn');
      } else {
        reloads.delete(pluginName);
        void reload(pluginName, state.source);
      }
    }, 300);
    reloads.set(pluginName, { source, timer });
  }
  async function flushReloads(): Promise<void> {
    const batch = [...reloads];
    for (const [name] of batch) cancelReload(name);
    for (const [name, { source }] of batch) await reload(name, source);
  }
  return {
    cancel: cancelReload, arm: armReload, flush: flushReloads,
    setBusy(value: boolean) { loopBusy = value; },
    dispose() {
      for (const name of reloads.keys()) cancelReload(name);
    },
  };
}
