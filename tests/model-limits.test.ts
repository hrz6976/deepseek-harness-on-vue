import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelLimitsFor } from '@/shared/model-limits';

test('DeepSeek V4 models share the official 1M context profile', () => {
  const expected = {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    requestOutputTokens: 128_000,
  };
  assert.deepEqual(modelLimitsFor('deepseek-v4-flash'), expected);
  assert.deepEqual(modelLimitsFor('deepseek-v4-pro'), expected);
});

test('OpenCode Go context and output windows follow the selected model catalog entry', () => {
  assert.deepEqual(modelLimitsFor('glm-5.1', {}, 'opencode-go'), {
    contextWindow: 202_752,
    maxOutputTokens: 32_768,
    requestOutputTokens: 32_768,
  });
  assert.deepEqual(modelLimitsFor('kimi-k2.6', {}, 'opencode-go'), {
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    requestOutputTokens: 65_536,
  });
});

test('unknown model limits stay conservative and explicit overrides are clamped', () => {
  assert.deepEqual(modelLimitsFor('custom-model'), {
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    requestOutputTokens: 8_192,
  });
  assert.deepEqual(modelLimitsFor('custom-model', {
    contextWindow: 64_000,
    maxOutputTokens: 100_000,
    requestOutputTokens: 80_000,
  }), {
    contextWindow: 64_000,
    maxOutputTokens: 64_000,
    requestOutputTokens: 64_000,
  });
});
