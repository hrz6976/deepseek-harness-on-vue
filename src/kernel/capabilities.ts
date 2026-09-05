import { shallowReactive } from 'vue';
import type { Context } from '@deepseek-ai/cordis';
import type {
  CapabilityContributionInventory,
  PluginEntry,
} from '@/shared/runtime';
import type {
  CapabilityManifest,
} from '@/shared/capability-protocol';
import { BUILTIN_CAPABILITIES } from './builtin-plugins';
import { CapabilityManifestSchema } from '@/shared/capability-protocol';

type CapabilityContributionKind = keyof CapabilityContributionInventory;

export interface CapabilityHealth {
  state: 'healthy' | 'degraded' | 'failed';
  issues: string[];
}

export const capabilities = shallowReactive(new Map<string, PluginEntry>());

export function capabilityForContext(ctx: Context): PluginEntry | undefined {
  for (let fiber = ctx.fiber;fiber.uid;fiber = fiber.parent.fiber) {
    const entry = capabilities.get(fiber.name);
    if (entry?.fiber === fiber) return entry;
  }
}

export function emptyContributionInventory(source: Partial<CapabilityContributionInventory> = {}): CapabilityContributionInventory {
  return {
    tools: [...(source.tools ?? [])], panels: [...(source.panels ?? [])], prompts: [...(source.prompts ?? [])],
  };
}

export function legacyCapabilityManifest(name: string, builtin: boolean): CapabilityManifest {
  const definition = BUILTIN_CAPABILITIES[name];
  return {
    id: name,
    version: '0.1.0',
    title: humanize(name),
    description: builtin ? 'Shipped Harness capability.' : 'Agent-created Harness capability.',
    scope: builtin ? 'global' : 'task',
    requires: {
      ...(definition?.providers.length ? { providers: [...definition.providers] } : {}),
    },
    permissions: [...(definition?.permissions ?? [])],
  };
}

export function validateCapabilityManifest(input: unknown, expectedId?: string): CapabilityManifest {
  const manifest = CapabilityManifestSchema.parse(input);
  if (expectedId && manifest.id !== expectedId) {
    throw new Error(`capability manifest id "${manifest.id}" must match plugin name "${expectedId}"`);
  }
  return manifest;
}

export function registerCapability(entry: PluginEntry): void {
  const current = capabilities.get(entry.manifest.id);
  if (current && current !== entry) throw new Error(`capability id "${entry.manifest.id}" is already owned by another Fiber`);
  capabilities.set(entry.manifest.id, entry);
}

export function unregisterCapability(entry: PluginEntry): void {
  if (capabilities.get(entry.manifest.id) === entry) capabilities.delete(entry.manifest.id);
}

export function recordCapabilityContribution(
  capabilityId: string | null | undefined,
  kind: CapabilityContributionKind,
  name: string,
): () => void {
  if (!capabilityId) return () => undefined;
  const entry = capabilities.get(capabilityId);
  if (!entry) return () => undefined;
  const list = entry.contributions[kind];
  if (!list.includes(name)) list.push(name);
  const dispose = () => {
    const current = capabilities.get(capabilityId);
    if (current !== entry) return;
    const index = current.contributions[kind].indexOf(name);
    if (index >= 0) current.contributions[kind].splice(index, 1);
  };
  return dispose;
}

export function bumpCapabilityVersion(entry: PluginEntry): void {
  const [major = 0, minor = 1, patch = 0] = entry.manifest.version.split('.').map(value => Number(value) || 0);
  entry.manifest.version = `${major}.${minor}.${patch + 1}`;
}

export function capabilityHealth(entry: PluginEntry): CapabilityHealth {
  const issues = [entry.error, entry.hmrError].filter(Boolean);
  return { state: entry.status === 'failed' ? 'failed' : issues.length ? 'degraded' : 'healthy', issues };
}

function humanize(name: string): string {
  return name
    .split(/[-_]/u)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
