import type { JsonValue } from './runtime';

export type PageWorld = 'ISOLATED' | 'MAIN' | 'USER_SCRIPT';
export type NodeRef = string;

export interface PageScope {
  tabId: number;
  frameId: number;
  documentId?: string;
  generation?: number;
  url: string;
  origin: string;
}

export interface ElementFingerprint {
  tag: string;
  id?: string;
  role?: string;
  name?: string;
  text?: string;
  classes: string[];
  attributes: Record<string, string>;
}

export interface ElementRef {
  nodeRef: NodeRef;
  documentId?: string;
  generation?: number;
  selector: string;
  fingerprint: ElementFingerprint;
  rect?: { x: number; y: number; width: number; height: number };
}

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

export type PatchOperation =
  | { kind: 'set-text'; target: ElementRef; value: string }
  | { kind: 'set-attribute'; target: ElementRef; name: string; value: string }
  | { kind: 'remove-attribute'; target: ElementRef; name: string }
  | { kind: 'set-style'; target: ElementRef; property: string; value: string; priority?: '' | 'important' }
  | { kind: 'add-class'; target: ElementRef; value: string }
  | { kind: 'remove-class'; target: ElementRef; value: string }
  | { kind: 'hide'; target: ElementRef }
  | { kind: 'remove'; target: ElementRef }
  | { kind: 'insert-html'; target: ElementRef; position: InsertPosition; html: string };

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

export interface Annotation {
  id: string;
  scope: PageScope;
  target: ElementRef;
  text: string;
  createdAt: number;
}

export type LiveRuleAction =
  | { kind: 'set-text'; value: string }
  | { kind: 'set-attribute'; name: string; value: string }
  | { kind: 'remove-attribute'; name: string }
  | { kind: 'set-style'; property: string; value: string; priority?: '' | 'important' }
  | { kind: 'add-class'; value: string }
  | { kind: 'remove-class'; value: string }
  | { kind: 'hide' }
  | { kind: 'remove' };

export interface LiveRulePredicate {
  text?: { equals?: string; includes?: string };
  attributes?: Array<{ name: string; equals?: string; includes?: string; exists?: boolean }>;
}

/**
 * A declarative, idempotent rule owned by the isolated content runtime. It is
 * deliberately less expressive than host JavaScript: future matching nodes
 * can be restyled or normalized without granting arbitrary page authority.
 */
export interface LiveRule {
  id: string;
  selector: string;
  predicate?: LiveRulePredicate;
  actions: LiveRuleAction[];
}

export interface SiteRecipe {
  type?: 'recipe';
  id: string;
  name: string;
  matches: string[];
  enabled: boolean;
  world: 'ISOLATED';
  operations?: PatchOperation[];
  liveRules?: LiveRule[];
  createdAt: number;
  updatedAt: number;
}

export interface SiteUserScript {
  type: 'userscript';
  id: string;
  name: string;
  matches: string[];
  enabled: boolean;
  runAt: 'document_start' | 'document_end' | 'document_idle';
  source: string;
  createdAt: number;
  updatedAt: number;
}

export type SiteSkill = SiteRecipe | SiteUserScript;

export function isSiteUserScript(skill: SiteSkill): skill is SiteUserScript {
  return skill.type === 'userscript';
}

export type PageCommand =
  | { type: 'page/snapshot'; options?: { selector?: string; maxNodes?: number; maxDepth?: number } }
  | { type: 'page/query'; selector: string; limit?: number }
  | { type: 'page/query-page'; selector: string; offset?: number; limit?: number }
  | { type: 'page/click'; target: ElementRef }
  | { type: 'page/type'; target: ElementRef; value: string; clear?: boolean }
  | { type: 'page/scroll'; target?: ElementRef; x?: number; y?: number; behavior?: ScrollBehavior }
  | { type: 'page/wait'; selector: string; state?: 'attached' | 'visible' | 'hidden' | 'detached'; timeoutMs?: number }
  | { type: 'page/settle'; quietMs?: number; timeoutMs?: number }
  | { type: 'page/patch-preview'; label: string; operations: PatchOperation[] }
  | { type: 'page/patch-apply'; label: string; operations: PatchOperation[] }
  | { type: 'page/patch-revert'; transactionId: string }
  | { type: 'page/patch-verify'; transactionId: string }
  | { type: 'page/observe'; enabled: boolean }
  | { type: 'page/live-rules-preview'; rules: LiveRule[] }
  | { type: 'page/live-rules-install'; id: string; label: string; rules: LiveRule[] }
  | { type: 'page/live-rules-remove'; id: string }
  | { type: 'page/picker-start' }
  | { type: 'page/picker-stop' }
  | { type: 'page/eval'; code: string; world: Exclude<PageWorld, 'ISOLATED'> };

export type PageCommandResult =
  | { ok: true; value: JsonValue | PageSnapshot | PageQueryPage | ElementRef[] | PatchTransaction | null }
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
