import { Inject, resolveConfig, type Context, type Fiber, type Plugin } from '@deepseek-ai/cordis';
import { fiberStatus, runtime } from './cordis';
import { log } from './log';
import { normalizePlugin } from './plugin-runtime';
import type { PluginEntry } from '@/shared/runtime';
import type { CapabilityManifest } from '@/shared/capability-protocol';
import {
  emptyContributionInventory,
  capabilities,
  legacyCapabilityManifest,
  registerCapability,
  unregisterCapability,
  validateCapabilityManifest,
} from './capabilities';

function captureFailure(entry: PluginEntry, fiber: Fiber): void {
  void fiber.await().catch((error: unknown) => {
    entry.error = error instanceof Error ? error.message : String(error);
    log(`plugin [${entry.manifest.id}] runtime error: ${entry.error}`, 'err');
  });
}

runtime.on('internal/status', (fiber) => {
  const entry = capabilities.get(fiber.name);
  if (!entry || entry.fiber !== fiber) return;
  if (entry.status === 'disposed') return unregisterCapability(entry);
  if (entry.status === 'failed') captureFailure(entry, fiber);
});

export async function mountPlugin(
  name: string,
  definition: Plugin | unknown,
  {
    builtin = false,
    config = null,
    manifest,
    parent = runtime,
  }: { builtin?: boolean; config?: Record<string, unknown> | null; manifest?: CapabilityManifest; parent?: Context } = {},
): Promise<PluginEntry> {
  const previous = capabilities.get(name);

  const plugin = normalizePlugin({ default: definition }, name);
  const entry: PluginEntry = {
    manifest: validateCapabilityManifest(manifest ?? legacyCapabilityManifest(name, builtin), name),
    contributions: emptyContributionInventory(),
    plugin,
    fiber: null,
    version: 0,
    get status(): PluginEntry['status'] { return this.fiber ? fiberStatus(this.fiber) : 'pending'; },
    error: '',
    hmrError: '',
    config,
  };

  // Validate metadata and native Config before disposing a working instance.
  resolveConfig({ Config: plugin.Config } as Plugin.Runtime, config ?? undefined);
  if (previous?.status === 'active') {
    const missing = Object.keys(Inject.resolve(plugin.inject)).filter(service => !parent.get(service));
    if (missing.length) throw new Error(`Replacement requires unavailable services: ${missing.join(', ')}`);
    if (previous.manifest.scope !== entry.manifest.scope) throw new Error('Unmount before changing a plugin scope.');
  }
  if (previous) await unmountPlugin(name);
  registerCapability(entry);
  try {
    const handle = parent.plugin(plugin as Plugin, config ?? undefined) as Fiber & PromiseLike<Fiber>;
    // Cordis returns a thenable facade whose prototype is the real Fiber.
    // Lifecycle events carry that real Fiber, so store it for stable identity.
    const fiber = Object.getPrototypeOf(handle) as Fiber;
    entry.fiber = fiber;
  } catch (error) {
    unregisterCapability(entry);
    throw error;
  }

  log(`plugin [${name}] mounted as Cordis fiber`, 'ok');
  return entry;
}

export async function unmountPlugin(name: string): Promise<boolean> {
  const entry = capabilities.get(name);
  if (!entry) return false;
  if (entry.fiber) await entry.fiber.dispose();
  log(`plugin [${name}] unmounted; Cordis reclaimed its effects`, 'warn');
  return true;
}
