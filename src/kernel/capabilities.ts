import { shallowReactive } from 'vue';
import type { Context } from '@deepseek-ai/cordis';
import type {
  CapabilityContributionInventory,
  PluginEntry,
} from '@/shared/runtime';
import type {
  CapabilityManifest,
  CapabilityPermission,
  CapabilityProvider,
} from '@/shared/capability-protocol';
import { CapabilityManifestSchema } from '@/shared/capability-protocol';

type CapabilityContributionKind = keyof CapabilityContributionInventory;

export interface CapabilityHealth {
  state: 'healthy' | 'degraded' | 'failed';
  issues: string[];
  undeclared: Partial<CapabilityContributionInventory>;
  missing: Partial<CapabilityContributionInventory>;
}

export const capabilities = shallowReactive(new Map<string, PluginEntry>());

export function capabilityForContext(ctx: Context): PluginEntry | undefined {
  for (let fiber = ctx.fiber; fiber.uid; fiber = fiber.parent.fiber) {
    const entry = capabilities.get(fiber.name);
    if (entry?.fiber === fiber) return entry;
  }
}

const BUILTIN_PROVIDER_REQUIREMENTS: Record<string, CapabilityProvider[]> = {
  page: ['page', 'site-skill'],
  llm: ['llm'],
  compaction: ['llm'],
  'file-editor': ['workspace'],
  artifacts: ['workspace'],
  files: ['workspace'],
  preview: ['workspace'],
  mcp: ['mcp'],
  'capability-catalog': ['site-skill'],
  'workspace-tools': ['workspace'],
};

const BUILTIN_PERMISSIONS: Record<string, CapabilityPermission[]> = {
  page: [
    { id: 'page.read', reason: 'Inspect the attached page.' },
    { id: 'page.modify', reason: 'Apply temporary, reversible page changes.' },
    { id: 'page.interact', reason: 'Click, type, and scroll through trusted page actions.' },
    { id: 'page.eval', reason: 'Run explicitly approved expert JavaScript in the trusted page world.' },
    { id: 'site-skill.read', reason: 'List persisted site capabilities.' },
    { id: 'site-skill.manage', reason: 'Persist approved site capabilities.' },
  ],
  llm: [{ id: 'llm.use', reason: 'Send the task context to the configured model provider.' }],
  compaction: [{ id: 'llm.use', reason: 'Summarize oversized task context.' }],
  'file-editor': [
    { id: 'workspace.read', reason: 'Read virtual workspace files.' },
    { id: 'workspace.write', reason: 'Create and edit virtual workspace files.' },
  ],
  artifacts: [{ id: 'workspace.read', reason: 'Attach existing workspace files to task artifacts.' }],
  files: [{ id: 'workspace.read', reason: 'Render the workspace file list.' }],
  preview: [{ id: 'workspace.read', reason: 'Render workspace HTML in the preview panel.' }],
  'create-plugin': [{ id: 'capability.manage', reason: 'Compile and activate a task capability.' }],
  'remove-plugin': [{ id: 'capability.manage', reason: 'Unmount and remove a task capability.' }],
  settings: [{ id: 'capability.manage', reason: 'Mount or unmount the standalone model capability.' }],
  mcp: [
    { id: 'mcp.connect', reason: 'Connect and disconnect user-approved MCP servers.' },
    { id: 'mcp.use', reason: 'Discover and call tools on connected MCP servers.' },
  ],
  'capability-catalog': [
    { id: 'capability.manage', reason: 'Attach discovered capabilities and load task-scoped tool groups.' },
    { id: 'site-skill.read', reason: 'Discover persisted Site Skills.' },
    { id: 'site-skill.manage', reason: 'Apply a user-approved persisted Site Skill.' },
  ],
  'workspace-tools': [
    { id: 'workspace.read', reason: 'Search, read, and diff virtual workspace files.' },
    { id: 'workspace.write', reason: 'Create, replace, and remove virtual workspace files.' },
  ],
};

export function emptyContributionInventory(source: Partial<CapabilityContributionInventory> = {}): CapabilityContributionInventory {
  return {
    tools: [...(source.tools ?? [])], panels: [...(source.panels ?? [])], prompts: [...(source.prompts ?? [])],
    services: [...(source.services ?? [])], events: [...(source.events ?? [])], workflows: [...(source.workflows ?? [])],
  };
}

export function legacyCapabilityManifest(name: string, builtin: boolean): CapabilityManifest {
  return {
    id: name,
    version: '0.1.0',
    title: humanize(name),
    description: builtin ? 'Shipped Harness capability.' : 'Agent-created Harness capability.',
    scope: builtin ? 'global' : 'task',
    contributes: {},
    requires: {
      ...(BUILTIN_PROVIDER_REQUIREMENTS[name]?.length ? { providers: [...BUILTIN_PROVIDER_REQUIREMENTS[name]] } : {}),
    },
    permissions: [...(BUILTIN_PERMISSIONS[name] ?? [])],
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
  if (entry.manifestSource === 'generated') addGeneratedDeclaration(entry.manifest, kind, name);
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
  const issues: string[] = [];
  const undeclared: Partial<CapabilityContributionInventory> = {};
  const missing: Partial<CapabilityContributionInventory> = {};
  const declared = entry.manifest.contributes;
  for (const kind of ['tools', 'panels', 'prompts', 'services', 'workflows'] as const) {
    const actual = entry.contributions[kind];
    const expected = declared[kind] ?? [];
    const extra = actual.filter(name => !expected.includes(name));
    const absent = expected.filter(name => !actual.includes(name));
    if (extra.length) {
      undeclared[kind] = extra;
      issues.push(`undeclared ${kind}: ${extra.join(', ')}`);
    }
    if (absent.length) {
      missing[kind] = absent;
      issues.push(`missing ${kind}: ${absent.join(', ')}`);
    }
  }
  if (entry.status === 'failed') issues.unshift(entry.error || 'runtime failure');
  return {
    state: entry.status === 'failed' ? 'failed' : issues.length ? 'degraded' : 'healthy',
    issues,
    undeclared,
    missing,
  };
}

function addGeneratedDeclaration(manifest: CapabilityManifest, kind: CapabilityContributionKind, name: string): void {
  if (kind === 'events') return;
  const key = kind as keyof CapabilityManifest['contributes'];
  const list = manifest.contributes[key] ?? [];
  if (!list.includes(name)) manifest.contributes[key] = [...list, name];
}

function humanize(name: string): string {
  return name
    .split(/[-_]/u)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
