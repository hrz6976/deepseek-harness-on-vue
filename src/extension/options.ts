import { computed, createApp, reactive, ref } from 'vue';
import { render } from './options-app.html?vue-template';
import {
  LEGACY_LLM_CONFIG_KEY,
  LLM_PROFILES_KEY,
  createLlmProfilePreset,
  normalizeLlmProfiles,
  type LlmProfilePreset,
  type StoredLlmProfiles,
} from './llm-profiles';

const config = reactive<StoredLlmProfiles>({
  version: 1,
  defaultProfileId: 'deepseek',
  profiles: [createLlmProfilePreset('deepseek')],
});
const selectedId = ref(config.defaultProfileId);
const draftKeys = reactive<Record<string, string>>({});
const saving = ref(false);
const status = ref('');
const statusState = ref<'success' | 'error' | undefined>();
const selectedProfile = computed(() => config.profiles.find(profile => profile.id === selectedId.value) ?? null);

void restore();

async function restore(): Promise<void> {
  const values = await chrome.storage.local.get([LLM_PROFILES_KEY, LEGACY_LLM_CONFIG_KEY]);
  const stored = normalizeLlmProfiles(values[LLM_PROFILES_KEY], values[LEGACY_LLM_CONFIG_KEY]);
  if (stored) Object.assign(config, stored);
  selectedId.value = config.defaultProfileId;
}

function selectProfile(id: string): void {
  if (config.profiles.some(profile => profile.id === id)) selectedId.value = id;
}

function add(kind: LlmProfilePreset | 'custom'): void {
  const profile = kind === 'custom'
    ? { id: nextId(), name: 'Custom provider', baseURL: '', apiKey: '', defaultModel: '' }
    : createLlmProfilePreset(kind);
  const existing = config.profiles.find(candidate => candidate.id === profile.id);
  if (!existing) config.profiles.push(profile);
  selectedId.value = existing?.id ?? profile.id;
}

function remove(): void {
  if (config.profiles.length === 1) return;
  const index = config.profiles.findIndex(profile => profile.id === selectedId.value);
  const [removed] = config.profiles.splice(index, 1);
  delete draftKeys[removed!.id];
  if (config.defaultProfileId === removed!.id) config.defaultProfileId = config.profiles[0]!.id;
  selectedId.value = config.profiles[Math.min(index, config.profiles.length - 1)]!.id;
}

function makeDefault(): void {
  config.defaultProfileId = selectedId.value;
}

async function save(): Promise<void> {
  saving.value = true;
  status.value = '';
  statusState.value = undefined;
  try {
    const profiles = config.profiles.map(profile => {
      const endpoint = new URL(profile.baseURL);
      if (!/^https?:$/u.test(endpoint.protocol) || !profile.name.trim() || !profile.defaultModel.trim()) {
        throw new Error(`Profile “${profile.name || profile.id}” 配置不完整。`);
      }
      return {
        ...profile,
        name: profile.name.trim(),
        baseURL: endpoint.href.replace(/\/+$/u, ''),
        apiKey: draftKeys[profile.id] || profile.apiKey,
        defaultModel: profile.defaultModel.trim(),
      };
    });
    const origins = [...new Set(profiles.map(profile => `${new URL(profile.baseURL).origin}/*`))];
    if (!await chrome.permissions.request({ origins })) throw new Error('未获得全部 Provider endpoint 的网络权限。');
    const stored = normalizeLlmProfiles({ ...config, profiles })!;
    for (const id of Object.keys(draftKeys)) delete draftKeys[id];
    await chrome.storage.local.set({ [LLM_PROFILES_KEY]: stored });
    Object.assign(config, stored);
    status.value = '已保存；下次模型请求生效';
    statusState.value = 'success';
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
    statusState.value = 'error';
  } finally {
    saving.value = false;
  }
}

function nextId(): string {
  let index = 1;
  while (config.profiles.some(profile => profile.id === `profile-${index}`)) index++;
  return `profile-${index}`;
}

createApp({
  render,
  setup: () => ({
    add, config, draftKeys, makeDefault, remove, save, saving,
    selectedId, selectedProfile, selectProfile, status, statusState,
  }),
}).mount('#app');
