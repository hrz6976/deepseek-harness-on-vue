import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';
import OpenAI from 'openai';
import { ZodError } from 'zod';
import contentScriptFile from './content-script?script&iife';
import { parseCapabilityEnvelope } from '@/shared/broker-schema';
import type {
  CapabilityEnvelope,
  CapabilityRequest,
  CapabilityResponse,
  CapabilityStreamChunk,
} from '@/shared/capability-protocol';
import type {
  PageCommand,
  PageCommandResult,
  PageEvent,
  PatchOperation,
  SiteSkill,
  SiteUserScript,
  SiteRecipe,
} from '@/shared/page-protocol';
import { isSiteUserScript } from '@/shared/page-protocol';
import type { JsonValue, LlmStreamEvent } from '@/shared/runtime';
import { OpenAiStreamAccumulator, type OpenAiStreamChunk } from './openai-stream';
import {
  isInspectableUrl,
  pageEventTabId,
  parseSidePanelPortName,
  sidePanelPath,
} from './tab-scope';
import { TrustedCapabilityHost } from './capability-host';

interface StoredLlmConfig { baseURL: string; model: string; apiKey: string }
const LLM_CONFIG_KEY = 'secrets.llm';
const RECIPES_KEY = 'public.recipes';
const USER_SCRIPT_ID_PREFIX = 'harness:';

const ports = new Map<chrome.runtime.Port, number>();
const mcpClients = new Map<string, Client>();
const capabilityHost = new TrustedCapabilityHost();

capabilityHost.register('workspace', {
  request: async () => { throw new Error('Workspace requests must be handled by the trusted side-panel provider.'); },
});
capabilityHost.register('page', {
  request: (request, context) => executePageCommand(request.input.command, context.tabId),
});
capabilityHost.register('site-skill', {
  request: async (request, context) => {
    switch (request.action) {
      case 'list': return json(await readRecipes());
      case 'save': {
        const saved = await saveRecipe(request.input.skill);
        if (isSiteUserScript(saved)) {
          await removeLiveRulesFromTab(saved.id, context.tabId);
        } else if (!saved.enabled) await removeLiveRulesFromTab(saved.id, context.tabId);
        else if (saved.liveRules?.length) {
          await executePageCommand({
            type: 'page/live-rules-install', id: saved.id, label: `recipe: ${saved.name}`, rules: saved.liveRules,
          }, context.tabId);
        }
        return json(saved);
      }
      case 'remove': return await removeRecipe(request.input.id, context.tabId);
      case 'apply': return await applyRecipe(request.input.id, context.tabId);
    }
  },
});
capabilityHost.register('storage', {
  request: async request => {
    switch (request.action) {
      case 'get':
        assertPublicStorageKeys(request.input.keys);
        return json(await chrome.storage.local.get(request.input.keys));
      case 'set':
        assertPublicStorageKeys(Object.keys(request.input.values));
        await chrome.storage.local.set(request.input.values);
        return null;
      case 'remove':
        assertPublicStorageKeys(request.input.keys);
        await chrome.storage.local.remove(request.input.keys);
        return null;
    }
  },
});
capabilityHost.register('llm', {
  request: async request => {
    if (request.action === 'complete') throw new Error('LLM completion requests use the streaming provider path.');
    const config = await readLlmConfig();
    return json(config ? { configured: true, baseURL: config.baseURL, model: config.model } : { configured: false });
  },
  stream: request => streamLlmCapability(request),
});
capabilityHost.register('mcp', {
  request: async (request, context) => {
    switch (request.action) {
      case 'connect': return await connectMcp(request, context.tabId);
      case 'disconnect': return await disconnectMcp(request.input.id, context.tabId);
      case 'list-tools': return json(await requireMcp(request.input.id, context.tabId).listTools());
      case 'call-tool': return json(await requireMcp(request.input.id, context.tabId).callTool({
        name: request.input.name,
        ...(request.input.arguments ? { arguments: request.input.arguments } : {}),
      }));
    }
  },
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void initializeTabPanels().catch(error => console.warn('[harness] could not initialize tab panels', error));
void restoreUserScripts().catch(error => console.warn('[harness] could not restore user scripts', error));

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

chrome.tabs.onRemoved.addListener(tabId => {
  void closeMcpClientsForTab(tabId);
});

async function configureExistingTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.flatMap(tab => tab.id == null
    ? []
    : [configureTabPanel(tab.id, tab.pendingUrl ?? tab.url)]));
}

async function initializeTabPanels(): Promise<void> {
  // Prevent the manifest default panel from opening before its tab-specific
  // path has been assigned. `configureTabPanel()` re-enables valid tabs.
  await chrome.action.disable();
  await configureExistingTabs();
}

async function configureTabPanel(tabId: number, url: string | undefined): Promise<void> {
  try {
    if (isInspectableUrl(url)) {
      await chrome.sidePanel.setOptions({
        tabId,
        path: sidePanelPath(tabId),
        enabled: true,
      });
      await chrome.action.enable(tabId);
    } else {
      await Promise.all([
        chrome.sidePanel.setOptions({ tabId, enabled: false }),
        chrome.action.disable(tabId),
      ]);
    }
  } catch (error) {
    await chrome.action.disable(tabId).catch(() => undefined);
    console.warn(`[harness] could not configure side panel for tab ${tabId}`, error);
  }
}

async function replyToPort(port: chrome.runtime.Port, tabId: number, value: unknown): Promise<void> {
  let envelope: CapabilityEnvelope;
  try {
    envelope = parseCapabilityEnvelope(value);
  } catch (error) {
    const requestId = readRequestId(value);
    port.postMessage(response(requestId, false, undefined, formatError(error)));
    return;
  }

  if (envelope.payload.provider === 'llm' && envelope.payload.action === 'complete') {
    // Confirm that the envelope crossed the side-panel/service-worker boundary.
    // This is transport acknowledgement only; it is not a model stream event.
    port.postMessage({
      channel: 'harness-broker-v1',
      requestId: envelope.requestId,
      stream: true,
      done: false,
    } satisfies CapabilityStreamChunk);
    let receivedModelEvent = false;
    try {
      for await (const value of capabilityHost.stream(envelope.payload, { tabId, principal: envelope.principal })) {
        receivedModelEvent = true;
        const event = value as unknown as LlmStreamEvent;
        const terminal = event.type === 'done' || event.type === 'error';
        port.postMessage({
          channel: 'harness-broker-v1',
          requestId: envelope.requestId,
          stream: true,
          done: terminal,
          value,
        } satisfies CapabilityStreamChunk);
        if (terminal) return;
      }
      port.postMessage({ channel: 'harness-broker-v1', requestId: envelope.requestId, stream: true, done: true } satisfies CapabilityStreamChunk);
    } catch (error) {
      port.postMessage({
        channel: 'harness-broker-v1',
        requestId: envelope.requestId,
        stream: true,
        done: true,
        error: `${receivedModelEvent ? 'LLM stream failed' : 'LLM request failed before the first response chunk'}: ${formatError(error)}`,
      } satisfies CapabilityStreamChunk);
    }
    return;
  }

  try {
    const result = await capabilityHost.request(envelope.payload, { tabId, principal: envelope.principal });
    port.postMessage(response(envelope.requestId, true, result));
  } catch (error) {
    port.postMessage(response(envelope.requestId, false, undefined, formatError(error)));
  }
}

async function readRecipes(): Promise<SiteSkill[]> {
  const stored = (await chrome.storage.local.get(RECIPES_KEY))[RECIPES_KEY] as SiteSkill[] | undefined;
  if (!Array.isArray(stored)) return [];
  return stored.map(skill => skill.type ? skill : { ...skill, type: 'recipe' as const });
}

async function saveRecipe(recipe: SiteSkill): Promise<SiteSkill> {
  const recipes = await readRecipes();
  const existing = recipes.find(item => item.id === recipe.id);
  const saved: SiteSkill = isSiteUserScript(recipe)
    ? { ...recipe, createdAt: existing?.createdAt ?? recipe.createdAt, updatedAt: Date.now() }
    : {
        ...recipe,
        type: 'recipe',
        ...(recipe.operations ? { operations: recipe.operations.map((operation, index) => persistentOperation(recipe.id, index, operation)) } : {}),
        createdAt: existing?.createdAt ?? recipe.createdAt,
        updatedAt: Date.now(),
      };

  if (existing && isSiteUserScript(existing) && !isSiteUserScript(saved)) {
    await unregisterUserScript(existing.id);
  }
  if (isSiteUserScript(saved)) {
    if (saved.enabled) await upsertUserScript(saved);
    else await unregisterUserScript(saved.id);
  }

  const next = recipes.filter(item => item.id !== saved.id);
  next.push(saved);
  await chrome.storage.local.set({ [RECIPES_KEY]: next });
  emitPageEvent({ type: 'recipe/installed', recipe: saved });
  return saved;
}

async function removeRecipe(id: string, tabId: number): Promise<null> {
  const recipes = await readRecipes();
  const existing = recipes.find(recipe => recipe.id === id);
  if (existing && isSiteUserScript(existing)) await unregisterUserScript(existing.id);
  await chrome.storage.local.set({ [RECIPES_KEY]: recipes.filter(recipe => recipe.id !== id) });
  await removeLiveRulesFromTab(id, tabId);
  emitPageEvent({ type: 'recipe/disposed', recipeId: id });
  return null;
}

function persistentOperation(recipeId: string, index: number, operation: PatchOperation): PatchOperation {
  const { documentId: _documentId, generation: _generation, ...target } = operation.target;
  return {
    ...operation,
    target: { ...target, nodeRef: `recipe_${recipeId}_${index}` },
  } as PatchOperation;
}

async function removeLiveRulesFromTab(id: string, tabId: number): Promise<void> {
  try { await executePageCommand({ type: 'page/live-rules-remove', id }, tabId); }
  catch { /* the page may have navigated or closed; persisted state is already authoritative */ }
}

async function applyRecipe(id: string, tabId: number): Promise<JsonValue> {
  const recipe = (await readRecipes()).find(item => item.id === id);
  if (!recipe) throw new Error(`Recipe "${id}" does not exist.`);
  if (isSiteUserScript(recipe)) {
    if (!recipe.enabled) throw new Error(`User script "${id}" is disabled.`);
    return await evaluateUserScript(tabId, recipe.source, 'USER_SCRIPT');
  }
  if (!recipe.operations?.length && !recipe.liveRules?.length) throw new Error(`Recipe "${id}" has no declarative operations or live rules.`);
  const result: Record<string, JsonValue> = {};
  if (recipe.operations?.length) {
    result.operations = await executePageCommand({
      type: 'page/patch-apply',
      label: `recipe: ${recipe.name}`,
      operations: recipe.operations,
    }, tabId);
  }
  if (recipe.liveRules?.length) {
    result.liveRules = await executePageCommand({
      type: 'page/live-rules-install',
      id: recipe.id,
      label: `recipe: ${recipe.name}`,
      rules: recipe.liveRules,
    }, tabId);
  }
  return result;
}

async function applyMatchingRecipes(tabId: number, url: string): Promise<void> {
  const recipes = (await readRecipes()).filter(recipe => recipe.enabled
    && !isSiteUserScript(recipe)
    && (recipe.operations?.length || recipe.liveRules?.length)
    && recipe.matches.some(pattern => matchesPattern(pattern, url)));
  if (!recipes.length) return;
  const allowed = await chrome.permissions.contains({ origins: [originPattern(new URL(url).origin)] });
  if (!allowed) return;
  for (const recipe of recipes) {
    try { await applyRecipe(recipe.id, tabId); }
    catch (error) { console.warn(`[harness] recipe ${recipe.id} failed`, error); }
  }
}

function userScriptRegistrationId(id: string): string {
  return `${USER_SCRIPT_ID_PREFIX}${id}`;
}

async function userScriptsApi(): Promise<typeof chrome.userScripts | null> {
  try {
    const api = chrome.userScripts;
    await api.getScripts();
    return api;
  } catch {
    return null;
  }
}

function userScriptsEnablementMessage(): string {
  const major = Number(/(?:Chrome|Chromium)\/(\d+)/u.exec(navigator.userAgent)?.[1] ?? 0);
  return major >= 138
    ? 'Chrome User Scripts 未启用。请在 chrome://extensions 的 Harness 详情中开启“允许用户脚本”，然后重新打开 Harness。'
    : 'Chrome User Scripts 未启用。当前 Chrome 版本需要在 chrome://extensions 开启开发者模式，然后重新打开 Harness。';
}

async function requireUserScriptsApi(): Promise<typeof chrome.userScripts> {
  const api = await userScriptsApi();
  if (api) return api;
  throw new Error(userScriptsEnablementMessage());
}

function registeredUserScript(script: SiteUserScript): chrome.userScripts.RegisteredUserScript {
  return {
    id: userScriptRegistrationId(script.id),
    matches: script.matches,
    runAt: script.runAt,
    world: 'USER_SCRIPT',
    js: [{ code: script.source }],
  };
}

async function upsertUserScript(script: SiteUserScript): Promise<void> {
  const api = await requireUserScriptsApi();
  const registered = registeredUserScript(script);
  const existing = await api.getScripts({ ids: [registered.id] });
  if (existing.length) await api.update([registered]);
  else await api.register([registered]);
}

async function unregisterUserScript(id: string): Promise<void> {
  const api = await userScriptsApi();
  if (!api) return;
  const registrationId = userScriptRegistrationId(id);
  const existing = await api.getScripts({ ids: [registrationId] });
  if (existing.length) await api.unregister({ ids: [registrationId] });
}

async function restoreUserScripts(): Promise<void> {
  const api = await userScriptsApi();
  if (!api) return;
  const scripts = (await readRecipes()).filter(isSiteUserScript);
  const enabled = new Map(scripts.filter(script => script.enabled)
    .map(script => [userScriptRegistrationId(script.id), script]));
  const registered = (await api.getScripts())
    .filter(script => script.id.startsWith(USER_SCRIPT_ID_PREFIX));
  const stale = registered.filter(script => !enabled.has(script.id)).map(script => script.id);
  if (stale.length) await api.unregister({ ids: stale });

  const registeredIds = new Set(registered.map(script => script.id));
  for (const [id, script] of enabled) {
    const definition = registeredUserScript(script);
    if (registeredIds.has(id)) await api.update([definition]);
    else await api.register([definition]);
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

async function* streamLlmCapability(request: Extract<CapabilityRequest, { provider: 'llm' }>): AsyncIterable<JsonValue> {
  if (request.action !== 'complete') throw new Error(`LLM action "${request.action}" is not streamable.`);
  for await (const event of streamLlm(request.input.request)) yield json(event);
}

async function* streamLlm(
  request: Extract<CapabilityRequest, { provider: 'llm'; action: 'complete' }>['input']['request'],
): AsyncIterable<LlmStreamEvent> {
  const config = await readLlmConfig();
  if (!config) throw new Error('LLM 尚未配置；请打开扩展设置填写 API endpoint、model 和 key。');
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    dangerouslyAllowBrowser: true,
    // One provider-owned deadline is easier to reason about than an SDK retry
    // racing a second sandbox timeout. Agent turns are not transparently
    // replayed; a timeout is surfaced and the user/loop decides whether to retry.
    maxRetries: 0,
    timeout: 120_000,
  });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: request.systemPrompt },
  ];
  for (const message of request.messages) {
    if (message.role === 'user') messages.push({ role: 'user', content: message.text });
    if (message.role === 'summary') messages.push({ role: 'user', content: `[Context checkpoint]\n\n${message.text}` });
    if (message.role !== 'assistant') continue;
    const assistantMessage: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
      role: 'assistant',
      content: message.text || null,
      ...(message.toolCalls.length ? {
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.args || JSON.stringify(call.argsObj ?? {}) },
        })),
      } : {}),
    };
    // DeepSeek thinking mode requires the intermediate assistant reasoning to
    // be replayed alongside tool calls on the following sub-turn. Dropping it
    // makes the provider reconstruct a different chain on every tool round.
    if (message.thinking) assistantMessage.reasoning_content = message.thinking;
    messages.push(assistantMessage);
    for (const call of message.toolCalls) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: call.result ?? '(not executed)' });
    }
  }

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = request.tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
  const completion = await client.chat.completions.create({
    model: config.model,
    messages,
    ...(tools.length ? { tools } : {}),
    stream: true,
    stream_options: { include_usage: true },
  });
  const accumulator = new OpenAiStreamAccumulator();
  for await (const chunk of completion) {
    yield accumulator.ingest(chunk as unknown as OpenAiStreamChunk);
  }
  yield accumulator.done();
}

async function readLlmConfig(): Promise<StoredLlmConfig | null> {
  const value = (await chrome.storage.local.get(LLM_CONFIG_KEY))[LLM_CONFIG_KEY] as StoredLlmConfig | undefined;
  if (!value?.apiKey || !value.baseURL || !value.model) return null;
  return value;
}

function assertPublicStorageKeys(keys: string[]): void {
  if (keys.some(key => key.startsWith('secrets.'))) {
    throw new Error('Sandbox code cannot access trusted secret storage.');
  }
}

async function executePageCommand(command: PageCommand, tabId: number): Promise<JsonValue> {
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
  const api = await requireUserScriptsApi();
  if (!api.execute) throw new Error('当前 Chrome 版本不支持即时执行 User Script。');
  const wrapped = `(async () => {
    const value = await (0, eval)(${JSON.stringify(code)});
    if (value === undefined) return null;
    try { return JSON.parse(JSON.stringify(value)); }
    catch { return String(value); }
  })()`;
  const [result] = await api.execute<JsonValue>({
    js: [{ code: wrapped }],
    target: { tabId },
    world,
  });
  if (!result) return null;
  if ('error' in result) throw new Error(result.error);
  return result.result;
}

async function connectMcp(
  request: Extract<CapabilityRequest, { provider: 'mcp'; action: 'connect' }>,
  tabId: number,
): Promise<JsonValue> {
  await disconnectMcp(request.input.id, tabId);
  const url = new URL(request.input.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The browser MCP transport accepts only HTTP(S) endpoints.');
  const client = new Client({ name: 'harness-page-agent', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(url, request.input.headers
    ? { requestInit: { headers: request.input.headers } }
    : undefined);
  await client.connect(transport);
  mcpClients.set(mcpKey(tabId, request.input.id), client);
  return json({ connected: true, tools: (await client.listTools()).tools });
}

async function disconnectMcp(id: string, tabId: number): Promise<JsonValue> {
  const key = mcpKey(tabId, id);
  const client = mcpClients.get(key);
  if (!client) return null;
  mcpClients.delete(key);
  await client.close();
  return null;
}

function requireMcp(id: string, tabId: number): Client {
  const client = mcpClients.get(mcpKey(tabId, id));
  if (!client) throw new Error(`MCP connection "${id}" is not open.`);
  return client;
}

function mcpKey(tabId: number, id: string): string {
  return `${tabId}:${id}`;
}

async function closeMcpClientsForTab(tabId: number): Promise<void> {
  const prefix = `${tabId}:`;
  const clients = [...mcpClients.entries()].filter(([key]) => key.startsWith(prefix));
  for (const [key, client] of clients) {
    mcpClients.delete(key);
    try { await client.close(); }
    catch (error) { console.warn(`[harness] failed to close MCP client ${key}`, error); }
  }
}

function originPattern(origin: string): string {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) origins can be granted.');
  return `${url.origin}/*`;
}

function response(requestId: string, ok: boolean, value?: JsonValue, error?: string): CapabilityResponse {
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
