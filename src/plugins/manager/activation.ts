import type { Context } from '@deepseek-ai/cordis';
import { compilePlugin } from '@/kernel/compile';
import { mountPlugin, unmountPlugin } from '@/kernel/host';
import { bumpCapabilityVersion, capabilities, legacyCapabilityManifest } from '@/kernel/capabilities';
import { persistCapabilityPackage, readCapabilityPackage } from '@/kernel/capability-package';
import { BUILTIN_CAPABILITIES } from '@/kernel/builtin-plugins';
import { errorMessage, type FsService, type PluginEntry } from '@/shared/runtime';
import type { CapabilityManifest } from '@/shared/capability-protocol';

export interface ActivateOptions {
  builtin?: boolean;
  config?: Record<string, unknown> | null;
  manifest?: CapabilityManifest;
  bumpManifest?: boolean;
  shippedSource?: string;
}

/** Install, boot and HMR share this serialized validate/start/commit path. */
export function createActivator(fs: FsService, parentFor: (scope?: string) => Context, cancelReload: (name: string, source?: string) => void, authorize?: (manifest: CapabilityManifest) => Promise<unknown>) {
  async function activate(name: string, source: string, options: ActivateOptions): Promise<PluginEntry> {
    const plugin = await compilePlugin(name, source);
    const previous = capabilities.get(name);
    const manifest = JSON.parse(JSON.stringify(options.manifest ?? previous?.manifest
      ?? readCapabilityPackage(fs, name)?.manifest ?? legacyCapabilityManifest(name, options.builtin ?? false))) as CapabilityManifest;
    const parent = parentFor(manifest.scope);
    if (!BUILTIN_CAPABILITIES[name]) await authorize?.(manifest);
    cancelReload(name, source);
    const task = manifest.scope === 'task' ? parent.get('task') : undefined;
    const alreadyAttached = task?.activeTask()?.capabilityIds.includes(name);
    if (task && !alreadyAttached) await task.setCapability(name, true);
    try {
      const candidate = await mountPlugin(name, plugin, { manifest, parent, config: options.config !== undefined ? options.config : previous?.config ?? null });
      await candidate.fiber?.await();
      candidate.version = (previous?.version ?? -1) + 1;
      if (options.bumpManifest ?? Boolean(previous)) bumpCapabilityVersion(candidate);
      await persistCapabilityPackage(fs, candidate, source, options.shippedSource);
      return candidate;
    } catch (error) {
      // Validation leaves the old instance untouched. Apply/commit failure recreates it;
      // durable state belongs to task/workspace, never to the disposable plugin instance.
      if (capabilities.get(name) !== previous) {
        await unmountPlugin(name);
        if (previous) {
          try {
            const restored = await mountPlugin(name, previous.plugin, { manifest: previous.manifest, parent: parentFor(previous.manifest.scope), config: previous.config });
            await restored.fiber?.await();
            restored.version = previous.version;
            restored.hmrError = errorMessage(error);
          } catch (restoreError) {
            throw new Error(`Update failed: ${errorMessage(error)}; restoring the previous plugin also failed: ${errorMessage(restoreError)}`);
          }
        }
      }
      if (task && !alreadyAttached) await task.setCapability(name, false);
      throw error;
    }
  }
  return (name: string, source: string, options: ActivateOptions = {}) => activate(name, source, options)
    .then(entry => ({ entry, error: '' }), error => ({ entry: null, error: errorMessage(error) }));
}
