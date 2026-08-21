import type { HarnessMessage, JsonObject, JsonValue, ToolSchema } from './runtime';

export type PageWorld = 'ISOLATED' | 'MAIN' | 'USER_SCRIPT';
export type NodeRef = string;

export interface PageScope {
  tabId: number;
  frameId: number;
  documentId?: string;
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

export interface SiteRecipe {
  id: string;
  name: string;
  matches: string[];
  enabled: boolean;
  world: PageWorld;
  operations?: PatchOperation[];
  source?: string;
  createdAt: number;
  updatedAt: number;
}

export type PageCommand =
  | { type: 'page/snapshot'; options?: { selector?: string; maxNodes?: number; maxDepth?: number } }
  | { type: 'page/query'; selector: string; limit?: number }
  | { type: 'page/patch-preview'; label: string; operations: PatchOperation[] }
  | { type: 'page/patch-apply'; label: string; operations: PatchOperation[] }
  | { type: 'page/patch-revert'; transactionId: string }
  | { type: 'page/patch-verify'; transactionId: string }
  | { type: 'page/observe'; enabled: boolean }
  | { type: 'page/picker-start' }
  | { type: 'page/picker-stop' }
  | { type: 'page/eval'; code: string; world: Exclude<PageWorld, 'ISOLATED'> };

export type PageCommandResult =
  | { ok: true; value: JsonValue | PageSnapshot | ElementRef[] | PatchTransaction | null }
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
  | { type: 'recipe/installed'; recipe: SiteRecipe }
  | { type: 'recipe/disposed'; recipeId: string };

export type BrokerRequest =
  | { kind: 'page'; command: PageCommand }
  | { kind: 'fs/list' }
  | { kind: 'fs/write'; path: string; content: string }
  | { kind: 'fs/remove'; path: string }
  | { kind: 'fs/clear' }
  | { kind: 'recipe/list' }
  | { kind: 'recipe/save'; recipe: SiteRecipe }
  | { kind: 'recipe/remove'; id: string }
  | { kind: 'recipe/apply'; id: string }
  | { kind: 'storage/get'; keys: string[] }
  | { kind: 'storage/set'; values: JsonObject }
  | { kind: 'storage/remove'; keys: string[] }
  | { kind: 'llm/status' }
  | { kind: 'llm/complete'; request: { systemPrompt: string; messages: HarnessMessage[]; tools: ToolSchema[] } }
  | { kind: 'mcp/connect'; id: string; url: string; headers?: Record<string, string> }
  | { kind: 'mcp/disconnect'; id: string }
  | { kind: 'mcp/list-tools'; id: string }
  | { kind: 'mcp/call-tool'; id: string; name: string; arguments?: JsonObject };

export interface BrokerEnvelope<T = BrokerRequest> {
  channel: 'harness-broker-v1';
  requestId: string;
  payload: T;
}

export interface BrokerResponse<T = JsonValue> {
  channel: 'harness-broker-v1';
  requestId: string;
  ok: boolean;
  value?: T;
  error?: string;
}

export interface BrokerStreamChunk<T = JsonValue> {
  channel: 'harness-broker-v1';
  requestId: string;
  stream: true;
  done: boolean;
  value?: T;
  error?: string;
}

export function isBrokerEnvelope(value: unknown): value is BrokerEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrokerEnvelope>;
  return candidate.channel === 'harness-broker-v1'
    && typeof candidate.requestId === 'string'
    && !!candidate.payload
    && typeof candidate.payload === 'object';
}
