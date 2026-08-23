import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type { JsonObject, JsonSchema, JsonValue } from '@/shared/runtime';

export const name = 'mcp';
export const inject = ['broker', 'tools', 'prompt'];

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

interface LoadedTool {
  serverId: string;
  remoteName: string;
  dispose: () => Promise<void>;
}

const serverIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/iu).max(100);
const aliasSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u).max(64);
const MCP_GROUP = {
  id: 'mcp',
  title: 'Model Context Protocol',
  description: 'Connect HTTP(S) MCP servers, discover their tools, and load selected remote schemas as AgentTools.',
  scope: 'task',
  tags: ['mcp', 'remote-tools', 'integration'],
} as const;

export function apply(ctx: Context): void {
  const loaded = new Map<string, LoadedTool>();
  const unload = async (alias: string): Promise<boolean> => {
    const entry = loaded.get(alias);
    if (!entry) return false;
    loaded.delete(alias);
    await entry.dispose();
    return true;
  };

  ctx.tools.register({
    name: 'mcp_connect',
    description: 'Connect an HTTP(S) MCP server through the trusted broker. This crosses a network authority boundary and requires user approval.',
    parameters: z.object({
      id: serverIdSchema.describe('Stable local id for this connection.'),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional().describe('Optional transport headers. Avoid placing secrets here unless the user supplied them for this server.'),
    }),
    availability: MCP_GROUP,
    run: async ({ id, url, headers }) => JSON.stringify(await ctx.broker.request({ provider: 'mcp', action: 'connect', input: { id, url, headers } })),
  });

  ctx.tools.register({
    name: 'mcp_disconnect',
    description: 'Disconnect an MCP server and unload AgentTools that were loaded from it.',
    parameters: z.object({ id: serverIdSchema }),
    availability: MCP_GROUP,
    async run({ id }) {
      for (const [alias, entry] of [...loaded]) if (entry.serverId === id) await unload(alias);
      return JSON.stringify(await ctx.broker.request({ provider: 'mcp', action: 'disconnect', input: { id } }));
    },
  });

  ctx.tools.register({
    name: 'mcp_list_tools',
    description: 'Discover tool names, descriptions, and input schemas exposed by a connected MCP server.',
    parameters: z.object({ id: serverIdSchema }),
    availability: MCP_GROUP,
    run: async ({ id }) => JSON.stringify(await ctx.broker.request({ provider: 'mcp', action: 'list-tools', input: { id } })),
  });

  ctx.tools.register({
    name: 'mcp_load_tool',
    description: 'Load one discovered MCP tool into the Agent tool registry. Its remote input schema becomes model-visible on the next turn.',
    parameters: z.object({
      id: serverIdSchema,
      name: z.string().min(1).max(200).describe('Remote MCP tool name returned by mcp_list_tools.'),
      alias: aliasSchema.optional().describe('Model-visible tool name. Defaults to mcp_<server>_<remote-name>.'),
    }),
    availability: MCP_GROUP,
    async run({ id, name: remoteName, alias: requestedAlias }) {
      const response = await ctx.broker.request({ provider: 'mcp', action: 'list-tools', input: { id } });
      const tools = readRemoteTools(response);
      const remote = tools.find(tool => tool.name === remoteName);
      if (!remote) return `Error: MCP server ${id} does not expose tool ${remoteName}`;
      const alias = requestedAlias ?? normalizeAlias(`mcp_${id}_${remoteName}`);
      if (!aliasSchema.safeParse(alias).success) return `Error: generated tool alias is invalid; provide an explicit alias for ${remoteName}`;
      const current = loaded.get(alias);
      if (current && (current.serverId !== id || current.remoteName !== remoteName)) {
        return `Error: AgentTool alias ${alias} is already loaded from ${current.serverId}/${current.remoteName}`;
      }
      if (current) return JSON.stringify({ loaded: true, alias, serverId: id, remoteName, alreadyLoaded: true });

      const dispose = ctx.tools.registerSchema({
        name: alias,
        description: remote.description?.trim() || `MCP tool ${remoteName} from ${id}.`,
        parameters: remote.inputSchema ?? { type: 'object', additionalProperties: true },
        run: async args => JSON.stringify(await ctx.broker.request({
          provider: 'mcp', action: 'call-tool', input: { id, name: remoteName, arguments: args as JsonObject },
        })),
      });
      loaded.set(alias, { serverId: id, remoteName, dispose });
      return JSON.stringify({ loaded: true, alias, serverId: id, remoteName, inputSchema: remote.inputSchema ?? null });
    },
  });

  ctx.tools.register({
    name: 'mcp_unload_tool',
    description: 'Remove a dynamically loaded MCP AgentTool from subsequent model turns without disconnecting the server.',
    parameters: z.object({ alias: aliasSchema }),
    availability: MCP_GROUP,
    async run({ alias }) {
      return JSON.stringify({ alias, unloaded: await unload(alias) });
    },
  });

  ctx.tools.register({
    name: 'mcp_call_tool',
    description: 'Call a discovered MCP tool without loading it. Prefer mcp_load_tool when the tool will be used repeatedly or its schema matters.',
    parameters: z.object({
      id: serverIdSchema,
      name: z.string().min(1).max(200),
      arguments: z.record(z.string(), z.json()).default({}),
    }),
    availability: MCP_GROUP,
    run: async ({ id, name: remoteName, arguments: args }) => JSON.stringify(await ctx.broker.request({
      provider: 'mcp', action: 'call-tool', input: { id, name: remoteName, arguments: args },
    })),
  });

  ctx.prompt.register({
    name: 'mcp-tools', order: 25,
    text: 'MCP servers are trusted-broker capabilities, not hidden transports. Load the mcp tool group with capability_load only when needed. Connect only an endpoint the user selected. Discover with mcp_list_tools, then use mcp_load_tool so the exact remote tool becomes model-visible on the next turn; unload or disconnect it when no longer needed.',
  });

  ctx.effect(() => async () => {
    for (const alias of [...loaded.keys()]) await unload(alias);
  }, 'mcp.loaded-tools');
}

function readRemoteTools(value: JsonValue): RemoteTool[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const tools = value.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || typeof candidate.name !== 'string') return [];
    return [{
      name: candidate.name,
      ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
      ...(candidate.inputSchema && typeof candidate.inputSchema === 'object' && !Array.isArray(candidate.inputSchema)
        ? { inputSchema: candidate.inputSchema as JsonSchema }
        : {}),
    }];
  });
}

function normalizeAlias(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]+/gu, '_').replace(/^([^a-zA-Z])/u, 'mcp_$1');
  return normalized.slice(0, 64);
}
