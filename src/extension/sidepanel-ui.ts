import { createApp, reactive, ref, toRefs } from 'vue';
import type { ApprovalRequest } from './approval-policy';
import { render } from './sidepanel-app.html?vue-template';

interface SiteAccessRequest {
  label: string;
  originPattern: string;
  onGranted(): void;
}

export function mountSidePanelUi() {
  const sandboxFrame = ref<HTMLIFrameElement | null>(null);
  const approvalDialog = ref<HTMLDialogElement | null>(null);
  const state = reactive({
    tabId: 0,
    host: '',
    sandboxReady: false,
    statusTitle: 'Harness 正在启动',
    statusDetail: '正在加载隔离运行时…',
    statusFailed: false,
    siteAccessVisible: false,
    siteAccessLabel: '',
    siteAccessBusy: false,
    approvalRequest: null as ApprovalRequest | null,
    approvalError: '',
    approvalBusy: false,
  });
  let siteAccessRequest: SiteAccessRequest | null = null;
  let approvalResolve: ((approved: boolean, error?: Error) => void) | null = null;
  let approvalQueue = Promise.resolve();

  function authorizeSite(): void {
    const request = siteAccessRequest;
    if (!request) return;
    state.siteAccessBusy = true;
    // Keep the permission request directly inside the trusted click handler.
    void chrome.permissions.request({ origins: [request.originPattern] }).then(
      granted => {
        state.siteAccessBusy = false;
        if (!granted) return;
        state.siteAccessVisible = false;
        request.onGranted();
      },
      error => {
        state.siteAccessBusy = false;
        state.siteAccessLabel = error instanceof Error ? error.message : String(error);
      },
    );
  }

  function confirmApproval(): void {
    const current = approvalResolve;
    const origins = state.approvalRequest?.origins;
    if (!origins) return dialog.close('confirm');
    state.approvalBusy = true;
    void chrome.permissions.request({ origins: [...origins] }).then(
      granted => { if (approvalResolve === current) dialog.close(granted ? 'confirm' : 'cancel'); },
      error => {
        if (approvalResolve !== current) return;
        const reason = error instanceof Error ? error : new Error(String(error));
        state.approvalError = reason.message;
        state.approvalBusy = false;
        const resolve = approvalResolve;
        approvalResolve = null;
        dialog.close('error');
        resolve?.(false, reason);
      },
    );
  }

  function finishApproval(): void {
    const resolve = approvalResolve;
    approvalResolve = null;
    state.approvalRequest = null;
    state.approvalBusy = false;
    resolve?.(dialog.returnValue === 'confirm');
  }

  createApp({
    render,
    setup: () => ({
      ...toRefs(state), approvalDialog, sandboxFrame, authorizeSite, confirmApproval, finishApproval,
      cancelApproval: () => dialog.close('cancel'),
    }),
  }).mount('#app');

  const frame = sandboxFrame.value!;
  const dialog = approvalDialog.value!;

  function showApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    state.approvalRequest = request;
    state.approvalError = '';
    state.approvalBusy = false;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise((resolve, reject) => {
      const cancel = () => { dialog.close('cancel'); };
      signal?.addEventListener('abort', cancel, { once: true });
      approvalResolve = (approved, error) => { signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(approved); };
    });
  }

  return {
    frame,
    setBinding(tabId: number, host: string) { state.tabId = tabId; state.host = host; },
    setReady() { state.sandboxReady = true; },
    setFailure(title: string, detail: string, disableSandbox = false) {
      state.statusTitle = title;
      state.statusDetail = detail;
      state.statusFailed = true;
      state.sandboxReady = false;
      if (disableSandbox) frame.src = 'about:blank';
    },
    setSiteAccess(request: SiteAccessRequest | null) {
      siteAccessRequest = request;
      state.siteAccessVisible = !!request;
      if (request) state.siteAccessLabel = request.label;
    },
    requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
      const result = approvalQueue.then(() => showApproval(request, signal));
      approvalQueue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
