import { RequestLifecycle } from '@/shared/request-lifecycle';
import { CapabilityGrants } from './capability-grants';
import { acquireRuntimeLease } from '@/kernel/runtime-lease';
import { BrokerCancellationSchema, assertCapabilitySession, parseCapabilityEnvelope } from '@/shared/broker-schema';
import type { CapabilityEnvelope, CapabilityResponse, CapabilityStreamChunk } from '@/shared/capability-protocol';
import { assertPrincipalAuthorized } from '@/shared/capability-policy';
import { approvalForRequest } from './approval-policy';
import { TrustedCapabilityHost } from './capability-host';
import { OpfsStore } from '@/kernel/opfs-store';
import { assertWorkspaceMutationAllowed } from '@/kernel/plugin-policy';
import { isInspectableUrl, parseSidePanelTabId, sidePanelPortName } from './tab-scope';
import { mountSidePanelUi } from './sidepanel-ui';
import './sidepanel.css';

const view = mountSidePanelUi();
const frame = view.frame;

const binding = await resolveBinding().catch(error => {
  reportStartupFailure(error);
  return suspendStartup();
});
const boundTabId = binding.tabId;
const boundHost = binding.host;
view.setBinding(boundTabId, boundHost);
const releaseRuntime = await acquireRuntimeLease(boundHost).catch(error => { reportStartupFailure(error); return suspendStartup(); });
window.addEventListener('pagehide', releaseRuntime, { once: true });
let boundOrigin = '';
let boundOriginPattern = '';
let sandboxReady = false;
let pendingAuthorizedRead = false;
const brokerSessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
let brokerSessionIssued = false;

let port: chrome.runtime.Port | null = null;
let portConnected = false;
const activeBrokerRequests = new Map<string, boolean>();
const requests = new RequestLifecycle();
const grantsKey = 'harness.capability-grants';
const grants = new CapabilityGrants((await chrome.storage.local.get(grantsKey))[grantsKey] as ConstructorParameters<typeof CapabilityGrants>[0]);
const opfs = new OpfsStore();
opfs.onChange(() => {
  frame.contentWindow?.postMessage({ channel: 'harness-shell-v1', type: 'workspace-changed' }, '*');
});
const localCapabilityHost = new TrustedCapabilityHost();
localCapabilityHost.register('workspace', {
  request: (request, context) => {
    if (request.action !== 'list') assertWorkspaceMutationAllowed(context.principal, request.input.path);
    return opfs.handle(request);
  },
});

function connect(): chrome.runtime.Port {
  if (portConnected && port) return port;
  let connectedPort: chrome.runtime.Port;
  try {
    connectedPort = chrome.runtime.connect({ name: sidePanelPortName(boundTabId) });
  } catch (error) {
    portConnected = false;
    port = null;
    const reason = error instanceof Error ? error : new Error(String(error));
    // An unpacked extension reload invalidates every API object owned by the
    // existing side-panel document. Only reloading that document can bind it
    // to the new extension context.
    window.location.reload();
    throw reason;
  }
  port = connectedPort;
  portConnected = true;
  connectedPort.onMessage.addListener(message => {
    const streamChunk = message as Partial<CapabilityStreamChunk>;
    if (streamChunk.stream === true && streamChunk.done === true && typeof streamChunk.requestId === 'string') {
      activeBrokerRequests.delete(streamChunk.requestId);
      requests.finish(streamChunk.requestId);
    }
    const response = message as Partial<CapabilityResponse>;
    if (typeof response.requestId === 'string' && typeof response.ok === 'boolean') {
      activeBrokerRequests.delete(response.requestId);
      requests.finish(response.requestId);
    }
    frame.contentWindow?.postMessage(message, '*');
  });
  connectedPort.onDisconnect.addListener(() => disconnectPort(connectedPort));
  return connectedPort;
}

function disconnectPort(disconnectedPort: chrome.runtime.Port): void {
  if (port !== disconnectedPort) return;
  port = null;
  portConnected = false;
  for (const [requestId, stream] of activeBrokerRequests) {
    replyBrokerError(requestId, new Error('Broker connection closed before the request completed. Please retry.'), stream);
  }
  activeBrokerRequests.clear();
  requests.close();
}

function postEnvelope(envelope: CapabilityEnvelope): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    const connectedPort = connect();
    try {
      connectedPort.postMessage(envelope);
      return;
    } catch (error) {
      disconnectPort(connectedPort);
      if (attempt === 1) throw error;
    }
  }
}

window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow) return;
  const shellMessage = event.data as { channel?: unknown; type?: unknown } | null;
  if (shellMessage?.channel === 'harness-shell-v1' && shellMessage.type === 'broker-session-hello') {
    if (!brokerSessionIssued) {
      brokerSessionIssued = true;
      frame.contentWindow?.postMessage({
        channel: 'harness-shell-v1',
        type: 'broker-session',
        token: brokerSessionToken,
        host: boundHost,
      }, '*');
    }
    return;
  }
  if (shellMessage?.channel === 'harness-shell-v1' && shellMessage.type === 'ready') {
    sandboxReady = true;
    view.setReady();
    flushAuthorizedRead();
    return;
  }
  if (shellMessage?.channel === 'harness-shell-v1' && shellMessage.type === 'boot-error') {
    const detail = typeof (event.data as { error?: unknown }).error === 'string'
      ? (event.data as { error: string }).error
      : '未知启动错误';
    view.setFailure('Harness 启动失败', detail);
    return;
  }
  if (shellMessage?.channel === 'harness-shell-v1' && shellMessage.type === 'open-options') {
    void chrome.runtime.openOptionsPage();
    return;
  }
  try {
    const cancellation = BrokerCancellationSchema.safeParse(event.data);
    if (cancellation.success) {
      if (cancellation.data.session !== brokerSessionToken) throw new Error('Invalid broker session.');
      requests.cancel(cancellation.data.requestId);
      return;
    }
    const envelope = parseCapabilityEnvelope(event.data);
    assertCapabilitySession(envelope, brokerSessionToken);
    envelope.principal = grants.resolve(envelope.principal);
    void forwardEnvelope(envelope).catch(error => replyBrokerError(envelope.requestId, error,
      envelope.payload.provider === 'llm' && envelope.payload.action === 'complete'));
  } catch (error) {
    const candidate = event.data as { requestId?: unknown } | null;
    replyBrokerError(typeof candidate?.requestId === 'string' ? candidate.requestId : 'invalid-request', error);
  }
});

connect();
void refreshSiteAccess();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== boundTabId || !changeInfo.url) return;
  const nextHost = hostFromUrl(changeInfo.url);
  if (nextHost && nextHost !== boundHost) {
    window.location.reload();
    return;
  }
  void refreshSiteAccess();
});

function flushAuthorizedRead(): void {
  if (!sandboxReady || !pendingAuthorizedRead) return;
  pendingAuthorizedRead = false;
  frame.contentWindow?.postMessage({
    channel: 'harness-shell-v1',
    type: 'site-authorized-and-read',
    origin: boundOrigin,
  }, '*');
}

async function resolveBinding(): Promise<{ tabId: number; host: string }> {
  const tabId = parseSidePanelTabId(location.href);
  if (tabId == null) throw new Error('Harness side panel is not bound to a tab.');
  const tab = await chrome.tabs.get(tabId);
  const host = hostFromUrl(tab.url);
  if (!host) throw new Error('当前标签页没有可用的网页 host。');
  return { tabId, host };
}

function hostFromUrl(value: string | undefined): string | null {
  if (!isInspectableUrl(value)) return null;
  return new URL(value).host;
}

async function refreshSiteAccess(): Promise<void> {
  const tab = await chrome.tabs.get(boundTabId);
  if (!isInspectableUrl(tab.url)) {
    boundOrigin = '';
    boundOriginPattern = '';
    view.setSiteAccess(null);
    return;
  }
  boundOrigin = new URL(tab.url).origin;
  boundOriginPattern = `${boundOrigin}/*`;
  const granted = await chrome.permissions.contains({ origins: [boundOriginPattern] });
  view.setSiteAccess(granted ? null : {
    label: `允许 Harness 读取并修改 ${boundOrigin}`,
    originPattern: boundOriginPattern,
    onGranted() {
      pendingAuthorizedRead = true;
      flushAuthorizedRead();
    },
  });
}

function replyBrokerError(requestId: string, error: unknown, stream = false): void {
  const message = error instanceof Error ? error.message : String(error);
  if (stream) {
    frame.contentWindow?.postMessage({
      channel: 'harness-broker-v1', requestId, stream: true, done: true, error: message,
    } satisfies CapabilityStreamChunk, '*');
    return;
  }
  frame.contentWindow?.postMessage({
    channel: 'harness-broker-v1', requestId, ok: false, error: message,
  } satisfies CapabilityResponse, '*');
}

async function forwardEnvelope(envelope: CapabilityEnvelope): Promise<void> {
  assertPrincipalAuthorized(envelope.principal, envelope.payload);
  const signal = requests.start(envelope.requestId, envelope.deadline);
  const isStream = envelope.payload.provider === 'llm' && envelope.payload.action === 'complete';
  signal.addEventListener('abort', () => {
    activeBrokerRequests.delete(envelope.requestId);
    port?.postMessage({ channel: 'harness-broker-v1', session: brokerSessionToken, requestId: envelope.requestId, cancel: true });
    replyBrokerError(envelope.requestId, new Error('Broker request cancelled.'), isStream);
  }, { once: true });
  try {
    const request = envelope.payload;
    if (request.provider === 'runtime') {
      const manifest = request.input.manifest;
      await grants.authorize(manifest, () => view.requestApproval({
        title: `允许插件 ${manifest.title} 使用这些权限？`,
        body: manifest.permissions.map(item => `${item.id}${item.reason ? `: ${item.reason}` : ''}`).join('\n'), confirmLabel: '授权插件',
      }, signal), async value => navigator.locks.request(grantsKey, async () => {
        signal.throwIfAborted();
        const current = (await chrome.storage.local.get(grantsKey))[grantsKey] as Record<string, unknown> | undefined;
        signal.throwIfAborted();
        await chrome.storage.local.set({ [grantsKey]: { ...current, [value.id]: value } });
      }));
      signal.throwIfAborted();
      frame.contentWindow?.postMessage({ channel: 'harness-broker-v1', requestId: envelope.requestId, ok: true, value: null }, '*');
      requests.finish(envelope.requestId);
      return;
    }
    const approval = approvalForRequest(request);
    const alreadyGranted = approval?.reuseGrantedOrigins && approval.origins
      ? await chrome.permissions.contains({ origins: approval.origins }) : false;
    signal.throwIfAborted();
    if (approval && !alreadyGranted && !await view.requestApproval(approval, signal)) throw new Error('User declined the trusted-shell approval prompt.');
    signal.throwIfAborted();
    if (localCapabilityHost.has(request.provider)) {
      const value = await localCapabilityHost.request(request, { tabId: boundTabId, principal: envelope.principal, signal });
      signal.throwIfAborted();
      frame.contentWindow?.postMessage({ channel: 'harness-broker-v1', requestId: envelope.requestId, ok: true, value }, '*');
      requests.finish(envelope.requestId);
    } else {
      activeBrokerRequests.set(envelope.requestId, isStream);
      postEnvelope(envelope);
    }
  } catch (error) {
    requests.finish(envelope.requestId);
    activeBrokerRequests.delete(envelope.requestId);
    throw error;
  }
}

function reportStartupFailure(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  view.setFailure('Harness 无法启动', detail, true);
  console.error('[harness] side panel startup failed', error);
}

function suspendStartup(): Promise<never> {
  return new Promise(() => undefined);
}
