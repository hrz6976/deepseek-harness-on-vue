import { z } from 'zod';
import { CapabilityPrincipalSchema, type CapabilityEnvelope, type CapabilityPrincipal } from './capability-protocol';
import { MAX_MESSAGE_ANNOTATIONS, type JsonValue } from './runtime';

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));

export const ElementFingerprintSchema = z.object({
  tag: z.string().min(1),
  id: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  classes: z.array(z.string()).max(100),
  attributes: z.record(z.string(), z.string()),
});

export const ElementRefSchema = z.object({
  nodeRef: z.string().min(1),
  documentId: z.string().min(1).optional(),
  generation: z.number().int().nonnegative().optional(),
  selector: z.string().min(1).max(10_000),
  fingerprint: ElementFingerprintSchema,
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
});

export const PatchOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set-text'), target: ElementRefSchema, value: z.string() }),
  z.object({ kind: z.literal('set-attribute'), target: ElementRefSchema, name: z.string(), value: z.string() }),
  z.object({ kind: z.literal('remove-attribute'), target: ElementRefSchema, name: z.string() }),
  z.object({ kind: z.literal('set-style'), target: ElementRefSchema, property: z.string(), value: z.string(), priority: z.enum(['', 'important']).optional() }),
  z.object({ kind: z.literal('add-class'), target: ElementRefSchema, value: z.string() }),
  z.object({ kind: z.literal('remove-class'), target: ElementRefSchema, value: z.string() }),
  z.object({ kind: z.literal('hide'), target: ElementRefSchema }),
  z.object({ kind: z.literal('remove'), target: ElementRefSchema }),
  z.object({ kind: z.literal('insert-html'), target: ElementRefSchema, position: z.enum(['beforebegin', 'afterbegin', 'beforeend', 'afterend']), html: z.string() }),
]);

export const LiveRuleActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set-text'), value: z.string() }),
  z.object({ kind: z.literal('set-attribute'), name: z.string().min(1), value: z.string() }),
  z.object({ kind: z.literal('remove-attribute'), name: z.string().min(1) }),
  z.object({ kind: z.literal('set-style'), property: z.string().min(1), value: z.string(), priority: z.enum(['', 'important']).optional() }),
  z.object({ kind: z.literal('add-class'), value: z.string().min(1) }),
  z.object({ kind: z.literal('remove-class'), value: z.string().min(1) }),
  z.object({ kind: z.literal('hide') }),
  z.object({ kind: z.literal('remove') }),
]);

export const LiveRuleSchema = z.object({
  id: z.string().min(1).max(200),
  selector: z.string().min(1).max(10_000),
  predicate: z.object({
    text: z.object({ equals: z.string().optional(), includes: z.string().optional() }).optional(),
    attributes: z.array(z.object({
      name: z.string().min(1).max(500),
      equals: z.string().optional(),
      includes: z.string().optional(),
      exists: z.boolean().optional(),
    })).max(100).optional(),
  }).optional(),
  actions: z.array(LiveRuleActionSchema).min(1).max(100),
});

const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.string(),
  argsObj: z.record(z.string(), JsonValueSchema).optional(),
  result: z.string().optional(),
  status: z.enum(['pending', 'running', 'done']).optional(),
});

const TokenUsageSchema = z.object({
  input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), totalTokens: z.number(),
  cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() }).optional(),
});

export const AnnotationSchema = z.object({
  id: z.string().min(1).max(500),
  scope: z.object({
    tabId: z.number().int(),
    frameId: z.number().int(),
    documentId: z.string().max(10_000).optional(),
    generation: z.number().int().nonnegative().optional(),
    url: z.string().max(100_000),
    origin: z.string().max(100_000),
  }),
  target: ElementRefSchema,
  text: z.string().max(100_000),
  createdAt: z.number().finite(),
});

const HarnessMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), text: z.string(), annotations: z.array(AnnotationSchema).max(MAX_MESSAGE_ANNOTATIONS).optional() }),
  z.object({ role: z.literal('note'), text: z.string() }),
  z.object({ role: z.literal('summary'), text: z.string(), tokensBefore: z.number().optional() }),
  z.object({
    role: z.literal('assistant'), responseId: z.string().optional(), text: z.string(), thinking: z.string(), toolCalls: z.array(ToolCallSchema),
    status: z.enum(['streaming', 'done', 'incomplete', 'error']),
    finishReason: z.enum(['stop', 'tool_calls', 'length', 'content_filter', 'insufficient_system_resource', 'unknown']).optional(),
    usage: TokenUsageSchema.optional(),
  }),
]);

const ToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), JsonValueSchema),
});

const SessionLlmConfigSchema = z.object({
  profileId: z.string().trim().max(64),
  model: z.string().trim().min(1).max(200),
  thinking: z.boolean(),
  reasoningEffort: z.enum(['low', 'high', 'max']),
});

export const PageCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page/snapshot'), options: z.object({ selector: z.string().optional(), maxNodes: z.number().int().positive().max(10_000).optional(), maxDepth: z.number().int().nonnegative().max(100).optional() }).optional() }),
  z.object({ type: z.literal('page/query'), selector: z.string(), limit: z.number().int().positive().max(1_000).optional() }),
  z.object({ type: z.literal('page/query-page'), selector: z.string(), offset: z.number().int().nonnegative().max(1_000_000).optional(), limit: z.number().int().positive().max(500).optional() }),
  z.object({
    type: z.literal('page/style-inspect'),
    target: ElementRefSchema,
    pseudo: z.enum(['::before', '::after']).optional(),
    properties: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    includeMatchedRules: z.boolean().optional(),
    maxRules: z.number().int().positive().max(200).optional(),
  }),
  z.object({ type: z.literal('page/click'), target: ElementRefSchema }),
  z.object({ type: z.literal('page/type'), target: ElementRefSchema, value: z.string().max(1_000_000), clear: z.boolean().optional() }),
  z.object({ type: z.literal('page/scroll'), target: ElementRefSchema.optional(), x: z.number().finite().optional(), y: z.number().finite().optional(), behavior: z.enum(['auto', 'smooth']).optional() }),
  z.object({ type: z.literal('page/wait'), selector: z.string().min(1), state: z.enum(['attached', 'visible', 'hidden', 'detached']).optional(), timeoutMs: z.number().int().positive().max(30_000).optional() }),
  z.object({ type: z.literal('page/settle'), quietMs: z.number().int().nonnegative().max(5_000).optional(), timeoutMs: z.number().int().positive().max(30_000).optional() }),
  z.object({ type: z.literal('page/patch-preview'), label: z.string(), operations: z.array(PatchOperationSchema).max(1_000) }),
  z.object({ type: z.literal('page/patch-apply'), label: z.string(), operations: z.array(PatchOperationSchema).max(1_000) }),
  z.object({ type: z.literal('page/patch-revert'), transactionId: z.string() }),
  z.object({ type: z.literal('page/patch-verify'), transactionId: z.string() }),
  z.object({ type: z.literal('page/observe'), enabled: z.boolean() }),
  z.object({ type: z.literal('page/live-rules-preview'), rules: z.array(LiveRuleSchema).max(500) }),
  z.object({ type: z.literal('page/live-rules-install'), id: z.string().min(1).max(200), label: z.string().min(1).max(500), rules: z.array(LiveRuleSchema).max(500) }),
  z.object({ type: z.literal('page/live-rules-remove'), id: z.string().min(1).max(200) }),
  z.object({ type: z.literal('page/picker-start') }),
  z.object({ type: z.literal('page/picker-stop') }),
  z.object({ type: z.literal('page/eval'), code: z.string().max(1_000_000), world: z.enum(['MAIN', 'USER_SCRIPT']) }),
]);

export const SiteRecipeSchema = z.object({
  type: z.literal('recipe').optional(),
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  matches: z.array(z.string().min(1)).min(1).max(100),
  enabled: z.boolean(),
  world: z.literal('ISOLATED'),
  operations: z.array(PatchOperationSchema).max(1_000).optional(),
  liveRules: z.array(LiveRuleSchema).max(500).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();

export const SiteUserScriptSchema = z.object({
  type: z.literal('userscript'),
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  matches: z.array(z.string().min(1)).min(1).max(100),
  enabled: z.boolean(),
  runAt: z.enum(['document_start', 'document_end', 'document_idle']),
  source: z.string().min(1).max(1_000_000),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();

export const SiteSkillSchema = z.union([SiteRecipeSchema, SiteUserScriptSchema]);

const EmptyInputSchema = z.object({});
const ContextIdSchema = z.string().min(1).optional();

const CapabilityRequestSchema = z.union([
  z.object({ provider: z.literal('page'), action: z.literal('command'), contextId: ContextIdSchema, input: z.object({ command: PageCommandSchema }) }),

  z.object({ provider: z.literal('workspace'), action: z.literal('list'), contextId: ContextIdSchema, input: EmptyInputSchema }),
  z.object({ provider: z.literal('workspace'), action: z.literal('write'), contextId: ContextIdSchema, input: z.object({ path: z.string().min(1).max(1_000), content: z.string().max(10_000_000), expectedRevision: z.string().nullable().optional() }) }),
  z.object({ provider: z.literal('workspace'), action: z.literal('remove'), contextId: ContextIdSchema, input: z.object({ path: z.string().min(1).max(1_000), expectedRevision: z.string().nullable().optional() }) }),

  z.object({ provider: z.literal('site-skill'), action: z.literal('list'), contextId: ContextIdSchema, input: EmptyInputSchema }),
  z.object({ provider: z.literal('site-skill'), action: z.literal('inspect'), contextId: ContextIdSchema, input: z.object({ id: z.string().min(1) }) }),
  z.object({ provider: z.literal('site-skill'), action: z.literal('save'), contextId: ContextIdSchema, input: z.object({ skill: SiteSkillSchema }) }),
  z.object({ provider: z.literal('site-skill'), action: z.literal('remove'), contextId: ContextIdSchema, input: z.object({ id: z.string().min(1) }) }),
  z.object({ provider: z.literal('site-skill'), action: z.literal('apply'), contextId: ContextIdSchema, input: z.object({ id: z.string().min(1) }) }),

  z.object({ provider: z.literal('storage'), action: z.literal('get'), contextId: ContextIdSchema, input: z.object({ keys: z.array(z.string()).max(1_000) }) }),
  z.object({ provider: z.literal('storage'), action: z.literal('set'), contextId: ContextIdSchema, input: z.object({ values: z.record(z.string(), JsonValueSchema) }) }),
  z.object({ provider: z.literal('storage'), action: z.literal('remove'), contextId: ContextIdSchema, input: z.object({ keys: z.array(z.string()).max(1_000) }) }),

  z.object({ provider: z.literal('llm'), action: z.literal('status'), contextId: ContextIdSchema, input: EmptyInputSchema }),
  z.object({ provider: z.literal('llm'), action: z.literal('models'), contextId: ContextIdSchema, input: z.object({ profileId: z.string().trim().max(64) }) }),
  z.object({ provider: z.literal('llm'), action: z.literal('cancel'), contextId: ContextIdSchema, input: z.object({ requestId: z.string().min(1) }) }),
  z.object({
    provider: z.literal('llm'),
    action: z.literal('complete'),
    contextId: ContextIdSchema,
    input: z.object({
      request: z.object({
        systemPrompt: z.string().max(1_000_000),
        messages: z.array(HarnessMessageSchema).max(10_000),
        tools: z.array(ToolSchema).max(1_000),
        sessionConfig: SessionLlmConfigSchema,
      }),
    }),
  }),

  z.object({ provider: z.literal('mcp'), action: z.literal('connect'), contextId: ContextIdSchema, input: z.object({ id: z.string().min(1), url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }) }),
  z.object({ provider: z.literal('mcp'), action: z.literal('disconnect'), contextId: ContextIdSchema, input: z.object({ id: z.string().min(1) }) }),
  z.object({ provider: z.literal('mcp'), action: z.literal('list-tools'), contextId: ContextIdSchema, input: z.object({ id: z.string().min(1) }) }),
  z.object({ provider: z.literal('mcp'), action: z.literal('call-tool'), contextId: ContextIdSchema, input: z.object({ id: z.string().min(1), name: z.string().min(1), arguments: z.record(z.string(), JsonValueSchema).optional() }) }),

  z.object({
    provider: z.literal('web'), action: z.literal('search'), contextId: ContextIdSchema,
    input: z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(10).optional() }),
  }),
  z.object({
    provider: z.literal('web'), action: z.literal('open'), contextId: ContextIdSchema,
    input: z.object({
      url: z.string().url().max(10_000).refine(value => /^https?:/u.test(value), 'web open URL must use http(s)'),
      maxChars: z.number().int().min(1_000).max(60_000).optional(),
    }),
  }),
]);

const CapabilityEnvelopeSchema = z.object({
  channel: z.literal('harness-broker-v1'),
  session: z.string().min(32),
  requestId: z.string().min(1),
  principal: CapabilityPrincipalSchema,
  payload: CapabilityRequestSchema,
});

export function parseCapabilityEnvelope(value: unknown): CapabilityEnvelope {
  return CapabilityEnvelopeSchema.parse(value) as CapabilityEnvelope;
}

export function assertCapabilitySession(envelope: CapabilityEnvelope, expected: string): void {
  if (!expected || envelope.session !== expected) throw new Error('Broker session authentication failed.');
}

export function createCapabilityEnvelope(
  session: string,
  requestId: string,
  principal: CapabilityPrincipal,
  payload: CapabilityEnvelope['payload'],
): CapabilityEnvelope {
  // Zod reconstructs the validated object tree as plain data. This is also
  // the sandbox -> extension structured-clone boundary, so Vue proxies never
  // reach window.postMessage.
  return parseCapabilityEnvelope({ channel: 'harness-broker-v1', session, requestId, principal, payload });
}
