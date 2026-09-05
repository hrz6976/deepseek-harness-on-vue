import { log } from '@/kernel/log';
import { capabilities, legacyCapabilityManifest } from '@/kernel/capabilities';
import { CAPABILITY_PACKAGE_ROOT, PLUGIN_DIR, installedCapabilityIds, readCapabilityPackage } from '@/kernel/capability-package';
import { pluginPolicy } from '@/kernel/plugin-policy';
import { errorMessage, type FsService, type TaskRuntimeService } from '@/shared/runtime';
import type { ManagerBootstrap } from '../manager';
import type { createActivator } from './activation';

export async function initializeCapabilities({ defaults, search }: ManagerBootstrap, fs: FsService, reserved: ReadonlySet<string>, task: () => TaskRuntimeService | undefined, activate: ReturnType<typeof createActivator>): Promise<void> {
  await Promise.all([fs.ready, task()?.ready]);
  const reset = new URLSearchParams(search ?? globalThis.location?.search ?? '').has('reset');
  for (const path of fs.list()) {
    const id = path.startsWith(PLUGIN_DIR) ? path.slice(PLUGIN_DIR.length, -3) : path.slice(CAPABILITY_PACKAGE_ROOT.length).split('/')[0]!;
    if ((reset || reserved.has(id)) && (path.startsWith(PLUGIN_DIR) || path.startsWith(CAPABILITY_PACKAGE_ROOT))) await fs.remove(path);
  }
  if (reset) globalThis.history?.replaceState?.(null, '', globalThis.location?.pathname ?? '/');
  const stored = installedCapabilityIds(fs);
  for (const name of new Set([...Object.keys(defaults), ...stored])) {
    if (reserved.has(name)) continue;
    try {
      const definition = defaults[name];
      const protectedSource = pluginPolicy(name).source === 'protected';
      const previous = protectedSource ? null : readCapabilityPackage(fs, name);
      const path = `${PLUGIN_DIR}${name}.js`;
      let source = fs.read(path) ?? previous?.source ?? definition?.source ?? null;
      const refresh = definition && (protectedSource || source === null || (source === previous?.source && source === previous?.shippedSource));
      if (refresh) { source = definition.source; if (fs.read(path) !== source) await fs.write(path, source); }
      if (source !== null && fs.read(path) !== source) await fs.write(path, source);
      if (source === null || definition?.autoMount === false) continue;
      const manifest = (protectedSource ? definition?.manifest : previous?.manifest) ?? definition?.manifest ?? legacyCapabilityManifest(name, Boolean(definition));
      if (task() && manifest.scope === 'task' && !task()?.activeTask()?.capabilityIds.includes(name)) continue;
      const options = { manifest, bumpManifest: !refresh && Boolean(previous && previous.source !== source), ...(source === definition?.source ? { shippedSource: source } : {}) };
      const result = await activate(name, source, options);
      if (result.entry) continue;
      if (!previous?.source || previous.source === source) throw new Error(result.error);
      const fallback = capabilities.get(name) ?? (await activate(name, previous.source, { manifest: previous.manifest, bumpManifest: false, shippedSource: previous.shippedSource })).entry;
      if (!fallback) throw new Error(`Draft and previous revision failed: ${result.error}`);
      fallback.hmrError = `Working draft rejected during boot: ${result.error}`;
      log(`boot: restored previous revision of [${name}]`, 'warn');
    } catch (error) { log(`boot: [${name}] skipped: ${errorMessage(error)}`, 'err'); }
  }
}
