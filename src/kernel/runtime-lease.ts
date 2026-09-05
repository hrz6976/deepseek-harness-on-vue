/** A writer owns its host database until its runtime is disposed. */
export async function acquireRuntimeLease(scope: string, locks = globalThis.navigator?.locks): Promise<() => void> {
  if (!locks) throw new Error('This browser cannot establish exclusive task ownership (Web Locks unavailable).');
  return new Promise((resolve, reject) => {
    void locks.request(`harness-runtime:${scope}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('This site already has an active Harness runtime. Close that panel before opening another.');
      await new Promise<void>(release => resolve(release));
    }).catch(reject);
  });
}
