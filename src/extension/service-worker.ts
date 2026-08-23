import OpenAI from 'openai';
import { ZodError } from 'zod';
import contentScriptFile from './content-script?script&iife';
import { parseCapabilityEnvelope } from '@/shared/broker-schema';
import type { CapabilityEnvelope, CapabilityRequest, CapabilityResponse, CapabilityStreamChunk } from '@/shared/capability-protocol';
import type { PageCommand, PageCommandResult, PageEvent } from '@/shared/page-protocol';
import { toJsonValue, type JsonValue, type LlmStreamEvent } from '@/shared/runtime';
import { OpenAiStreamAccumulator, type OpenAiStreamChunk } from './openai-stream';
import { McpHost } from './mcp-host';
import { createSiteSkillRuntime } from './site-skill-runtime';
import {
  isInspectableUrl,
  pageEventTabId,
  parseSidePanelPortName,
  sidePanelPath,
} from './tab-scope';
import { TrustedCapabilityHost } from './capability-host';

interface StoredLlmConfig { baseURL: string; model: string; apiKey: string }
const LLM_CONFIG_KEY = 'secrets.llm';

const ports = new Map<chrome.runtime.Port, number>();
const mcpHost = new McpHost();
const capabilityHost = new TrustedCapabilityHost();
const siteSkills = createSiteSkillRuntime(executePageCommand, emitPageEvent);

capabilityHost.register('workspace', {
  request: async () => { throw new Error('Workspace requests must be handled by the trusted side-panel provider.'); },
});
capabilityHost.register('page', {
  request: (request, context) => executePageCommand(request.input.command, context.tabId),
});
capabilityHost.register('site-skill', {
  request: (request, context) => siteSkills.request(request, context.tabId),
});
capabilityHost.register('storage', {
  request: async request => {
    switch (request.action) {
      case 'get':
        assertPublicStorageKeys(request.input.keys);
        return toJsonValue(await chrome.storage.local.get(request.input.keys));
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
    return toJsonValue(config ? { configured: true, baseURL: config.baseURL, model: config.model } : { configured: false });
  },
  stream: request => streamLlmCapability(request),
});
capabilityHost.register('mcp', {
  request: (request, context) => mcpHost.request(request, context.tabId),
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void initializeTabPanels().catch(error => console.warn('[harness] could not initialize tab panels', error));
void siteSkills.restoreUserScripts().catch(error => console.warn('[harness] could not restore user scripts', error));

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
    void siteSkills.applyMatching(sender.tab.id, event.scope.url);
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
  void siteSkills.applyMatching(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener(tabId => {
  void mcpHost.closeTab(tabId);
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
  for await (const event of streamLlm(request.input.request)) yield toJsonValue(event);
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
  if (command.type === 'page/eval') return siteSkills.evaluate(tabId, command.code, command.world);

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [contentScriptFile],
  });
  const result = await chrome.tabs.sendMessage(tabId, {
    channel: 'harness-page-v1',
    command,
  }) as PageCommandResult;
  return toJsonValue(result);
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
