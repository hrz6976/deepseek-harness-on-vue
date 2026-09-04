import type { Model } from '@earendil-works/pi-ai';
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { OPENCODE_GO_MODELS } from '@earendil-works/pi-ai/providers/opencode-go.models';

export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
  requestOutputTokens: number;
}

export type ModelLimitOverrides = Partial<ModelLimits>;

const FALLBACK_LIMITS: Readonly<ModelLimits> = Object.freeze({
  contextWindow: 131_072,
  maxOutputTokens: 8_192,
  requestOutputTokens: 8_192,
});

const positiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value! > 0 ? Math.trunc(value!) : fallback;

const catalogs = {
  deepseek: DEEPSEEK_MODELS,
  'opencode-go': OPENCODE_GO_MODELS,
} as const;

function catalogModel(profileId: string, modelId: string): Model<string> | undefined {
  const selected = catalogs[profileId as keyof typeof catalogs];
  if (selected && modelId in selected) return selected[modelId as keyof typeof selected] as Model<string>;
  for (const catalog of Object.values(catalogs)) {
    if (modelId in catalog) return catalog[modelId as keyof typeof catalog] as Model<string>;
  }
  return undefined;
}

export function modelLimitsFor(model: string, overrides: ModelLimitOverrides = {}, profileId = ''): ModelLimits {
  const normalized = model.trim().toLowerCase();
  const known = catalogModel(profileId.trim().toLowerCase(), normalized);
  const defaults = known ? {
    contextWindow: known.contextWindow,
    maxOutputTokens: known.maxTokens,
    requestOutputTokens: Math.min(known.maxTokens, 128_000),
  } : FALLBACK_LIMITS;
  const contextWindow = positiveInteger(overrides.contextWindow, defaults.contextWindow);
  const maxOutputTokens = Math.min(contextWindow,
    positiveInteger(overrides.maxOutputTokens, defaults.maxOutputTokens));
  const requestOutputTokens = Math.min(maxOutputTokens,
    positiveInteger(overrides.requestOutputTokens, defaults.requestOutputTokens));
  return { contextWindow, maxOutputTokens, requestOutputTokens };
}
