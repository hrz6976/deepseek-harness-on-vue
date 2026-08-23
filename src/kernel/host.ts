import type { Fiber, Plugin } from '@deepseek-ai/cordis';
import { defineComponent, h, shallowReactive } from 'vue';
import { cordis } from './cordis';
import { log } from './log';
import { normalizePlugin } from './plugin-runtime';
import { UiContributionHost, uiContributions } from './ui';
import type { PluginEntry } from '@/shared/runtime';
import type { CapabilityManifest } from '@/shared/capability-protocol';
import {
  emptyContributionInventory,
  capabilityIsActive,
  legacyCapabilityManifest,
  registerCapability,
  unregisterCapability,
  validateCapabilityManifest,
} from './capabilities';

export const plugins = shallowReactive<PluginEntry[]>([]);

function statusOf(state: number): PluginEntry['status'] {
  switch (state) {
    case 0: return 'pending';
    case 1: return 'loading';
    case 2: return 'active';
    case 3: return 'failed';
    case 4: return 'disposed';
    case 5: return 'unloading';
    default: return 'pending';
  }
}

cordis.on('internal/status', (fiber) => {
  const entry = plugins.find(plugin => plugin.fiber === fiber);
  if (!entry) return;
  entry.status = statusOf(fiber.state);
  if (entry.status === 'failed') {
    void fiber.await().catch((error: unknown) => {
      entry.error = error instanceof Error ? error.message : String(error);
      log(`plugin [${entry.name}] runtime error: ${entry.error}`, 'err');
    });
  }
});

export async function mountPlugin(
  name: string,
  definition: Plugin | unknown,
  {
    builtin = false,
    config = null,
    manifest,
    manifestSource,
  }: { builtin?: boolean; config?: Record<string, unknown> | null; manifest?: CapabilityManifest; manifestSource?: 'generated' | 'declared' } = {},
): Promise<PluginEntry> {
  const previous = plugins.find(plugin => plugin.name === name);
  if (previous) await unmountPlugin(name);

  const generated = manifest == null;
  const plugin = normalizePlugin({ default: definition }, name);
  const entry: PluginEntry = {
    name,
    manifest: validateCapabilityManifest(manifest ?? legacyCapabilityManifest(name, builtin), name),
    manifestSource: manifestSource ?? (generated ? 'generated' : 'declared'),
    contributions: emptyContributionInventory(),
    plugin,
    fiber: null,
    version: 0,
    status: 'pending',
    error: '',
    hmrError: '',
    builtin,
    config,
  };

  registerCapability(entry);
  plugins.push(entry);
  try {
    const handle = cordis.plugin(plugin as Plugin, config ?? undefined) as Fiber & PromiseLike<Fiber>;
    // Cordis returns a thenable facade whose prototype is the real Fiber.
    // Lifecycle events carry that real Fiber, so store it for stable identity.
    const fiber = Object.getPrototypeOf(handle) as Fiber;
    entry.fiber = fiber;
    entry.status = statusOf(fiber.state);
    void fiber.await().catch((error: unknown) => {
      entry.status = 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
      log(`plugin [${name}] failed: ${entry.error}`, 'err');
    });
  } catch (error) {
    plugins.splice(plugins.indexOf(entry), 1);
    unregisterCapability(entry);
    throw error;
  }

  log(`plugin [${name}] mounted as Cordis fiber`, 'ok');
  cordis.emit('plugin/mounted', name);
  return entry;
}

export async function unmountPlugin(name: string): Promise<boolean> {
  const index = plugins.findIndex(plugin => plugin.name === name);
  if (index < 0) return false;
  const entry = plugins[index]!;
  if (entry.fiber) await entry.fiber.dispose();
  plugins.splice(index, 1);
  unregisterCapability(entry);
  log(`plugin [${name}] unmounted; Cordis reclaimed its effects`, 'warn');
  cordis.emit('plugin/unmounted', name);
  return true;
}

/**
 * Compatibility renderer for the existing shells. It renders only UI records
 * contributed by this plugin; plugin execution itself no longer happens in
 * Vue and therefore does not depend on this component being visible.
 */
export const PluginHost = defineComponent({
  name: 'PluginUiHost',
  props: { plugin: { type: Object, required: true } },
  setup(props: { plugin: PluginEntry }) {
    return () => [...uiContributions.values()]
      .filter(contribution => contribution.owner === props.plugin.name && capabilityIsActive(props.plugin))
      .map(contribution => h(UiContributionHost, {
        key: `${contribution.id}:${contribution.version}`,
        contribution,
      }));
  },
});
