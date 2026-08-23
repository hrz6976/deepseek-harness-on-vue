import type {
  CapabilityPermission,
  CapabilityPrincipal,
  CapabilityProvider,
  CapabilityRequest,
} from '@/shared/capability-protocol';

function requiredPermission(request: CapabilityRequest): string {
  if (request.provider === 'workspace') {
    return request.action === 'list' ? 'workspace.read' : 'workspace.write';
  }
  if (request.provider === 'storage') {
    return request.action === 'get' ? 'storage.read' : 'storage.write';
  }
  if (request.provider === 'llm') return 'llm.use';
  if (request.provider === 'mcp') {
    return request.action === 'connect' || request.action === 'disconnect' ? 'mcp.connect' : 'mcp.use';
  }
  if (request.provider === 'site-skill') {
    return request.action === 'list' ? 'site-skill.read' : 'site-skill.manage';
  }

  const type = request.input.command.type;
  if (type === 'page/click' || type === 'page/type' || type === 'page/scroll') return 'page.interact';
  if (type === 'page/patch-apply' || type === 'page/patch-revert'
    || type === 'page/live-rules-install' || type === 'page/live-rules-remove') return 'page.modify';
  if (type === 'page/eval') return 'page.eval';
  return 'page.read';
}

export function assertPrincipalAuthorized(principal: CapabilityPrincipal, request: CapabilityRequest): void {
  if (!principal.providers.includes(request.provider)) {
    throw new Error(`Capability "${principal.id}" did not declare provider "${request.provider}".`);
  }
  assertPrincipalPermission(principal, requiredPermission(request));
}

export function assertPrincipalPermission(principal: CapabilityPrincipal, permission: string): void {
  if (principal.scope === 'task' && !principal.taskId) {
    throw new Error(`Task-scoped capability "${principal.id}" has no active task identity.`);
  }
  if (!principal.permissions.includes('*') && !principal.permissions.includes(permission)) {
    throw new Error(`Capability "${principal.id}" lacks permission "${permission}".`);
  }
}

export function permissionIds(permissions: readonly CapabilityPermission[]): string[] {
  return permissions.map(permission => permission.id);
}

export interface PrincipalGrant {
  providers: readonly CapabilityProvider[];
  permissions: readonly string[];
}
