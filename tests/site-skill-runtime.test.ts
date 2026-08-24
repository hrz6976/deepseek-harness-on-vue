import assert from 'node:assert/strict';
import test from 'node:test';
import { createSiteSkillRuntime } from '@/extension/site-skill-runtime';
import type { PageCommand, SiteRecipe, SiteUserScript } from '@/shared/page-protocol';

function installChromeMock(skills: Array<SiteRecipe | SiteUserScript>) {
  const registered: chrome.userScripts.RegisteredUserScript[] = [];
  let storedSkills = [...skills];
  const chromeMock = {
    storage: {
      local: {
        async get() { return { 'public.recipes': storedSkills }; },
        async set(values: Record<string, unknown>) {
          const next = values['public.recipes'];
          if (Array.isArray(next)) storedSkills = next as Array<SiteRecipe | SiteUserScript>;
        },
      },
    },
    permissions: {
      async contains() { return true; },
    },
    userScripts: {
      async configureWorld() {},
      async getScripts(filter?: chrome.userScripts.UserScriptFilter) {
        return filter?.ids ? registered.filter(script => filter.ids!.includes(script.id)) : [...registered];
      },
      async register(scripts: chrome.userScripts.RegisteredUserScript[]) { registered.push(...scripts); },
      async update(scripts: chrome.userScripts.RegisteredUserScript[]) {
        for (const script of scripts) {
          const index = registered.findIndex(candidate => candidate.id === script.id);
          if (index >= 0) registered[index] = { ...registered[index], ...script };
        }
      },
      async unregister(filter?: chrome.userScripts.UserScriptFilter) {
        const ids = new Set(filter?.ids ?? registered.map(script => script.id));
        for (let index = registered.length - 1; index >= 0; index--) {
          if (ids.has(registered[index]!.id)) registered.splice(index, 1);
        }
      },
    },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: chromeMock });
  return registered;
}

test('saved userscripts restore in the background without a side panel', async t => {
  t.after(() => { Reflect.deleteProperty(globalThis, 'chrome'); });
  const script: SiteUserScript = {
    id: 'calendar', name: 'Calendar grouping', type: 'userscript', enabled: true,
    matches: ['https://example.test/*'], runAt: 'document_idle', source: 'document.body.dataset.ready = "1"',
    createdAt: 1, updatedAt: 1,
  };
  const registered = installChromeMock([script]);
  const runtime = createSiteSkillRuntime(async () => null, () => undefined);

  await runtime.restoreUserScripts();

  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.id, 'harness:calendar');
  assert.deepEqual(registered[0]?.matches, script.matches);
  assert.match(registered[0]?.js?.[0]?.code ?? '', /document\.body\.dataset\.ready/);
});

test('saving a userscript updates its registration before the same call returns', async t => {
  t.after(() => { Reflect.deleteProperty(globalThis, 'chrome'); });
  const original: SiteUserScript = {
    id: 'hover-card', name: 'Hover card', type: 'userscript', enabled: true,
    matches: ['https://example.test/*'], runAt: 'document_start', source: 'globalThis.revision = "old"',
    createdAt: 1, updatedAt: 1,
  };
  const registered = installChromeMock([original]);
  const runtime = createSiteSkillRuntime(async () => null, () => undefined);
  await runtime.restoreUserScripts();

  await runtime.request({
    provider: 'site-skill', action: 'save', input: {
      skill: { ...original, source: 'globalThis.revision = "new"', updatedAt: 2 },
    },
  }, 42);

  assert.equal(registered.length, 1);
  assert.match(registered[0]?.js?.[0]?.code ?? '', /revision = "new"/);
  assert.doesNotMatch(registered[0]?.js?.[0]?.code ?? '', /revision = "old"/);
});

test('saved declarative skills apply on matching background navigation without a side panel', async t => {
  t.after(() => { Reflect.deleteProperty(globalThis, 'chrome'); });
  const recipe: SiteRecipe = {
    id: 'compact', name: 'Compact page', type: 'recipe', enabled: true,
    matches: ['https://example.test/*'], world: 'ISOLATED',
    operations: [{ type: 'set-attribute', target: { selector: 'main', nodeRef: 'recipe_compact_0' }, name: 'data-compact', value: 'true' }],
    createdAt: 1, updatedAt: 1,
  };
  installChromeMock([recipe]);
  const commands: PageCommand[] = [];
  const runtime = createSiteSkillRuntime(async command => { commands.push(command); return null; }, () => undefined);

  await runtime.applyMatching(42, 'https://example.test/page');

  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.type, 'page/patch-apply');
});
