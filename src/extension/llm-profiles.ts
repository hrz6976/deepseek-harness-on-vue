import type { LlmProfileSummary } from '@/shared/task-model';

export const LLM_PROFILES_KEY = 'secrets.llmProfiles';
export const LEGACY_LLM_CONFIG_KEY = 'secrets.llm';

export interface StoredLlmProfile {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
}

export interface StoredLlmProfiles {
  version: 1;
  defaultProfileId: string;
  profiles: StoredLlmProfile[];
}

export type LlmProfilePreset = 'deepseek' | 'opencode-go';

const PROFILE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const PRESETS: Record<LlmProfilePreset, StoredLlmProfile> = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiKey: '',
    defaultModel: 'deepseek-v4-flash',
  },
  'opencode-go': {
    id: 'opencode-go',
    name: 'OpenCode Go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKey: '',
    defaultModel: 'deepseek-v4-flash',
  },
};

export function createLlmProfilePreset(preset: LlmProfilePreset): StoredLlmProfile {
  return { ...PRESETS[preset] };
}

export function normalizeLlmProfiles(value: unknown, legacy?: unknown): StoredLlmProfiles | null {
  const source = asRecord(value);
  const candidates = Array.isArray(source?.profiles) ? source.profiles : [];
  const profiles: StoredLlmProfile[] = [];
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const profile = normalizeProfile(candidate);
    if (!profile || ids.has(profile.id)) continue;
    ids.add(profile.id);
    profiles.push(profile);
  }

  if (!profiles.length) {
    const migrated = normalizeLegacyProfile(legacy);
    if (!migrated) return null;
    profiles.push(migrated);
  }

  const requestedDefault = typeof source?.defaultProfileId === 'string'
    ? source.defaultProfileId.trim() : '';
  return {
    version: 1,
    defaultProfileId: profiles.some(profile => profile.id === requestedDefault)
      ? requestedDefault : profiles[0]!.id,
    profiles,
  };
}

export function resolveLlmProfile(
  config: StoredLlmProfiles,
  requestedProfileId: string,
): StoredLlmProfile | null {
  const id = requestedProfileId.trim() || config.defaultProfileId;
  return config.profiles.find(profile => profile.id === id) ?? null;
}

export function summarizeLlmProfiles(config: StoredLlmProfiles): LlmProfileSummary[] {
  return config.profiles.map(({ id, name, defaultModel }) => ({ id, name, defaultModel }));
}

function normalizeProfile(value: unknown): StoredLlmProfile | null {
  const source = asRecord(value);
  if (!source) return null;
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  const baseURL = normalizeBaseURL(source.baseURL);
  const defaultModel = typeof source.defaultModel === 'string' ? source.defaultModel.trim() : '';
  if (!PROFILE_ID.test(id) || !name || !baseURL || !defaultModel) return null;
  return {
    id,
    name,
    baseURL,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
    defaultModel,
  };
}

function normalizeLegacyProfile(value: unknown): StoredLlmProfile | null {
  const source = asRecord(value);
  const baseURL = normalizeBaseURL(source?.baseURL);
  if (!source || !baseURL || typeof source.apiKey !== 'string' || !source.apiKey.trim()) return null;
  return {
    id: 'default',
    name: 'Default',
    baseURL,
    apiKey: source.apiKey.trim(),
    defaultModel: typeof source.model === 'string' && source.model.trim()
      ? source.model.trim() : 'deepseek-v4-flash',
  };
}

function normalizeBaseURL(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href.replace(/\/+$/u, '');
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Trusted host storage; call permission requests directly from the user's save action. */
export async function readLlmProfiles(): Promise<StoredLlmProfiles | null> {
  const values = await chrome.storage.local.get([LLM_PROFILES_KEY, LEGACY_LLM_CONFIG_KEY]);
  return normalizeLlmProfiles(values[LLM_PROFILES_KEY], values[LEGACY_LLM_CONFIG_KEY]);
}

export async function saveLlmProfiles(config: StoredLlmProfiles, draftKeys: Record<string, string>): Promise<StoredLlmProfiles> {
  const stored = normalizeLlmProfiles({
    ...config,
    profiles: config.profiles.map(profile => ({ ...profile, apiKey: draftKeys[profile.id] || profile.apiKey })),
  });
  if (!stored || stored.profiles.length !== config.profiles.length) throw new Error('Provider 配置不完整，或包含无效、重复的 ID。');
  const origins = [...new Set(stored.profiles.map(profile => `${new URL(profile.baseURL).origin}/*`))];
  if (!await chrome.permissions.request({ origins })) throw new Error('未获得全部 Provider endpoint 的网络权限。');
  await chrome.storage.local.set({ [LLM_PROFILES_KEY]: stored });
  return stored;
}
