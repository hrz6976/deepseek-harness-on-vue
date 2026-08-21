interface StoredLlmConfig {
  baseURL: string;
  model: string;
  apiKey: string;
}

const CONFIG_KEY = 'secrets.llm';
const form = requiredElement<HTMLFormElement>('settings');
const baseUrlInput = requiredElement<HTMLInputElement>('base-url');
const modelInput = requiredElement<HTMLInputElement>('model');
const apiKeyInput = requiredElement<HTMLInputElement>('api-key');
const statusElement = requiredElement<HTMLElement>('status');
const submitButton = requiredElement<HTMLButtonElement>('submit');

void restore();

form.addEventListener('submit', event => {
  event.preventDefault();
  void save();
});

async function restore(): Promise<void> {
  const stored = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as StoredLlmConfig | undefined;
  if (!stored) return;
  baseUrlInput.value = stored.baseURL;
  modelInput.value = stored.model;
  apiKeyInput.placeholder = '已有 key；留空则保留';
}

async function save(): Promise<void> {
  setStatus('正在保存…', 'progress');
  submitButton.disabled = true;
  try {
    const endpoint = new URL(baseUrlInput.value);
    const baseURL = endpoint.href.replace(/\/$/u, '');
    const pattern = `${endpoint.origin}/*`;
    // Keep this as the first async browser API in the submit gesture so a new
    // endpoint can reliably display Chrome's optional-host prompt.
    const allowed = await chrome.permissions.request({ origins: [pattern] });
    if (!allowed) throw new Error('未获得该 API origin 的网络权限。');
    const previous = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as StoredLlmConfig | undefined;
    const apiKey = apiKeyInput.value || previous?.apiKey;
    if (!apiKey) throw new Error('请输入 API key。');
    const config: StoredLlmConfig = { baseURL, model: modelInput.value.trim(), apiKey };
    await chrome.storage.local.set({ [CONFIG_KEY]: config });
    apiKeyInput.value = '';
    apiKeyInput.placeholder = '已有 key；留空则保留';
    setStatus('设置已保存', 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    submitButton.disabled = false;
  }
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
