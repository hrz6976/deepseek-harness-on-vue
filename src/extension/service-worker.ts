import { ZodError } from 'zod';
import contentScriptFile from './content-script?script&iife';
import { parseBrokerEnvelope } from '../shared/broker-schema';
import type {
  BrokerEnvelope,
  BrokerRequest,
  BrokerResponse,
  BrokerStreamChunk,
  PageCommandResult,
  PageEvent,
  SiteRecipe,
} from '../shared/page-protocol';
import type { JsonValue, LlmStreamEvent } from '../shared/runtime';
import { createPiStream } from '../shared/pi-engine';
import {
  isInspectableUrl,
  pageEventTabId,
  parseSidePanelPortName,
  sidePanelPath,
} from './tab-scope';

interface StoredLlmConfig { baseURL: string; model: string; apiKey?: string; localProxy?: boolean }
const LLM_CONFIG_KEY = 'secrets.llm';
const RECIPES_KEY = 'public.recipes';

const ports = new Map<chrome.runtime.Port, number>();

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void configureExistingTabs().catch(error => console.warn('[harness] could not configure existing tabs', error));

chrome.runtime.onConnect.addListener(port => {
  const tabId = parseSidePanelPortName(port.name);
  if (tabId == null) return;
  ports.set(port, tabId);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(message => {
    void replyToPort(port, tabId, message);
  });
});

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isPageEventMessage(message)) return;
  const event = withSenderScope(message.event, sender);
  emitPageEvent(event);
  if (event.type === 'page/route-changed' && sender.tab?.id != null) {
    void applyMatchingRecipes(sender.tab.id, event.scope.url);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void configureExistingTabs().catch(error => console.warn('[harness] could not configure installed tabs', error));
});
chrome.runtime.onStartup.addListener(() => {
  void configureExistingTabs().catch(error => console.warn('[harness] could not configure startup tabs', error));
});

chrome.tabs.onCreated.addListener(tab => {
  if (tab.id != null) void configureTabPanel(tab.id, tab.pendingUrl ?? tab.url);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId)
    .then(tab => configureTabPanel(tabId, tab.pendingUrl ?? tab.url))
    .catch(error => console.warn(`[harness] could not inspect activated tab ${tabId}`, error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    void configureTabPanel(tabId, tab.pendingUrl ?? tab.url);
  }
  if (changeInfo.status !== 'complete' || !isInspectableUrl(tab.url)) return;
  void applyMatchingRecipes(tabId, tab.url);
});

async function configureExistingTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.flatMap(tab => tab.id == null
    ? []
    : [configureTabPanel(tab.id, tab.pendingUrl ?? tab.url)]));
}

async function configureTabPanel(tabId: number, url: string | undefined): Promise<void> {
  try {
    if (isInspectableUrl(url)) {
      await chrome.sidePanel.setOptions({
        tabId,
        path: sidePanelPath(tabId),
        enabled: true,
      });
    } else {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    }
  } catch (error) {
    console.warn(`[harness] could not configure side panel for tab ${tabId}`, error);
  }
}

async function replyToPort(port: chrome.runtime.Port, tabId: number, value: unknown): Promise<void> {
  let envelope: BrokerEnvelope;
  try {
    envelope = parseBrokerEnvelope(value);
  } catch (error) {
    const requestId = readRequestId(value);
    port.postMessage(response(requestId, false, undefined, formatError(error)));
    return;
  }

  if (envelope.payload.kind === 'llm/complete') {
    try {
      for await (const event of streamLlm(envelope.payload.request)) {
        const terminal = event.type === 'done' || event.type === 'error';
        port.postMessage({
          channel: 'harness-broker-v1',
          requestId: envelope.requestId,
          stream: true,
          done: terminal,
          value: json(event),
        } satisfies BrokerStreamChunk);
        if (terminal) return;
      }
      port.postMessage({ channel: 'harness-broker-v1', requestId: envelope.requestId, stream: true, done: true } satisfies BrokerStreamChunk);
    } catch (error) {
      port.postMessage({
        channel: 'harness-broker-v1',
        requestId: envelope.requestId,
        stream: true,
        done: true,
        error: formatError(error),
      } satisfies BrokerStreamChunk);
    }
    return;
  }

  try {
    const result = await handleRequest(envelope.payload, tabId);
    port.postMessage(response(envelope.requestId, true, result));
  } catch (error) {
    port.postMessage(response(envelope.requestId, false, undefined, formatError(error)));
  }
}

async function handleRequest(request: BrokerRequest, tabId: number): Promise<JsonValue> {
  switch (request.kind) {
    case 'page':
      return await executePageCommand(request.command, tabId);
    case 'fs/list':
    case 'fs/write':
    case 'fs/remove':
    case 'fs/clear':
      throw new Error('Filesystem requests must be handled by the trusted side-panel OPFS broker.');
    case 'recipe/list':
      return json(await readRecipes());
    case 'recipe/save':
      return json(await saveRecipe(request.recipe));
    case 'recipe/remove':
      return await removeRecipe(request.id);
    case 'recipe/apply':
      return await applyRecipe(request.id, tabId);
    case 'storage/get':
      assertPublicStorageKeys(request.keys);
      return json(await chrome.storage.local.get(request.keys));
    case 'storage/set':
      assertPublicStorageKeys(Object.keys(request.values));
      await chrome.storage.local.set(request.values);
      return null;
    case 'storage/remove':
      assertPublicStorageKeys(request.keys);
      await chrome.storage.local.remove(request.keys);
      return null;
    case 'llm/status': {
      const config = await readLlmConfig();
      return config ? { configured: true, baseURL: config.baseURL, model: config.model } : { configured: false };
    }
    case 'llm/complete':
      throw new Error('LLM completion requests use the streaming broker path.');
  }
}

async function readRecipes(): Promise<SiteRecipe[]> {
  const stored = (await chrome.storage.local.get(RECIPES_KEY))[RECIPES_KEY] as SiteRecipe[] | undefined;
  return Array.isArray(stored) ? stored : [];
}

async function saveRecipe(recipe: SiteRecipe): Promise<SiteRecipe> {
  if (recipe.source) throw new Error('Executable recipe source is not enabled; save audited DOM operations instead.');
  const recipes = await readRecipes();
  const existing = recipes.find(item => item.id === recipe.id);
  const saved: SiteRecipe = {
    ...recipe,
    createdAt: existing?.createdAt ?? recipe.createdAt,
    updatedAt: Date.now(),
  };
  const next = recipes.filter(item => item.id !== saved.id);
  next.push(saved);
  await chrome.storage.local.set({ [RECIPES_KEY]: next });
  emitPageEvent({ type: 'recipe/installed', recipe: saved });
  return saved;
}

async function removeRecipe(id: string): Promise<null> {
  const recipes = await readRecipes();
  await chrome.storage.local.set({ [RECIPES_KEY]: recipes.filter(recipe => recipe.id !== id) });
  emitPageEvent({ type: 'recipe/disposed', recipeId: id });
  return null;
}

async function applyRecipe(id: string, tabId: number): Promise<JsonValue> {
  const recipe = (await readRecipes()).find(item => item.id === id);
  if (!recipe) throw new Error(`Recipe "${id}" does not exist.`);
  if (!recipe.operations?.length) throw new Error(`Recipe "${id}" has no DOM operations.`);
  return await executePageCommand({
    type: 'page/patch-apply',
    label: `recipe: ${recipe.name}`,
    operations: recipe.operations,
  }, tabId);
}

async function applyMatchingRecipes(tabId: number, url: string): Promise<void> {
  const recipes = (await readRecipes()).filter(recipe => recipe.enabled
    && recipe.operations?.length
    && recipe.matches.some(pattern => matchesPattern(pattern, url)));
  if (!recipes.length) return;
  const allowed = await chrome.permissions.contains({ origins: [originPattern(new URL(url).origin)] });
  if (!allowed) return;
  for (const recipe of recipes) {
    try { await applyRecipe(recipe.id, tabId); }
    catch (error) { console.warn(`[harness] recipe ${recipe.id} failed`, error); }
  }
}

function matchesPattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return /^https?:/u.test(url);
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  try { return new RegExp(`^${expression}$`, 'u').test(url); }
  catch { return false; }
}

function emitPageEvent(event: PageEvent): void {
  const targetTabId = pageEventTabId(event);
  for (const [port, tabId] of ports) {
    if (targetTabId == null || targetTabId === tabId) {
      port.postMessage({ channel: 'harness-page-event-v1', event });
    }
  }
}

async function* streamLlm(request: Extract<BrokerRequest, { kind: 'llm/complete' }>['request']): AsyncIterable<LlmStreamEvent> {
  const config = await readLlmConfig();
  if (!config) throw new Error('LLM 尚未配置；请打开扩展设置填写 API endpoint、model 和 key，或启用本地 Bridge。');
  // Same engine as the sandbox llm plugin — one implementation, no extra SDK.
  // The wire format carries no AbortSignal; each stream gets its own.
  yield* createPiStream(config)({ ...request, signal: new AbortController().signal });
}

async function readLlmConfig(): Promise<StoredLlmConfig | null> {
  const value = (await chrome.storage.local.get(LLM_CONFIG_KEY))[LLM_CONFIG_KEY] as StoredLlmConfig | undefined;
  if (!value?.baseURL || !value.model || (!value.apiKey && !value.localProxy)) return null;
  // A local-Bridge config may retain an old direct API key so switching back is
  // convenient, but it must never be sent to Bridge instead of its own key.
  return value.localProxy ? { ...value, apiKey: undefined } : value;
}

function assertPublicStorageKeys(keys: string[]): void {
  if (keys.some(key => key.startsWith('secrets.'))) {
    throw new Error('Sandbox code cannot access trusted secret storage.');
  }
}

async function executePageCommand(command: Extract<BrokerRequest, { kind: 'page' }>['command'], tabId: number): Promise<JsonValue> {
  const tab = await chrome.tabs.get(tabId);
  if (!isInspectableUrl(tab.url)) throw new Error('This tab is no longer an inspectable http(s) page.');
  if (command.type === 'page/eval') return await evaluateUserScript(tabId, command.code, command.world);

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [contentScriptFile],
  });
  const result = await chrome.tabs.sendMessage(tabId, {
    channel: 'harness-page-v1',
    command,
  }) as PageCommandResult;
  return json(result);
}

async function evaluateUserScript(tabId: number, code: string, world: 'MAIN' | 'USER_SCRIPT'): Promise<JsonValue> {
  if (!chrome.userScripts?.execute) {
    throw new Error('User Scripts API is unavailable. Enable developer mode and the extension user-scripts toggle.');
  }
  const wrapped = `(async () => {
    const value = await (0, eval)(${JSON.stringify(code)});
    if (value === undefined) return null;
    try { return JSON.parse(JSON.stringify(value)); }
    catch { return String(value); }
  })()`;
  const [result] = await chrome.userScripts.execute<JsonValue>({
    js: [{ code: wrapped }],
    target: { tabId },
    world,
  });
  if (!result) return null;
  if ('error' in result) throw new Error(result.error);
  return result.result;
}

function originPattern(origin: string): string {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) origins can be granted.');
  return `${url.origin}/*`;
}

function response(requestId: string, ok: boolean, value?: JsonValue, error?: string): BrokerResponse {
  return {
    channel: 'harness-broker-v1',
    requestId,
    ok,
    ...(value !== undefined ? { value } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function json(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isPageEventMessage(value: unknown): value is { channel: 'harness-page-event-v1'; event: PageEvent } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { channel?: unknown; event?: unknown };
  return candidate.channel === 'harness-page-event-v1' && !!candidate.event && typeof candidate.event === 'object';
}

function withSenderScope(event: PageEvent, sender: chrome.runtime.MessageSender): PageEvent {
  const tabId = sender.tab?.id;
  if (tabId == null) return event;
  if ('scope' in event) return { ...event, scope: { ...event.scope, tabId, frameId: sender.frameId ?? event.scope.frameId, ...(sender.documentId ? { documentId: sender.documentId } : {}) } };
  if ('annotation' in event) return { ...event, annotation: { ...event.annotation, scope: { ...event.annotation.scope, tabId } } };
  if ('transaction' in event) return { ...event, transaction: { ...event.transaction, scope: { ...event.transaction.scope, tabId } } };
  return event;
}

function readRequestId(value: unknown): string {
  if (!value || typeof value !== 'object') return 'invalid-request';
  const requestId = (value as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' ? requestId : 'invalid-request';
}

function formatError(error: unknown): string {
  if (error instanceof ZodError) return `Invalid broker request: ${error.issues.map(issue => issue.message).join('; ')}`;
  return error instanceof Error ? error.message : String(error);
}
