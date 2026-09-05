import { computed, createApp, reactive, ref } from 'vue';
import { render } from './options-app.html?vue-template';
import {
  readLlmProfiles,
  saveLlmProfiles,
  createLlmProfilePreset,
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
  const stored = await readLlmProfiles();
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
    const stored = await saveLlmProfiles(config, draftKeys);
    for (const id of Object.keys(draftKeys)) delete draftKeys[id];
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
