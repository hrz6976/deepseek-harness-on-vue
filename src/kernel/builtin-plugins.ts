import type { CapabilityPermission, CapabilityProvider } from '@/shared/capability-protocol';
import type { PrincipalGrant } from '@/shared/capability-policy';

export type RuntimeEnvironment = 'standalone' | 'extension';
export type PluginSourcePolicy = 'kernel' | 'protected' | 'editable';
export type PluginReloadBoundary = 'turn' | 'idle' | 'restart';
export interface BuiltinCapability {
  entry: string;
  environments: readonly RuntimeEnvironment[];
  autoMount: boolean;
  source: PluginSourcePolicy;
  reload: PluginReloadBoundary;
  providers: readonly CapabilityProvider[];
  permissions: readonly CapabilityPermission[];
}

/** Installation policy is explicit; shared defaults and provider names are derived once. */
function builtin(entry: string, source: PluginSourcePolicy, permissions: string[], options: Partial<Pick<BuiltinCapability, 'environments' | 'autoMount'>> = {}): BuiltinCapability {
  const providers = permissions.map(id => id.split('.')[0]!).filter(id => id !== 'capability') as CapabilityProvider[];
  return { entry, source, reload: 'turn', environments: ['standalone', 'extension'], autoMount: true,
    providers: [...new Set(providers)], permissions: permissions.map(id => ({ id })), ...options };
}
export const BUILTIN_CAPABILITIES: Readonly<Record<string, BuiltinCapability>> = {
  compaction: builtin('src/plugins/compaction.ts', 'protected', ['llm.use']),
  llm: builtin('src/plugins/llm.ts', 'protected', ['llm.use'], { environments: ['standalone'], autoMount: false }),
  artifacts: builtin('src/plugins/tools/artifacts.ts', 'editable', ['workspace.read']),
  'capability-catalog': builtin('src/plugins/tools/capability-catalog.ts', 'protected', ['capability.manage', 'site-skill.read', 'site-skill.manage']),
  'create-plugin': builtin('src/plugins/tools/create-plugin.ts', 'protected', ['capability.manage']),
  'file-editor': builtin('src/plugins/tools/file-editor.ts', 'protected', ['workspace.read', 'workspace.write']),
  mcp: builtin('src/plugins/tools/mcp.ts', 'protected', ['mcp.connect', 'mcp.use']),
  page: builtin('src/plugins/tools/page.ts', 'protected', ['page.read', 'page.modify', 'page.interact', 'page.eval', 'site-skill.read', 'site-skill.manage']),
  'read-state': builtin('src/plugins/tools/read-state.ts', 'editable', []),
  'remove-plugin': builtin('src/plugins/tools/remove-plugin.ts', 'protected', ['capability.manage']),
  'run-js': builtin('src/plugins/tools/run-js.ts', 'editable', []),
  web: builtin('src/plugins/tools/web.ts', 'protected', ['web.read']),
  'workspace-tools': builtin('src/plugins/tools/workspace-tools.ts', 'protected', ['workspace.read', 'workspace.write']),
  chat: builtin('src/plugins/ui/chat.ts', 'editable', [], { environments: ['standalone'] }),
  files: builtin('src/plugins/ui/files.ts', 'editable', ['workspace.read'], { environments: ['standalone'] }),
  preview: builtin('src/plugins/ui/preview.ts', 'editable', ['workspace.read'], { environments: ['standalone'] }),
  settings: builtin('src/plugins/ui/settings.ts', 'protected', ['capability.manage'], { environments: ['standalone'] }),
  syslog: builtin('src/plugins/ui/syslog.ts', 'editable', [], { environments: ['standalone'] }),
};

/** Host-selected system implementations share stable Fiber identities. */
export const SYSTEM_PLUGINS: Readonly<Record<string, { reload: PluginReloadBoundary; grant: PrincipalGrant }>> = {
  shell: { reload: 'restart', grant: { providers: ['page', 'workspace', 'site-skill', 'storage', 'llm', 'mcp', 'web', 'runtime'], permissions: ['*'] } },
  broker: { reload: 'restart', grant: { providers: [], permissions: [] } },
  workspace: { reload: 'restart', grant: { providers: ['workspace'], permissions: ['workspace.read', 'workspace.write'] } },
  ui: { reload: 'restart', grant: { providers: [], permissions: [] } },
  tools: { reload: 'restart', grant: { providers: [], permissions: [] } },
  prompt: { reload: 'restart', grant: { providers: [], permissions: [] } },
  manager: { reload: 'restart', grant: { providers: ['workspace', 'runtime'], permissions: ['workspace.read', 'workspace.write', 'capability.manage'] } },
  'task-runtime': { reload: 'restart', grant: { providers: ['workspace'], permissions: ['workspace.read', 'workspace.write'] } },
  loop: { reload: 'idle', grant: { providers: ['llm'], permissions: ['llm.use'] } },
  'model-profiles': { reload: 'restart', grant: { providers: ['llm'], permissions: ['llm.use'] } },
  llm: { reload: 'restart', grant: { providers: ['llm'], permissions: ['llm.use'] } },
  'page-policy': { reload: 'restart', grant: { providers: [], permissions: [] } },
  ready: { reload: 'restart', grant: { providers: [], permissions: [] } },
};

/** Legacy names are reserved for boot cleanup and path protection. */
export const RETIRED_SYSTEM_NAMES = ['fs', 'state'] as const;
