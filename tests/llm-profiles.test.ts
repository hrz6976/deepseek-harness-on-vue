import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import {
  createLlmProfilePreset,
  normalizeLlmProfiles,
  resolveLlmProfile,
  summarizeLlmProfiles,
  readLlmProfiles,
  saveLlmProfiles,
  LLM_PROFILES_KEY,
} from '@/extension/llm-profiles';
import modelProfilesPlugin from '@/extension/model-profiles';
import { createBrokerPlugin } from '@/kernel/broker';
import { createSystemPlugin, runtime } from '@/kernel/cordis';
import type { ModelProfilesService, UiContribution } from '@/shared/runtime';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';

afterEach(async () => { await cleanupTestRuntime(); });

test('trusted profile persistence keeps drafts on denial or write failure and is shared with model reads', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome'); });
  const values: Record<string, unknown> = {};
  let approved = false;
  let permissionRequests = 0;
  let failWrite = false;
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    permissions: { async request() { permissionRequests++; return approved; } },
    storage: { local: {
      async get() { return values; },
      async set(next: Record<string, unknown>) { if (failWrite) throw new Error('disk full'); Object.assign(values, next); },
    } },
  } });
  const config = { version: 1 as const, defaultProfileId: 'deepseek', profiles: [createLlmProfilePreset('deepseek')] };
  const drafts = { deepseek: 'test-key' };
  for (const profiles of [[], [config.profiles[0], config.profiles[0]], [{ ...config.profiles[0], baseURL: 'ftp://example.test' }]]) {
    await assert.rejects(saveLlmProfiles({ ...config, profiles }, drafts), /Provider 配置/);
  }
  assert.equal(permissionRequests, 0);
  await assert.rejects(saveLlmProfiles(config, drafts), /网络权限/);
  assert.equal(values[LLM_PROFILES_KEY], undefined);
  approved = true;
  failWrite = true;
  await assert.rejects(saveLlmProfiles(config, drafts), /disk full/);
  assert.equal(drafts.deepseek, 'test-key');
  assert.equal(config.profiles[0]!.apiKey, '');
  failWrite = false;
  const saved = await saveLlmProfiles(config, drafts);
  assert.equal(saved.profiles[0]!.apiKey, 'test-key');
  assert.deepEqual(await readLlmProfiles(), saved);
});

test('OpenCode Go preset targets its OpenAI-compatible chat endpoint', () => {
  assert.deepEqual(createLlmProfilePreset('opencode-go'), {
    id: 'opencode-go',
    name: 'OpenCode Go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKey: '',
    defaultModel: 'deepseek-v4-flash',
  });
});

test('legacy single-provider settings migrate without exposing credentials in summaries', () => {
  const config = normalizeLlmProfiles(undefined, {
    baseURL: 'https://api.example.test/v1/',
    model: 'example-model',
    apiKey: 'secret-key',
  });
  assert.ok(config);
  assert.equal(resolveLlmProfile(config, '')?.apiKey, 'secret-key');
  assert.deepEqual(summarizeLlmProfiles(config), [{
    id: 'default', name: 'Default', defaultModel: 'example-model',
  }]);
  assert.doesNotMatch(JSON.stringify(summarizeLlmProfiles(config)), /secret-key/);
});

test('profile resolution uses the configured default but never hides an explicit missing profile', () => {
  const config = normalizeLlmProfiles({
    version: 1,
    defaultProfileId: 'deepseek',
    profiles: [
      createLlmProfilePreset('deepseek'),
      createLlmProfilePreset('opencode-go'),
    ],
  });
  assert.ok(config);
  assert.equal(resolveLlmProfile(config, '')?.id, 'deepseek');
  assert.equal(resolveLlmProfile(config, 'opencode-go')?.id, 'opencode-go');
  assert.equal(resolveLlmProfile(config, 'removed-profile'), null);
});

test('Cordis model profile system service owns the sanitized reactive catalog', async () => {
  let contribution: UiContribution | undefined;
  let caller = '';
  let modelProfilesContext: Context | null = null;
  await applyTestPlugin(createSystemPlugin('broker', createBrokerPlugin({
    async request(principal, request) {
      caller = principal.id;
      if (request.provider === 'llm' && request.action === 'models') {
        assert.equal(request.input.profileId, 'opencode-go');
        return ['deepseek-v4-flash', 'kimi-k2.5'];
      }
      return {
        configured: true,
        defaultProfileId: 'opencode-go',
        profiles: [{ id: 'opencode-go', name: 'OpenCode Go', defaultModel: 'deepseek-v4-flash' }],
      };
    },
    async *stream() { },
  })));
  await provideTestService('ui', {
    register(definition: UiContribution) { contribution = definition; return async () => { }; },
    listState: () => [],
    readState: () => null,
  });
  await applyTestPlugin(createSystemPlugin('model-profiles', modelProfilesPlugin, context => { modelProfilesContext = context; }));
  const service = runtime.reflect.get('modelProfiles') as ModelProfilesService;

  assert.equal(service.effectiveId(''), 'opencode-go');
  assert.deepEqual(service.resolve(), {
    id: 'opencode-go', name: 'OpenCode Go', defaultModel: 'deepseek-v4-flash',
  });
  assert.equal(service.resolve('missing'), null);
  assert.ok(modelProfilesContext);
  assert.deepEqual(await modelProfilesContext.modelProfiles.models(), ['deepseek-v4-flash', 'kimi-k2.5']);
  assert.equal(contribution?.region, 'composer-controls');
  assert.equal(caller, 'kernel:model-profiles');
});
