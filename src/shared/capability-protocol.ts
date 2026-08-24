import { z } from 'zod';
import type { PageCommand, SiteSkill } from './page-protocol';
import type { HarnessMessage, JsonObject, JsonValue, ToolSchema } from './runtime';
import type { SessionLlmConfig } from './task-model';

const uniqueNames = (label: string) => z.array(z.string().trim().min(1))
  .refine(items => new Set(items).size === items.length, `${label} entries must be unique`);

export const CapabilityScopeSchema = z.enum(['task', 'workspace', 'site', 'global']);

export const CapabilityProviderSchema = z.enum(
  ['page', 'workspace', 'site-skill', 'storage', 'llm', 'mcp', 'web'],
  { error: issue => `unknown capability provider "${String(issue.input)}"` },
);
export type CapabilityProvider = z.infer<typeof CapabilityProviderSchema>;

export const CapabilityPermissionSchema = z.object({
  id: z.string().trim().min(1, 'every capability permission needs an id'),
  reason: z.string().trim().min(1).optional(),
  optional: z.boolean().optional(),
});
export type CapabilityPermission = z.infer<typeof CapabilityPermissionSchema>;

export const CapabilityManifestSchema = z.object({
  id: z.string()
    .regex(/^[a-z][a-z0-9_-]*$/iu, 'capability manifest id must start with a letter and contain only letters, digits, - or _'),
  version: z.string()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, 'capability manifest version must be semantic version x.y.z'),
  title: z.string().trim().min(1, 'capability manifest title is required'),
  description: z.string().trim().min(1).optional(),
  scope: CapabilityScopeSchema,
  contributes: z.object({
    tools: uniqueNames('contributes.tools').optional(),
    panels: uniqueNames('contributes.panels').optional(),
    prompts: uniqueNames('contributes.prompts').optional(),
    services: uniqueNames('contributes.services').optional(),
    workflows: uniqueNames('contributes.workflows').optional(),
  }),
  requires: z.object({
    capabilities: uniqueNames('requires.capabilities').optional(),
    providers: z.array(CapabilityProviderSchema)
      .refine(items => new Set(items).size === items.length, 'requires.providers entries must be unique')
      .optional(),
  }),
  permissions: z.array(CapabilityPermissionSchema)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'capability permission ids must be unique'),
});
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

export const CapabilityPrincipalSchema = z.object({
  kind: z.enum(['capability', 'system']),
  id: z.string().trim().min(1),
  fiberId: z.string().trim().min(1),
  scope: CapabilityScopeSchema,
  taskId: z.string().trim().min(1).optional(),
  providers: z.array(CapabilityProviderSchema)
    .refine(items => new Set(items).size === items.length, 'principal providers must be unique'),
  permissions: z.array(z.string().trim().min(1))
    .refine(items => new Set(items).size === items.length, 'principal permissions must be unique'),
});
export type CapabilityPrincipal = z.infer<typeof CapabilityPrincipalSchema>;

export type PageCapabilityRequest = {
  provider: 'page';
  action: 'command';
  contextId?: string;
  input: { command: PageCommand };
};

export type WorkspaceCapabilityRequest =
  | { provider: 'workspace'; action: 'list'; contextId?: string; input: Record<string, never> }
  | { provider: 'workspace'; action: 'write'; contextId?: string; input: { path: string; content: string; expectedRevision?: string | null } }
  | { provider: 'workspace'; action: 'remove'; contextId?: string; input: { path: string; expectedRevision?: string | null } };

export type SiteSkillCapabilityRequest =
  | { provider: 'site-skill'; action: 'list'; contextId?: string; input: Record<string, never> }
  | { provider: 'site-skill'; action: 'save'; contextId?: string; input: { skill: SiteSkill } }
  | { provider: 'site-skill'; action: 'remove'; contextId?: string; input: { id: string } }
  | { provider: 'site-skill'; action: 'apply'; contextId?: string; input: { id: string } };

export type StorageCapabilityRequest =
  | { provider: 'storage'; action: 'get'; contextId?: string; input: { keys: string[] } }
  | { provider: 'storage'; action: 'set'; contextId?: string; input: { values: JsonObject } }
  | { provider: 'storage'; action: 'remove'; contextId?: string; input: { keys: string[] } };

export type LlmCapabilityRequest =
  | { provider: 'llm'; action: 'status'; contextId?: string; input: Record<string, never> }
  | { provider: 'llm'; action: 'cancel'; contextId?: string; input: { requestId: string } }
  | {
      provider: 'llm';
      action: 'complete';
      contextId?: string;
      input: { request: { systemPrompt: string; messages: HarnessMessage[]; tools: ToolSchema[]; sessionConfig: SessionLlmConfig } };
    };

export type McpCapabilityRequest =
  | { provider: 'mcp'; action: 'connect'; contextId?: string; input: { id: string; url: string; headers?: Record<string, string> } }
  | { provider: 'mcp'; action: 'disconnect'; contextId?: string; input: { id: string } }
  | { provider: 'mcp'; action: 'list-tools'; contextId?: string; input: { id: string } }
  | { provider: 'mcp'; action: 'call-tool'; contextId?: string; input: { id: string; name: string; arguments?: JsonObject } };

export type WebCapabilityRequest =
  | { provider: 'web'; action: 'search'; contextId?: string; input: { query: string; limit?: number } }
  | { provider: 'web'; action: 'open'; contextId?: string; input: { url: string; maxChars?: number } };

export type CapabilityRequest =
  | PageCapabilityRequest
  | WorkspaceCapabilityRequest
  | SiteSkillCapabilityRequest
  | StorageCapabilityRequest
  | LlmCapabilityRequest
  | McpCapabilityRequest
  | WebCapabilityRequest;

export interface CapabilityEnvelope<T = CapabilityRequest> {
  channel: 'harness-broker-v1';
  session: string;
  requestId: string;
  principal: CapabilityPrincipal;
  payload: T;
}

export interface CapabilityResponse<T = JsonValue> {
  channel: 'harness-broker-v1';
  requestId: string;
  ok: boolean;
  value?: T;
  error?: string;
}

export interface CapabilityStreamChunk<T = JsonValue> {
  channel: 'harness-broker-v1';
  requestId: string;
  stream: true;
  done: boolean;
  value?: T;
  error?: string;
}

/** Stable optimistic-concurrency token for one workspace file body. */
export function workspaceRevision(content: string | null): string {
  if (content === null) return 'absent';
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${content.length.toString(36)}-${a.toString(36)}-${b.toString(36)}`;
}
