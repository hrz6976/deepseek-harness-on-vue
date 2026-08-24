import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import { ref } from 'vue';
import { z } from 'zod';
import { createSystemPlugin, runtime } from '@/kernel/cordis';
import { principalForContext } from '@/kernel/broker';
import { mountPlugin, unmountPlugin } from '@/kernel/host';
import { capabilities } from '@/kernel/capabilities';
import { UiService, uiKernelPlugin } from '@/kernel/ui';
import { promptPlugin } from '@/plugins/prompt';
import { toolsPlugin, type ToolsRuntime } from '@/plugins/tools';
import * as pagePlugin from '@/plugins/tools/page';
import * as capabilityCatalogPlugin from '@/plugins/tools/capability-catalog';
import filesPlugin from '@/plugins/ui/files';
import type { PromptRuntime } from '@/plugins/prompt';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';

afterEach(async () => { await cleanupTestRuntime(); });

test('system Context is available after its Cordis mount handle settles', async () => {
  const isolated = new Context();
  let context: Context | null = null;
  const handle = isolated.plugin(createSystemPlugin('shell-test', {
    name: 'shell-test',
    apply() {},
  }, value => { context = value; }));

  await handle;
  assert.ok(context);
  await handle.dispose();
});

test('the system loop principal may call the trusted LLM provider', async () => {
  let context: Context | null = null;
  const handle = runtime.plugin(createSystemPlugin('loop', {
    name: 'loop-principal-test', apply() {},
  }, value => { context = value; }));
  try {
    await handle;
    assert.ok(context);
    assert.deepEqual(principalForContext(context), {
      kind: 'system',
      id: 'kernel:loop',
      fiberId: `system:${context.fiber.uid}`,
      scope: 'global',
      providers: ['llm'],
      permissions: ['llm.use'],
    });
  } finally {
    await handle.dispose();
  }
});

test('Page explicitly contributes tools and prompt through its Cordis Fiber', async () => {
  await applyTestPlugin(toolsPlugin);
  await applyTestPlugin(promptPlugin);
  const requests: unknown[] = [];
  await provideTestService('broker', {
    async request(request: unknown) { requests.push(request); return { ok: true }; },
    async *stream() {},
  });

  const entry = await mountPlugin('page', pagePlugin, { builtin: true });
  await entry.fiber?.await();
  const tools = runtime.reflect.get('tools') as ToolsRuntime;
  const prompt = runtime.reflect.get('prompt') as PromptRuntime;
  const names = tools.schemas().map(tool => tool.name);

  assert.equal(entry.status, 'active');
  assert.equal(names.length, 19, 'only dynamic observation and live-rule tools stay out of the prompt until loaded');
  assert.ok(names.includes('page_snapshot'));
  assert.ok(names.includes('page_style_inspect'));
  assert.ok(names.includes('page_script_run'));
  assert.ok(names.includes('page_recipe_save'));
  assert.ok(names.includes('page_recipe_get'));
  assert.ok(names.includes('page_recipe_debug'));
  assert.equal(names.includes('page_live_rules_apply'), false);
  const dynamic = tools.catalog().find(group => group.id === 'page.dynamic');
  assert.ok(dynamic?.tools.includes('page_observe_start'));
  assert.ok(dynamic?.tools.includes('page_live_rules_apply'));
  assert.equal(dynamic?.tools.includes('page_script_run'), false);
  assert.match(prompt.assemble(), /page_style_inspect/);
  await tools.call('page_query', { selector: 'main' });
  assert.equal((requests[0] as { provider: string }).provider, 'page');
  const saveResult = String(await tools.call('page_recipe_save', {
    type: 'userscript', name: 'Calendar grouping', matches: ['https://example.test/calendar*'],
    source: 'document.body.dataset.ready = "1"', runAt: 'document_idle', enabled: true,
  }));
  const saved = requests[1] as { provider: string; input: { skill: { type?: string; source?: string } } };
  assert.equal(saved.provider, 'site-skill');
  assert.equal(saved.input.skill.type, 'userscript');
  assert.match(saved.input.skill.source ?? '', /document\.body/);
  assert.deepEqual(requests[2], {
    provider: 'site-skill', action: 'apply', input: { id: (saved.input.skill as { id: string }).id },
  });
  assert.match(saveResult, /"hotAppliedToCurrentDocument":true/);
  assert.match(prompt.assemble(), /same agent run/);
  assert.match(prompt.assemble(), /share DOM but not JavaScript globals/);
  assert.match(prompt.assemble(), /missing from MAIN is expected/);
  assert.match(prompt.assemble(), /page_recipe_list, page_recipe_get, and page_recipe_debug as strictly read-only/);
  assert.match(prompt.assemble(), /never save, remove, disable, replace, stub, duplicate/);

  assert.equal(await unmountPlugin('page'), true);
  assert.deepEqual(tools.schemas(), []);
  assert.equal(prompt.assemble(), '');
  assert.equal(capabilities.has('page'), false);
});

test('page_recipe_get reads persisted userscript source in bounded chunks', async () => {
  await applyTestPlugin(toolsPlugin);
  await applyTestPlugin(promptPlugin);
  const source = '0123456789abcdefghijklmnopqrstuvwxyz';
  await provideTestService('broker', {
    async request(request: { provider: string; action: string }) {
      if (request.provider === 'site-skill' && request.action === 'list') {
        return [{
          id: 'nga-hover', name: 'NGA hover card', type: 'userscript', enabled: true,
          matches: ['https://bbs.nga.cn/*'], runAt: 'document_start', source,
          createdAt: 1, updatedAt: 1,
        }];
      }
      return null;
    },
    async *stream() {},
  });

  const entry = await mountPlugin('page', pagePlugin, { builtin: true });
  await entry.fiber?.await();
  const tools = runtime.reflect.get('tools') as ToolsRuntime;

  const first = String(await tools.call('page_recipe_get', { id: 'nga-hover', offset: 0, limit: 10 }));
  assert.match(first, /content: userscript source/);
  assert.match(first, /nextOffset: 10/);
  assert.match(first, /--- content ---\n0123456789$/);

  const second = String(await tools.call('page_recipe_get', { id: 'nga-hover', offset: 10, limit: 6_000 }));
  assert.match(second, /offset: 10/);
  assert.match(second, /nextOffset: none/);
  assert.match(second, /--- content ---\nabcdefghijklmnopqrstuvwxyz$/);

  const missing = String(await tools.call('page_recipe_get', { id: 'missing', offset: 0, limit: 6_000 }));
  assert.equal(missing, 'Error: page plugin "missing" does not exist');
});

test('page_recipe_debug reads Chrome registration evidence without mutating the recipe', async () => {
  await applyTestPlugin(toolsPlugin);
  await applyTestPlugin(promptPlugin);
  const requests: unknown[] = [];
  await provideTestService('broker', {
    async request(request: unknown) {
      requests.push(request);
      return { recipeId: 'nga-hover', registrationCount: 1, registrations: [{ matchesStoredSource: true }] };
    },
    async *stream() {},
  });

  const entry = await mountPlugin('page', pagePlugin, { builtin: true });
  await entry.fiber?.await();
  const tools = runtime.reflect.get('tools') as ToolsRuntime;
  const result = String(await tools.call('page_recipe_debug', { id: 'nga-hover' }));

  assert.deepEqual(requests, [{ provider: 'site-skill', action: 'inspect', input: { id: 'nga-hover' } }]);
  assert.match(result, /"matchesStoredSource": true/);
});

test('capability discovery prioritizes loadable groups and capability loading activates them', async () => {
  await applyTestPlugin(toolsPlugin);
  await applyTestPlugin(promptPlugin);
  const activeTaskId = ref<string | null>('task-1');
  await provideTestService('task', {
    activeTaskId,
    contexts: [],
    activeTask: () => ({ id: 'task-1', capabilityIds: [] }),
    async attachCapability() {},
    async detachCapability() {},
  });
  await provideTestService('manager', {
    list: () => ['advanced-capability'],
    catalog: () => [{
      id: 'advanced-capability', title: 'Advanced Capability',
      description: 'Test loadable tools.', scope: 'global', version: '0.1.0', status: 'active', attached: true,
      providers: [], permissions: [],
      contributes: { tools: ['advanced_tool'], panels: [], prompts: [], services: [], events: [], workflows: [] },
      health: 'healthy', issues: [],
      source: 'editable', editable: true, reloadBoundary: 'turn',
    }],
    async create() { return ''; }, async mount() { return ''; }, async unmount() { return ''; }, async remove() { return ''; },
  });
  await applyTestPlugin({
    name: 'advanced-capability', inject: ['tools'],
    apply(ctx) {
      ctx.tools.register({
        name: 'advanced_tool', description: 'Hidden until loaded.', parameters: z.object({}),
        availability: { id: 'advanced.group', title: 'Advanced Group', description: 'Test group.', scope: 'task' },
        run: () => 'ok',
      });
    },
  });
  await applyTestPlugin(capabilityCatalogPlugin);

  const tools = runtime.reflect.get('tools') as ToolsRuntime;
  const summary = JSON.parse(String(await tools.call('capability_search', {
    query: '', limit: 30,
  }))) as Array<{ kind: string }>;
  assert.equal(summary.some(record => record.kind === 'tool'), false);
  assert.equal(summary.some(record => record.kind === 'tool-group'), true);

  const search = JSON.parse(String(await tools.call('capability_search', {
    query: '', kinds: ['tool-group', 'tool'], limit: 2,
  }))) as Array<{ kind: string; id: string; loaded?: boolean; loadWith?: { kind: string; id: string } }>;
  assert.equal(search[0]?.kind, 'tool-group');
  assert.deepEqual(search[0]?.loadWith, { kind: 'tool-group', id: 'advanced.group' });
  assert.equal(search[1]?.loaded, false);
  assert.equal(tools.schemas().some(tool => tool.name === 'advanced_tool'), false);

  const loaded = JSON.parse(String(await tools.call('capability_load', { kind: 'capability', id: 'advanced-capability' }))) as { loadedToolGroups: string[] };
  assert.deepEqual(loaded.loadedToolGroups, ['advanced.group']);
  assert.equal(tools.schemas().some(tool => tool.name === 'advanced_tool'), true);
});

test('Cordis injection suspends, activates, unloads, and reactivates one Fiber', async () => {
  let activations = 0;
  let cleanups = 0;
  const fiber = runtime.plugin({
    name: 'late-consumer',
    inject: ['late-service'],
    apply(ctx) {
      activations++;
      assert.deepEqual(ctx.reflect.get('late-service'), { ready: true });
      ctx.effect(() => () => { cleanups++; }, 'late-consumer.resource');
    },
  }) as Fiber;

  assert.equal(fiber.state, 0);
  const firstProvider = await provideTestService('late-service', { ready: true });
  await fiber.await();
  assert.equal(fiber.state, 2);
  assert.equal(activations, 1);

  await firstProvider.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(fiber.state, 0);
  assert.equal(cleanups, 1);

  const secondProvider = await provideTestService('late-service', { ready: true });
  await fiber.await();
  assert.equal(activations, 2);
  await fiber.dispose();
  await secondProvider.dispose();
  assert.equal(cleanups, 2);
});

test('Vue panels are explicit UI contributions, not executable plugin templates', async () => {
  await applyTestPlugin(uiKernelPlugin);
  const ui = runtime.reflect.get('ui') as UiService;
  const fiber = await applyTestPlugin(filesPlugin);
  assert.equal(ui.contributions.has('files:files'), true);
  assert.equal(ui.contributions.get('files:files')?.component.name, 'FilesPanel');
  await fiber.dispose();
  assert.equal(ui.contributions.has('files:files'), false);
});
