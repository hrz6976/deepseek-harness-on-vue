import type { CapabilityPrincipal } from '@/shared/capability-protocol';
import { BUILTIN_CAPABILITIES, SYSTEM_PLUGINS, RETIRED_SYSTEM_NAMES } from './builtin-plugins';
import type { PluginSourcePolicy, PluginReloadBoundary } from './builtin-plugins';
export type { PluginSourcePolicy, PluginReloadBoundary } from './builtin-plugins';
export interface PluginPolicy { source: PluginSourcePolicy; reload: PluginReloadBoundary }
export const PROTECTED_PLUGIN_NAMES = Object.keys(BUILTIN_CAPABILITIES).filter(id => BUILTIN_CAPABILITIES[id]!.source === 'protected');
const EDITABLE_POLICY: PluginPolicy = Object.freeze({ source: 'editable', reload: 'turn' });
export function pluginPolicy(name: string): PluginPolicy {
  const capability = BUILTIN_CAPABILITIES[name];
  if (capability) return { source: capability.source, reload: capability.reload };
  const system = SYSTEM_PLUGINS[name];
  if (system || (RETIRED_SYSTEM_NAMES as readonly string[]).includes(name)) return { source: 'kernel', reload: system?.reload ?? 'restart' };
  return EDITABLE_POLICY;
}

export function isPluginSourceLocked(name: string): boolean {
  return pluginPolicy(name).source !== 'editable';
}

function canonicalWorkspacePath(path: string): string {
  return path.split('/').filter(Boolean).join('/');
}

/** Matches both the editable draft and its active/versioned package state. */
export function lockedPluginNameFromPath(path: string): string | null {
  // OPFS canonicalizes leading/repeated/trailing slashes by walking non-empty
  // segments. Apply the policy to that same identity so aliases cannot bypass
  // the lock before the storage layer normalizes them.
  const normalized = canonicalWorkspacePath(path);
  const draftTree = /^\.plugins\/([^/]+)\.js(?:\/|$)/u.exec(normalized);
  const packaged = /^\.harness\/capabilities\/([^/]+)(?:\/|$)/u.exec(normalized);
  const name = draftTree?.[1] ?? packaged?.[1];
  return name && isPluginSourceLocked(name) ? name : null;
}

export function assertWorkspaceMutationAllowed(principal: CapabilityPrincipal, path: string): void {
  if (principal.kind === 'system') return;
  const normalized = canonicalWorkspacePath(path);
  if (normalized === '.plugins') throw new Error('Harness plugin storage root is locked.');
  if (normalized === '.harness' || normalized.startsWith('.harness/')) {
    throw new Error('Harness internal state is manager-owned and locked.');
  }
  const name = lockedPluginNameFromPath(path);
  if (!name) return;
  const policy = pluginPolicy(name);
  throw new Error(`Plugin "${name}" is ${policy.source} and its source/package is locked.`);
}
