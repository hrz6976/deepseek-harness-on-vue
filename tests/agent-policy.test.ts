import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardPageAgentTool, PAGE_AGENT_BOUNDARY_PROMPT } from '@/extension/agent-policy';

test('page-agent policy separates host DOM changes from sandbox plugins', () => {
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /page_recipe_save/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /temporary by default/i);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /explicit approval/i);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /MAIN.*USER_SCRIPT share the page DOM but have separate JavaScript globals/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /Never use a MAIN-world global lookup/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /page_recipe_list and page_recipe_get requests as strictly read-only/);
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
