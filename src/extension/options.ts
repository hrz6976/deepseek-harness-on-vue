interface StoredLlmConfig {
  baseURL: string;
  model: string;
  apiKey?: string;
  localProxy?: boolean;
}

const CONFIG_KEY = 'secrets.llm';
const form = requiredElement<HTMLFormElement>('settings');
const baseUrlInput = requiredElement<HTMLInputElement>('base-url');
const modelInput = requiredElement<HTMLInputElement>('model');
const apiKeyInput = requiredElement<HTMLInputElement>('api-key');
const localProxyInput = requiredElement<HTMLInputElement>('local-proxy');
const statusElement = requiredElement<HTMLElement>('status');
const submitButton = requiredElement<HTMLButtonElement>('submit');

void restore();

form.addEventListener('submit', event => {
  event.preventDefault();
  void save();
});

localProxyInput.addEventListener('change', () => {
  if (localProxyInput.checked && !isLocalProxyUrl(baseUrlInput.value)) {
    baseUrlInput.value = 'http://localhost:7100/proxy';
  }
  syncAuthMode();
});

async function restore(): Promise<void> {
  const stored = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as StoredLlmConfig | undefined;
  if (!stored) return;
  baseUrlInput.value = stored.baseURL;
  modelInput.value = stored.model;
  localProxyInput.checked = stored.localProxy === true || stored.apiKey === 'pi-local';
  syncAuthMode();
}

async function save(): Promise<void> {
  setStatus('正在保存…', 'progress');
  submitButton.disabled = true;
  try {
    const endpoint = new URL(baseUrlInput.value);
    if (localProxyInput.checked && !isLocalProxyUrl(endpoint.href)) {
      throw new Error('本地 proxy 必须使用 localhost、127.0.0.1 或 ::1 地址。');
    }
    const baseURL = endpoint.href.replace(/\/$/u, '');
    const pattern = `${endpoint.origin}/*`;
    // Keep this as the first async browser API in the submit gesture so a new
    // endpoint can reliably display Chrome's optional-host prompt.
    const allowed = await chrome.permissions.request({ origins: [pattern] });
    if (!allowed) throw new Error('未获得该 API origin 的网络权限。');
    const previous = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as StoredLlmConfig | undefined;
    const apiKey = apiKeyInput.value || previous?.apiKey;
    if (!localProxyInput.checked && !apiKey) throw new Error('请输入 API key，或勾选“使用本地 proxy”。');
    const config: StoredLlmConfig = {
      baseURL,
      model: modelInput.value.trim(),
      ...(apiKey ? { apiKey } : {}),
      ...(localProxyInput.checked ? { localProxy: true } : {}),
    };
    await chrome.storage.local.set({ [CONFIG_KEY]: config });
    apiKeyInput.value = '';
    syncAuthMode();
    setStatus('设置已保存', 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    submitButton.disabled = false;
  }
}

function isLocalProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function syncAuthMode(): void {
  apiKeyInput.disabled = localProxyInput.checked;
  apiKeyInput.placeholder = localProxyInput.checked ? '本地 proxy 模式不需要 key' : '已有 key；留空则保留';
}

function setStatus(message: string, state: 'progress' | 'success' | 'error'): void {
  statusElement.textContent = message;
  statusElement.dataset.state = state;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
