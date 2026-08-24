import { assertCapabilitySession, parseCapabilityEnvelope } from '@/shared/broker-schema';
import type { CapabilityEnvelope, CapabilityResponse, CapabilityStreamChunk } from '@/shared/capability-protocol';
import { assertPrincipalAuthorized } from '@/shared/capability-policy';
import { approvalForRequest, type ApprovalRequest } from './approval-policy';
import { TrustedCapabilityHost } from './capability-host';
import { OpfsStore } from '@/kernel/opfs-store';
import { assertWorkspaceMutationAllowed } from '@/kernel/plugin-policy';
import { isInspectableUrl, parseSidePanelTabId, sidePanelPortName } from './tab-scope';
import { requiredElement } from './required-element';
import './sidepanel.css';

const frame = requiredElement<HTMLIFrameElement>('#harness-sandbox');
const sandboxStatus = requiredElement<HTMLElement>('#sandbox-status');
const siteAccess = requiredElement<HTMLElement>('#site-access');
const siteAccessLabel = requiredElement<HTMLElement>('#site-access-label');
const siteAccessButton = requiredElement<HTMLButtonElement>('#site-access-button');
const approvalDialog = requiredElement<HTMLDialogElement>('#approval-dialog');
const approvalTitle = requiredElement<HTMLElement>('#approval-title');
const approvalBody = requiredElement<HTMLElement>('#approval-body');
const approvalConfirm = requiredElement<HTMLButtonElement>('#approval-confirm');

const binding = await resolveBinding().catch(error => {
  reportStartupFailure(error);
  return suspendStartup();
});
const boundTabId = binding.tabId;
frame.dataset.tabId = String(boundTabId);
const boundHost = binding.host;
frame.dataset.host = boundHost;
let boundOrigin = '';
let boundOriginPattern = '';
let sandboxReady = false;
let pendingAuthorizedRead = false;
const brokerSessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
let brokerSessionIssued = false;

let port: chrome.runtime.Port | null = null;
let portConnected = false;
const activeBrokerRequests = new Map<string, boolean>();
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
    }
    const response = message as Partial<CapabilityResponse>;
    if (typeof response.requestId === 'string' && typeof response.ok === 'boolean') {
      activeBrokerRequests.delete(response.requestId);
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
    sandboxStatus.hidden = true;
    frame.hidden = false;
    flushAuthorizedRead();
    return;
  }
  if (shellMessage?.channel === 'harness-shell-v1' && shellMessage.type === 'boot-error') {
    const detail = typeof (event.data as { error?: unknown }).error === 'string'
      ? (event.data as { error: string }).error
      : '未知启动错误';
    sandboxStatus.querySelector('strong')!.textContent = 'Harness 启动失败';
    sandboxStatus.querySelector('span')!.textContent = detail;
    sandboxStatus.classList.add('failed');
    return;
  }
  if (shellMessage?.channel === 'harness-shell-v1' && shellMessage.type === 'open-options') {
    void chrome.runtime.openOptionsPage();
    return;
  }
  try {
    const envelope = parseCapabilityEnvelope(event.data);
    assertCapabilitySession(envelope, brokerSessionToken);
    if (localCapabilityHost.has(envelope.payload.provider)) {
      void localCapabilityHost.request(envelope.payload, { tabId: boundTabId, principal: envelope.principal }).then(
        value => frame.contentWindow?.postMessage({ channel: 'harness-broker-v1', requestId: envelope.requestId, ok: true, value } satisfies CapabilityResponse, '*'),
        error => frame.contentWindow?.postMessage({ channel: 'harness-broker-v1', requestId: envelope.requestId, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies CapabilityResponse, '*'),
      );
      return;
    }
    void forwardEnvelope(envelope).catch(error => replyBrokerError(
      envelope.requestId,
      error,
      envelope.payload.provider === 'llm' && envelope.payload.action === 'complete',
    ));
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

siteAccessButton.addEventListener('click', () => {
  if (!boundOriginPattern) return;
  siteAccessButton.disabled = true;
  // Called directly in the trusted button gesture; do not insert an await
  // before permissions.request or Chrome will reject the prompt.
  void chrome.permissions.request({ origins: [boundOriginPattern] }).then(
    granted => {
      siteAccessButton.disabled = false;
      if (!granted) return;
      siteAccess.hidden = true;
      pendingAuthorizedRead = true;
      flushAuthorizedRead();
    },
    error => {
      siteAccessButton.disabled = false;
      siteAccessLabel.textContent = error instanceof Error ? error.message : String(error);
    },
  );
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
    siteAccess.hidden = true;
    return;
  }
  boundOrigin = new URL(tab.url).origin;
  boundOriginPattern = `${boundOrigin}/*`;
  const granted = await chrome.permissions.contains({ origins: [boundOriginPattern] });
  siteAccessLabel.textContent = `允许 Harness 读取并修改 ${boundOrigin}`;
  siteAccess.hidden = granted;
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
  const approval = approvalForRequest(envelope.payload);
  const originAccessAlreadyGranted = approval?.reuseGrantedOrigins && approval.origins
    ? await chrome.permissions.contains({ origins: approval.origins })
    : false;
  if (approval && !originAccessAlreadyGranted && !await requestApproval(approval)) {
    frame.contentWindow?.postMessage({
      channel: 'harness-broker-v1',
      requestId: envelope.requestId,
      ok: false,
      error: 'User declined the trusted-shell approval prompt.',
    } satisfies CapabilityResponse, '*');
    return;
  }
  const isStream = envelope.payload.provider === 'llm' && envelope.payload.action === 'complete';
  try {
    postEnvelope(envelope);
    activeBrokerRequests.set(envelope.requestId, isStream);
  } catch (error) {
    activeBrokerRequests.delete(envelope.requestId);
    throw error;
  }
}

let approvalQueue = Promise.resolve();

function requestApproval(request: ApprovalRequest): Promise<boolean> {
  const result = approvalQueue.then(() => showApproval(request));
  approvalQueue = result.then(() => undefined, () => undefined);
  return result;
}

function showApproval(request: ApprovalRequest): Promise<boolean> {
  approvalTitle.textContent = request.title;
  approvalBody.textContent = request.body;
  approvalConfirm.textContent = request.confirmLabel;
  approvalConfirm.disabled = false;
  const origins = request.origins;
  approvalConfirm.onclick = origins ? event => {
    event.preventDefault();
    approvalConfirm.disabled = true;
    void chrome.permissions.request({ origins }).then(
      granted => approvalDialog.close(granted ? 'confirm' : 'cancel'),
      error => { approvalBody.textContent = error instanceof Error ? error.message : String(error); approvalConfirm.disabled = false; },
    );
  } : null;
  approvalDialog.classList.toggle('danger', request.danger === true);
  approvalDialog.returnValue = '';
  approvalDialog.showModal();
  return new Promise(resolve => {
    approvalDialog.addEventListener('close', () => resolve(approvalDialog.returnValue === 'confirm'), { once: true });
  });
}
function reportStartupFailure(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  sandboxStatus.querySelector('strong')!.textContent = 'Harness 无法启动';
  sandboxStatus.querySelector('span')!.textContent = detail;
  sandboxStatus.classList.add('failed');
  sandboxStatus.hidden = false;
  frame.hidden = true;
  frame.src = 'about:blank';
  console.error('[harness] side panel startup failed', error);
}

function suspendStartup(): Promise<never> {
  return new Promise(() => undefined);
}
