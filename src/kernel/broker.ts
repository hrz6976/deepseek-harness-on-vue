import { Service, type Context } from '@deepseek-ai/cordis';
import { capabilityForContext } from '@/kernel/capabilities';
import { systemContextId } from '@/kernel/cordis';
import { permissionIds, type PrincipalGrant } from '@/shared/capability-policy';
import type {
  CapabilityPrincipal,
  CapabilityRequest,
} from '@/shared/capability-protocol';
import type { BrokerService, JsonValue, TaskRuntimeService } from '@/shared/runtime';

export interface BrokerTransport {
  request(principal: CapabilityPrincipal, request: CapabilityRequest): Promise<JsonValue>;
  stream(principal: CapabilityPrincipal, request: CapabilityRequest): AsyncIterable<JsonValue>;
}

const SYSTEM_GRANTS: Record<string, PrincipalGrant> = {
  'manager': { providers: ['workspace'], permissions: ['workspace.read', 'workspace.write'] },
  'task-runtime': { providers: ['workspace'], permissions: ['workspace.read', 'workspace.write'] },
  'workspace': { providers: ['workspace'], permissions: ['workspace.read', 'workspace.write'] },
  'llm': { providers: ['llm'], permissions: ['llm.use'] },
  // Cordis Service tracing preserves the original caller across the llm
  // adapter, so model completions are authorized as kernel:loop.
  'loop': { providers: ['llm'], permissions: ['llm.use'] },
  'shell': {
    providers: ['page', 'workspace', 'site-skill', 'storage', 'llm', 'mcp', 'web'],
    permissions: ['*'],
  },
};

export function principalForContext(ctx: Context): CapabilityPrincipal {
  const entry = capabilityForContext(ctx);
  if (entry) {
    const task = ctx.reflect.get('task') as TaskRuntimeService | undefined;
    const active = entry.manifest.scope === 'task' ? task?.activeTask() : null;
    if (entry.manifest.scope === 'task' && !active?.capabilityIds.includes(entry.manifest.id)) {
      throw new Error(`Task-scoped capability "${entry.manifest.id}" is not attached to the active task.`);
    }
    const taskId = active?.id;
    return {
      kind: 'capability',
      id: entry.manifest.id,
      fiberId: `${entry.manifest.id}:${ctx.fiber.uid ?? 'disposed'}`,
      scope: entry.manifest.scope,
      ...(taskId ? { taskId } : {}),
      providers: [...(entry.manifest.requires.providers ?? [])],
      permissions: permissionIds(entry.manifest.permissions),
    };
  }

  const systemId = systemContextId(ctx);
  if (systemId) {
    const grant = SYSTEM_GRANTS[systemId] ?? { providers: [], permissions: [] };
    return {
      kind: 'system',
      id: `kernel:${systemId}`,
      fiberId: `system:${ctx.fiber.uid ?? 'disposed'}`,
      scope: 'global',
      providers: [...grant.providers],
      permissions: [...grant.permissions],
    };
  }

  throw new Error(`Broker access denied for unregistered Fiber <${ctx.fiber.name}>.`);
}

export function systemPrincipal(id = 'harness-shell'): CapabilityPrincipal {
  return {
    kind: 'system',
    id,
    fiberId: `system:${id}`,
    scope: 'global',
    providers: ['page', 'workspace', 'site-skill', 'storage', 'llm', 'mcp', 'web'],
    permissions: ['*'],
  };
}

/** Cordis traces Service methods back to the Context that read ctx.broker. */
class BrokerRuntime extends Service implements BrokerService {
  constructor(ctx: Context, readonly transport: BrokerTransport) {
    super(ctx, 'broker');
  }

  request(request: CapabilityRequest): Promise<JsonValue> {
    return this.transport.request(principalForContext(this.ctx), request);
  }

  stream(request: CapabilityRequest): AsyncIterable<JsonValue> {
    return this.transport.stream(principalForContext(this.ctx), request);
  }
}

export function createBrokerPlugin(transport: BrokerTransport) {
  return {
    name: 'broker-runtime',
    apply(ctx: Context) {
      new BrokerRuntime(ctx, transport);
    },
  };
}
