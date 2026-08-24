import type { z } from 'zod';
import type { JsonValue } from './runtime';
import type {
  AnnotationSchema,
  ElementFingerprintSchema,
  ElementRefSchema,
  LiveRuleActionSchema,
  LiveRuleSchema,
  PageCommandSchema,
  PatchOperationSchema,
  SiteRecipeSchema,
  SiteSkillSchema,
  SiteUserScriptSchema,
} from './broker-schema';

export interface PageScope {
  tabId: number;
  frameId: number;
  documentId?: string;
  generation?: number;
  url: string;
  origin: string;
}

export type ElementFingerprint = z.infer<typeof ElementFingerprintSchema>;
export type ElementRef = z.infer<typeof ElementRefSchema>;

export interface SnapshotNode extends ElementRef {
  children?: SnapshotNode[];
}

export interface PageSnapshot {
  scope: PageScope;
  title: string;
  capturedAt: number;
  truncated: boolean;
  nodes: SnapshotNode[];
}

export interface PageQueryPage {
  items: ElementRef[];
  offset: number;
  nextOffset?: number;
  total: number;
}

export interface PageStyleDeclaration {
  value: string;
  priority: string;
}

export interface PageMatchedStyleRule {
  selector: string;
  declarations: Record<string, PageStyleDeclaration>;
  source: string;
  order: number;
  conditions: Array<{ text: string; active: boolean }>;
}

export interface PageStyleInspection {
  scope: PageScope;
  target: ElementRef;
  pseudo?: '::before' | '::after';
  computed: Record<string, string>;
  inline: Record<string, PageStyleDeclaration>;
  matchedRules: PageMatchedStyleRule[];
  unreadableStyleSheets: string[];
  truncated: boolean;
}

export type PatchOperation = z.infer<typeof PatchOperationSchema>;

export interface PatchVerification {
  operation: number;
  ok: boolean;
  message: string;
}

export interface PatchTransaction {
  id: string;
  scope: PageScope;
  label: string;
  operations: PatchOperation[];
  createdAt: number;
  status: 'preview' | 'applied' | 'reverted' | 'verification-failed';
  verification: PatchVerification[];
}

export type Annotation = z.infer<typeof AnnotationSchema>;

export type LiveRuleAction = z.infer<typeof LiveRuleActionSchema>;

/**
 * A declarative, idempotent rule owned by the isolated content runtime. It is
 * deliberately less expressive than host JavaScript: future matching nodes
 * can be restyled or normalized without granting arbitrary page authority.
 */
export type LiveRule = z.infer<typeof LiveRuleSchema>;
export type LiveRulePredicate = NonNullable<LiveRule['predicate']>;
export type SiteRecipe = z.infer<typeof SiteRecipeSchema>;
export type SiteUserScript = z.infer<typeof SiteUserScriptSchema>;
export type SiteSkill = z.infer<typeof SiteSkillSchema>;

export function isSiteUserScript(skill: SiteSkill): skill is SiteUserScript {
  return skill.type === 'userscript';
}

export function matchesPagePattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return /^https?:/u.test(url);
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  try { return new RegExp(`^${expression}$`, 'u').test(url); }
  catch { return false; }
}

export type PageCommand = z.infer<typeof PageCommandSchema>;

export type PageCommandResult =
  | { ok: true; value: JsonValue | PageSnapshot | PageQueryPage | PageStyleInspection | ElementRef[] | PatchTransaction | null }
  | { ok: false; error: string; code?: 'permission-required' | 'unsupported' | 'not-found' | 'invalid-request' };

export type PageEvent =
  | { type: 'page/connected'; scope: PageScope }
  | { type: 'page/ready'; scope: PageScope }
  | { type: 'page/route-changed'; scope: PageScope; previousUrl: string }
  | { type: 'page/mutation'; scope: PageScope; count: number }
  | { type: 'page/element-selected'; scope: PageScope; target: ElementRef }
  | { type: 'annotation/created'; annotation: Annotation }
  | { type: 'patch/applied'; transaction: PatchTransaction }
  | { type: 'patch/verification-failed'; transaction: PatchTransaction }
  | { type: 'patch/reverted'; transaction: PatchTransaction }
  | { type: 'recipe/installed'; recipe: SiteSkill }
  | { type: 'recipe/disposed'; recipeId: string };
