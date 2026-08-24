export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
  requestOutputTokens: number;
}

export type ModelLimitOverrides = Partial<ModelLimits>;

const DEEPSEEK_V4_LIMITS: Readonly<ModelLimits> = Object.freeze({
  contextWindow: 1_000_000,
  maxOutputTokens: 384_000,
  requestOutputTokens: 128_000,
});

const FALLBACK_LIMITS: Readonly<ModelLimits> = Object.freeze({
  contextWindow: 131_072,
  maxOutputTokens: 8_192,
  requestOutputTokens: 8_192,
});

const positiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value! > 0 ? Math.trunc(value!) : fallback;

export function modelLimitsFor(model: string, overrides: ModelLimitOverrides = {}): ModelLimits {
  const normalized = model.trim().toLowerCase();
  const defaults = normalized === 'deepseek-v4-flash' || normalized === 'deepseek-v4-pro'
    ? DEEPSEEK_V4_LIMITS : FALLBACK_LIMITS;
  const contextWindow = positiveInteger(overrides.contextWindow, defaults.contextWindow);
  const maxOutputTokens = Math.min(contextWindow,
    positiveInteger(overrides.maxOutputTokens, defaults.maxOutputTokens));
  const requestOutputTokens = Math.min(maxOutputTokens,
    positiveInteger(overrides.requestOutputTokens, defaults.requestOutputTokens));
  return { contextWindow, maxOutputTokens, requestOutputTokens };
}
