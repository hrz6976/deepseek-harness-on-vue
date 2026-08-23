import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Fiber } from '@deepseek-ai/cordis';
import { ref } from 'vue';
import { z } from 'zod';
import { cordis, createHarnessRuntime, harnessRuntime } from '../src/kernel/cordis';
import { principalForContext } from '../src/kernel/broker';
import { mountPlugin, plugins, unmountPlugin } from '../src/kernel/host';
import { uiContributions } from '../src/kernel/ui';
import { promptPlugin } from '../src/plugins/prompt';
import { toolsPlugin, type ToolsRuntime } from '../src/plugins/tools';
import pagePlugin from '../src/plugins/tools/page';
import capabilityCatalogPlugin from '../src/plugins/tools/capability-catalog';
import { filesPlugin } from '../src/plugins/ui/files';
import type { PromptRuntime } from '../src/plugins/prompt';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';

afterEach(async () => { await cleanupTestRuntime(); });

test('system Context is available after its Cordis mount handle settles', async () => {
  const runtime = createHarnessRuntime();
  const handle = runtime.mountSystem('shell-test', {
    name: 'shell-test',
    apply() {},
  });

  await handle;
  assert.ok(runtime.systemContext('shell-test'));
  await runtime.dispose();
});

test('the system loop principal may call the trusted LLM provider', async () => {
  const handle = harnessRuntime.mountSystem('loop', { name: 'loop-principal-test', apply() {} });
  try {
    await handle;
    const context = harnessRuntime.systemContext('loop');
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
  const tools = cordis.reflect.get('tools') as ToolsRuntime;
  const prompt = cordis.reflect.get('prompt') as PromptRuntime;
  const names = tools.schemas().map(tool => tool.name);

  assert.equal(entry.status, 'active');
  assert.equal(names.length, 15, 'advanced groups stay out of the prompt until loaded');
  assert.ok(names.includes('page_snapshot'));
  assert.ok(names.includes('page_recipe_save'));
  assert.equal(names.includes('page_live_rules_apply'), false);
  const dynamic = tools.catalog().find(group => group.id === 'page.dynamic');
  assert.ok(dynamic?.tools.includes('page_observe_start'));
  assert.ok(dynamic?.tools.includes('page_live_rules_apply'));
  assert.ok(dynamic?.tools.includes('page_script_run'));
  assert.match(prompt.assemble(), /framework-neutral page_\* tools/);
  await tools.call('page_query', { selector: 'main' });
  assert.equal((requests[0] as { provider: string }).provider, 'page');
  await tools.call('page_recipe_save', {
    type: 'userscript', name: 'Calendar grouping', matches: ['https://example.test/calendar*'],
    source: 'document.body.dataset.ready = "1"', runAt: 'document_idle', enabled: true,
  });
  const saved = requests[1] as { provider: string; input: { skill: { type?: string; source?: string } } };
  assert.equal(saved.provider, 'site-skill');
  assert.equal(saved.input.skill.type, 'userscript');
  assert.match(saved.input.skill.source ?? '', /document\.body/);

  assert.equal(await unmountPlugin('page'), true);
  assert.deepEqual(tools.schemas(), []);
  assert.equal(prompt.assemble(), '');
  assert.equal(plugins.some(plugin => plugin.name === 'page'), false);
});

test('capability discovery prioritizes loadable groups and capability loading activates them', async () => {
  await applyTestPlugin(toolsPlugin);
  await applyTestPlugin(promptPlugin);
  const activeTaskId = ref<string | null>('task-1');
  await provideTestService('task', {
    activeTaskId,
    contexts: [],
    activeTask: () => ({ id: 'task-1', contextIds: [], capabilityIds: [] }),
    async attachCapability() {},
    async detachCapability() {},
  });
  await provideTestService('manager', {
    list: () => ['advanced-capability'],
    catalog: () => [{
      kind: 'capability', id: 'advanced-capability', name: 'advanced-capability', title: 'Advanced Capability',
      description: 'Test loadable tools.', scope: 'global', version: '0.1.0', status: 'active', attached: true,
      providers: [], permissions: [],
      contributes: { tools: ['advanced_tool'], panels: [], prompts: [], services: [], events: [], workflows: [] },
      health: 'healthy', issues: [],
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

  const tools = cordis.reflect.get('tools') as ToolsRuntime;
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
  const fiber = cordis.plugin({
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
  const fiber = await applyTestPlugin(filesPlugin);
  assert.equal(uiContributions.has('files:files'), true);
  assert.equal(uiContributions.get('files:files')?.component.name, 'FilesPanel');
  await fiber.dispose();
  assert.equal(uiContributions.has('files:files'), false);
});
