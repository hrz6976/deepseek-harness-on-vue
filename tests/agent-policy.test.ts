import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardPageAgentTool, PAGE_AGENT_BOUNDARY_PROMPT } from '@/extension/agent-policy';
import { Context } from '@deepseek-ai/cordis';
import pagePolicy from '@/extension/page-policy';
import promptPlugin from '@/plugins/prompt';

test('page-agent policy separates host DOM changes from sandbox plugins', () => {
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /page_recipe_save/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /temporary by default/i);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /explicit approval/i);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /MAIN.*USER_SCRIPT share the page DOM but have separate JavaScript globals/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /Never use a MAIN-world global lookup/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /page_recipe_list, page_recipe_get, and page_recipe_debug requests as strictly read-only/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /compare persisted and Chrome-registered source hashes/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /Never change a recipe id or create a second copy/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /create_plugin creates a sandbox capability/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /mcp_connect connects the built-in client/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /MCP server.*external listening process/i);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /<page_annotations>/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /empty annotation text/i);
  assert.match(guardPageAgentTool({
    name: 'create_plugin',
    args: { source: `export default { setup() { document.head.append('style') } }` },
  }) ?? '', /side panel/i);
  assert.equal(guardPageAgentTool({
    name: 'create_plugin',
    args: { source: `export default { template: '<section>Plugin UI</section>' }` },
  }), null);
  assert.equal(guardPageAgentTool({ name: 'page_patch_apply', args: {} }), null);
});

test('page policy runs without Vue and its prompts and listeners follow Fiber disposal', async () => {
  const ctx = new Context();
  const prompt = ctx.plugin(promptPlugin);
  const artifacts: unknown[] = [];
  const task = ctx.plugin({
    name: 'test-task',
    apply(owner) {
      owner.provide('broker', {});
      owner.provide('task', {
        activeTask: () => ({ id: 'task-1' }), artifacts,
        async createArtifact(artifact: unknown) { artifacts.push(artifact); },
      });
    },
  });
  await Promise.all([prompt, task]);
  const policy = ctx.plugin(pagePolicy);
  try {
    await policy;
    assert.match(ctx.prompt.assemble(), /temporary by default/i);
    const request = { name: 'create_plugin', args: { source: "document.head.append('style')" } };
    const guarded = await ctx.waterfall('tools/pre-execute', request, value => value);
    assert.match(guarded.veto ?? '', /side panel/i);
    await ctx.waterfall('tools/post-execute', { name: 'page_patch_apply', args: {}, result: 'ok' }, value => value);
    assert.match(ctx.prompt.assemble(), /still temporary/i);
    await ctx.waterfall('tools/post-execute', { name: 'page_recipe_save', args: {}, result: 'Error: denied' }, value => value);
    assert.match(ctx.prompt.assemble(), /still temporary/i);
    await ctx.waterfall('tools/post-execute', { name: 'page_patch_revert', args: {}, result: 'ok' }, value => value);
    assert.doesNotMatch(ctx.prompt.assemble(), /still temporary/i);
    const event = { type: 'recipe/installed', recipe: { id: 'recipe-1', name: 'Theme', enabled: true } } as const;
    await ctx.parallel('page/event', event);
    assert.equal(artifacts.length, 1);
    await policy.dispose();
    assert.equal(ctx.prompt.assemble(), '');
    assert.deepEqual(await ctx.waterfall('tools/pre-execute', request, value => value), request);
    await ctx.parallel('page/event', event);
    assert.equal(artifacts.length, 1);
  } finally {
    await policy.dispose();
    await task.dispose();
    await prompt.dispose();
  }
});
