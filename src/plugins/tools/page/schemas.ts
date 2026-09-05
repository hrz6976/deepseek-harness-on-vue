import { z } from 'zod';
import { ElementRefSchema, LiveRuleSchema, PatchOperationSchema } from '@/sdk';

export const operationSchema = PatchOperationSchema.describe(
  'A transactional DOM operation. Use targets returned by page_snapshot or page_query unchanged.',
);
export const snapshotParameters = z.object({
  selector: z.string().describe('Optional CSS selector used as the snapshot root.').optional(),
  maxNodes: z.number().int().positive().max(10_000).describe('Maximum compressed nodes, default 600.').optional(),
  maxDepth: z.number().int().nonnegative().max(100).describe('Maximum tree depth, default 10.').optional(),
});
export const queryParameters = z.object({
  selector: z.string().min(1),
  limit: z.number().int().positive().max(1_000).optional(),
});
export const queryPageParameters = z.object({
  selector: z.string().min(1),
  offset: z.number().int().nonnegative().max(1_000_000).optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export const targetParameters = z.object({ target: ElementRefSchema });
export const styleInspectParameters = targetParameters.extend({
  pseudo: z.enum(['::before', '::after']).describe('Inspect the selected pseudo-element instead of the element itself.').optional(),
  properties: z.array(z.string().trim().min(1).max(200)).max(100)
    .describe('Optional computed CSS properties. Omit to return every property enumerated by getComputedStyle(), including custom properties.').optional(),
  includeMatchedRules: z.boolean().default(true)
    .describe('Include matching rules from readable author stylesheets.'),
  maxRules: z.number().int().positive().max(200).default(100),
});
export const typeParameters = z.object({
  target: ElementRefSchema,
  value: z.string().max(1_000_000),
  clear: z.boolean().default(true),
});
export const scrollParameters = z.object({
  target: ElementRefSchema.optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  behavior: z.enum(['auto', 'smooth']).optional(),
});
export const waitParameters = z.object({
  selector: z.string().min(1),
  state: z.enum(['attached', 'visible', 'hidden', 'detached']).optional(),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
});
export const settleParameters = z.object({
  quietMs: z.number().int().nonnegative().max(5_000).optional(),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
});
export const patchParameters = z.object({
  label: z.string().min(1),
  operations: z.array(operationSchema).max(1_000),
});
export const revertParameters = z.object({ transactionId: z.string().min(1) });
export const liveRulesParameters = z.object({ rules: z.array(LiveRuleSchema).min(1).max(500) });
export const liveRulesInstallParameters = liveRulesParameters.extend({
  id: z.string().min(1).max(200).describe('Stable rule-set id used to replace or remove this temporary set.'),
  label: z.string().min(1).max(500),
});
export const recipeParameters = z.object({
  type: z.enum(['recipe', 'userscript']).default('recipe'),
  id: z.string().min(1).describe('Existing recipe id when updating; omit to create.').optional(),
  name: z.string().min(1).max(200),
  matches: z.array(z.string().min(1)).min(1).max(100).describe('URL patterns such as https://example.com/*.'),
  operations: z.array(operationSchema).max(1_000).default([]),
  liveRules: z.array(LiveRuleSchema).max(500).default([]),
  source: z.string().min(1).max(1_000_000).optional(),
  runAt: z.enum(['document_start', 'document_end', 'document_idle']).default('document_idle'),
  enabled: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.type === 'userscript' && !value.source) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'A userscript needs source.' });
  }
  if (value.type === 'recipe' && !value.operations.length && !value.liveRules.length) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'A recipe needs at least one operation or live rule.' });
  }
  if (value.type === 'recipe' && value.source) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'Recipe source must use type userscript.' });
  }
});
export const idParameters = z.object({ id: z.string().min(1) });
export const recipeGetParameters = idParameters.extend({
  offset: z.number().int().nonnegative().max(10_000_000).default(0)
    .describe('Zero-based character offset into the stored userscript source or declarative definition.'),
  limit: z.number().int().positive().max(6_000).default(6_000)
    .describe('Maximum characters to return. Use the returned nextOffset to continue reading.'),
});
export const emptyParameters = z.object({});
export const scriptParameters = z.object({
  code: z.string().min(1).max(1_000_000)
    .describe('JavaScript to execute. When diagnosing a persisted userscript, return evidence from USER_SCRIPT or write an intentional DOM marker; MAIN cannot inspect USER_SCRIPT globals.'),
  world: z.enum(['MAIN', 'USER_SCRIPT']).default('USER_SCRIPT')
    .describe('Execution world. MAIN and USER_SCRIPT share DOM but not window/globalThis properties; use USER_SCRIPT to inspect globals created by a persisted userscript.'),
});
export const PAGE_DYNAMIC_GROUP = {
  id: 'page.dynamic',
  title: 'Dynamic Page Rules',
  description: 'Observe DOM changes or keep declarative rules active for future matching nodes.',
  scope: 'task',
  tags: ['page', 'dom', 'mutation', 'live-rule'],
} as const;
