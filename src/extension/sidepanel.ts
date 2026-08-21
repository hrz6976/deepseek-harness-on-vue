import { parseBrokerEnvelope } from '../shared/broker-schema';
import type { BrokerEnvelope, BrokerRequest, BrokerResponse } from '../shared/page-protocol';
import { approvalForRequest, type ApprovalRequest } from './approval-policy';
import { OpfsStore } from './opfs-store';
import { isInspectableUrl, parseSidePanelTabId, sidePanelPortName } from './tab-scope';
import './sidepanel.css';

const frameElement = document.querySelector<HTMLIFrameElement>('#harness-sandbox');
if (!frameElement) throw new Error('Harness sandbox frame is missing.');
const frame = frameElement;
const sandboxStatusElement = document.querySelector<HTMLElement>('#sandbox-status');
const siteAccessElement = document.querySelector<HTMLElement>('#site-access');
const siteAccessLabelElement = document.querySelector<HTMLElement>('#site-access-label');
const siteAccessButtonElement = document.querySelector<HTMLButtonElement>('#site-access-button');
const approvalDialogElement = document.querySelector<HTMLDialogElement>('#approval-dialog');
const approvalTitleElement = document.querySelector<HTMLElement>('#approval-title');
const approvalBodyElement = document.querySelector<HTMLElement>('#approval-body');
const approvalConfirmElement = document.querySelector<HTMLButtonElement>('#approval-confirm');
if (!sandboxStatusElement || !siteAccessElement || !siteAccessLabelElement || !siteAccessButtonElement
  || !approvalDialogElement || !approvalTitleElement || !approvalBodyElement || !approvalConfirmElement) {
  throw new Error('Harness trusted site-access controls are missing.');
}
const sandboxStatus = sandboxStatusElement;
const siteAccess = siteAccessElement;
const siteAccessLabel = siteAccessLabelElement;
const siteAccessButton = siteAccessButtonElement;
const approvalDialog = approvalDialogElement;
const approvalTitle = approvalTitleElement;
const approvalBody = approvalBodyElement;
const approvalConfirm = approvalConfirmElement;
const boundTabId = await resolveBoundTabId();
frame.dataset.tabId = String(boundTabId);
let boundOrigin = '';
let boundOriginPattern = '';
let sandboxReady = false;
let pendingAuthorizedRead = false;

let port: chrome.runtime.Port;
let reconnectTimer: number | undefined;
const opfs = new OpfsStore();

function connect(): void {
  port = chrome.runtime.connect({ name: sidePanelPortName(boundTabId) });
  port.onMessage.addListener(message => {
    frame.contentWindow?.postMessage(message, '*');
  });
  port.onDisconnect.addListener(() => {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, 250);
  });
}

window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow) return;
  const shellMessage = event.data as { channel?: unknown; type?: unknown } | null;
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
    const envelope = parseBrokerEnvelope(event.data);
    if (isFsRequest(envelope.payload)) {
      void opfs.handle(envelope.payload).then(
        value => frame.contentWindow?.postMessage({ channel: 'harness-broker-v1', requestId: envelope.requestId, ok: true, value } satisfies BrokerResponse, '*'),
        error => frame.contentWindow?.postMessage({ channel: 'harness-broker-v1', requestId: envelope.requestId, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies BrokerResponse, '*'),
      );
      return;
    }
    void forwardEnvelope(envelope).catch(error => replyBrokerError(envelope.requestId, error));
  } catch (error) {
    const candidate = event.data as { requestId?: unknown } | null;
    replyBrokerError(typeof candidate?.requestId === 'string' ? candidate.requestId : 'invalid-request', error);
  }
});

connect();
void refreshSiteAccess();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === boundTabId && changeInfo.url) void refreshSiteAccess();
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

async function resolveBoundTabId(): Promise<number> {
  const fromPath = parseSidePanelTabId(location.href);
  if (fromPath != null) return fromPath;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null || !isInspectableUrl(tab.url)) {
    throw new Error('Harness side panel is not bound to an inspectable tab.');
  }
  return tab.id;
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

function isFsRequest(request: BrokerRequest): request is Extract<BrokerRequest, { kind: `fs/${string}` }> {
  return request.kind.startsWith('fs/');
}

function replyBrokerError(requestId: string, error: unknown): void {
  frame.contentWindow?.postMessage({
    channel: 'harness-broker-v1',
    requestId,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  } satisfies BrokerResponse, '*');
}

async function forwardEnvelope(envelope: BrokerEnvelope): Promise<void> {
  const approval = approvalForRequest(envelope.payload);
  if (approval && !await requestApproval(approval)) {
    frame.contentWindow?.postMessage({
      channel: 'harness-broker-v1',
      requestId: envelope.requestId,
      ok: false,
      error: 'User declined the trusted-shell approval prompt.',
    } satisfies BrokerResponse, '*');
    return;
  }
  port.postMessage(envelope);
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
  approvalDialog.classList.toggle('danger', request.danger === true);
  approvalDialog.returnValue = '';
  approvalDialog.showModal();
  return new Promise(resolve => {
    approvalDialog.addEventListener('close', () => resolve(approvalDialog.returnValue === 'confirm'), { once: true });
  });
}
