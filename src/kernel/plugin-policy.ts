import type { CapabilityPrincipal } from '@/shared/capability-protocol';

export type PluginSourcePolicy = 'kernel' | 'protected' | 'editable';
export type PluginReloadBoundary = 'turn' | 'idle' | 'restart';

export interface PluginPolicy {
  source: PluginSourcePolicy;
  reload: PluginReloadBoundary;
}

export const PROTECTED_PLUGIN_NAMES = [
  'llm',
  'compaction',
  'file-editor',
  'workspace-tools',
  'create-plugin',
  'remove-plugin',
  'capability-catalog',
  'page',
  'mcp',
  'web',
  'settings',
] as const;

/**
 * Trusted source policy. This intentionally does not live in a capability
 * manifest: editable source must never be able to grant itself editability.
 */
const POLICIES: Readonly<Record<string, PluginPolicy>> = Object.freeze({
  shell: { source: 'kernel', reload: 'restart' },
  broker: { source: 'kernel', reload: 'restart' },
  fs: { source: 'kernel', reload: 'restart' },
  workspace: { source: 'kernel', reload: 'restart' },
  ui: { source: 'kernel', reload: 'restart' },
  tools: { source: 'kernel', reload: 'restart' },
  prompt: { source: 'kernel', reload: 'restart' },
  manager: { source: 'kernel', reload: 'restart' },
  'task-runtime': { source: 'kernel', reload: 'restart' },
  state: { source: 'kernel', reload: 'restart' },
  loop: { source: 'kernel', reload: 'idle' },
  ...Object.fromEntries(PROTECTED_PLUGIN_NAMES.map(name => [
    name, { source: 'protected', reload: 'turn' } satisfies PluginPolicy,
  ])),
});

const EDITABLE_POLICY: PluginPolicy = Object.freeze({ source: 'editable', reload: 'turn' });

export function pluginPolicy(name: string): PluginPolicy {
  return POLICIES[name] ?? EDITABLE_POLICY;
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
