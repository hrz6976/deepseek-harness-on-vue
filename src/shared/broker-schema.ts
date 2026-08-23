import { z } from 'zod';
import type { BrokerEnvelope } from './page-protocol';
import type { JsonValue } from './runtime';

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));

const ElementFingerprintSchema = z.object({
  tag: z.string().min(1),
  id: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  classes: z.array(z.string()).max(100),
  attributes: z.record(z.string(), z.string()),
});

const ElementRefSchema = z.object({
  nodeRef: z.string().min(1),
  selector: z.string().min(1).max(10_000),
  fingerprint: ElementFingerprintSchema,
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
});

const PatchOperationSchema = z.discriminatedUnion('kind', [
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

const HarnessMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), text: z.string() }),
  z.object({ role: z.literal('note'), text: z.string() }),
  z.object({ role: z.literal('summary'), text: z.string(), tokensBefore: z.number().optional() }),
  z.object({
    role: z.literal('assistant'), text: z.string(), thinking: z.string(), toolCalls: z.array(ToolCallSchema),
    status: z.enum(['streaming', 'done', 'error']), usage: TokenUsageSchema.optional(),
  }),
]);

const ToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), JsonValueSchema),
});

const PageCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page/snapshot'), options: z.object({ selector: z.string().optional(), maxNodes: z.number().int().positive().max(10_000).optional(), maxDepth: z.number().int().nonnegative().max(100).optional() }).optional() }),
  z.object({ type: z.literal('page/query'), selector: z.string(), limit: z.number().int().positive().max(1_000).optional() }),
  z.object({ type: z.literal('page/patch-preview'), label: z.string(), operations: z.array(PatchOperationSchema).max(1_000) }),
  z.object({ type: z.literal('page/patch-apply'), label: z.string(), operations: z.array(PatchOperationSchema).max(1_000) }),
  z.object({ type: z.literal('page/patch-revert'), transactionId: z.string() }),
  z.object({ type: z.literal('page/patch-verify'), transactionId: z.string() }),
  z.object({ type: z.literal('page/observe'), enabled: z.boolean() }),
  z.object({ type: z.literal('page/picker-start') }),
  z.object({ type: z.literal('page/picker-stop') }),
  z.object({ type: z.literal('page/eval'), code: z.string().max(1_000_000), world: z.enum(['MAIN', 'USER_SCRIPT']) }),
]);

const SiteRecipeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  matches: z.array(z.string().min(1)).min(1).max(100),
  enabled: z.boolean(),
  world: z.enum(['ISOLATED', 'MAIN', 'USER_SCRIPT']),
  operations: z.array(PatchOperationSchema).max(1_000).optional(),
  source: z.string().max(1_000_000).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const BrokerRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), command: PageCommandSchema }),
  z.object({ kind: z.literal('fs/list') }),
  z.object({ kind: z.literal('fs/write'), path: z.string().min(1).max(1_000), content: z.string().max(10_000_000) }),
  z.object({ kind: z.literal('fs/remove'), path: z.string().min(1).max(1_000) }),
  z.object({ kind: z.literal('fs/clear') }),
  z.object({ kind: z.literal('recipe/list') }),
  z.object({ kind: z.literal('recipe/save'), recipe: SiteRecipeSchema }),
  z.object({ kind: z.literal('recipe/remove'), id: z.string().min(1) }),
  z.object({ kind: z.literal('recipe/apply'), id: z.string().min(1) }),
  z.object({ kind: z.literal('storage/get'), keys: z.array(z.string()).max(1_000) }),
  z.object({ kind: z.literal('storage/set'), values: z.record(z.string(), JsonValueSchema) }),
  z.object({ kind: z.literal('storage/remove'), keys: z.array(z.string()).max(1_000) }),
  z.object({ kind: z.literal('llm/status') }),
  z.object({
    kind: z.literal('llm/complete'),
    request: z.object({
      systemPrompt: z.string().max(1_000_000),
      messages: z.array(HarnessMessageSchema).max(10_000),
      tools: z.array(ToolSchema).max(1_000),
    }),
  }),
]);

const BrokerEnvelopeSchema = z.object({
  channel: z.literal('harness-broker-v1'),
  requestId: z.string().min(1),
  payload: BrokerRequestSchema,
});

export function parseBrokerEnvelope(value: unknown): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse(value) as BrokerEnvelope;
}

export function createBrokerEnvelope(requestId: string, payload: BrokerEnvelope['payload']): BrokerEnvelope {
  // Zod reconstructs the validated object tree as plain data. This is also
  // the sandbox -> extension structured-clone boundary, so Vue proxies never
  // reach window.postMessage.
  return parseBrokerEnvelope({ channel: 'harness-broker-v1', requestId, payload });
}
