import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis';
import { runtime } from './cordis';
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

const fiberStatuses = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const;
const statusOf = (state: Fiber['state']): PluginEntry['status'] => fiberStatuses[state];

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
    manifestSource,
    parent = runtime,
  }: { builtin?: boolean; config?: Record<string, unknown> | null; manifest?: CapabilityManifest; manifestSource?: 'generated' | 'declared'; parent?: Context } = {},
): Promise<PluginEntry> {
  const previous = capabilities.get(name);
  if (previous) await unmountPlugin(name);

  const generated = manifest == null;
  const plugin = normalizePlugin({ default: definition }, name);
  const entry: PluginEntry = {
    manifest: validateCapabilityManifest(manifest ?? legacyCapabilityManifest(name, builtin), name),
    manifestSource: manifestSource ?? (generated ? 'generated' : 'declared'),
    contributions: emptyContributionInventory(),
    plugin,
    fiber: null,
    version: 0,
    get status(): PluginEntry['status'] { return statusOf(this.fiber?.state ?? 0); },
    error: '',
    hmrError: '',
    config,
  };

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
