import { Service, type Context } from '@deepseek-ai/cordis';
import { capabilityForContext } from '@/kernel/capabilities';
import { SYSTEM_PLUGINS } from './builtin-plugins';
import { systemContextId } from '@/kernel/cordis';
import { permissionIds } from '@/shared/capability-policy';
import type {
  CapabilityPrincipal,
  CapabilityRequest,
} from '@/shared/capability-protocol';
import type { BrokerService, JsonValue } from '@/shared/runtime';

export interface BrokerTransport {
  request(principal: CapabilityPrincipal, request: CapabilityRequest, signal?: AbortSignal): Promise<JsonValue>;
  stream(principal: CapabilityPrincipal, request: CapabilityRequest, signal?: AbortSignal): AsyncIterable<JsonValue>;
}

export function principalForContext(ctx: Context): CapabilityPrincipal {
  const entry = capabilityForContext(ctx);
  if (entry) {
    const task = ctx.get('task');
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
    const grant = SYSTEM_PLUGINS[systemId]?.grant ?? { providers: [], permissions: [] };
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

export function systemPrincipal(id = 'kernel:shell'): CapabilityPrincipal {
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

  request(request: CapabilityRequest, signal?: AbortSignal): Promise<JsonValue> {
    return this.transport.request(principalForContext(this.ctx), request, signal ?? (capabilityForContext(this.ctx) ? this.ctx.get('task')?.signal : undefined));
  }

  stream(request: CapabilityRequest, signal?: AbortSignal): AsyncIterable<JsonValue> {
    return this.transport.stream(principalForContext(this.ctx), request, signal);
  }
}

export function createBrokerPlugin(transport: BrokerTransport) {
  return {
    name: 'broker',
    apply(ctx: Context) {
      new BrokerRuntime(ctx, transport);
    },
  };
}
