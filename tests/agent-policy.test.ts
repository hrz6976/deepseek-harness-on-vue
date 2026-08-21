import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardPageAgentTool, PAGE_AGENT_BOUNDARY_PROMPT } from '../src/extension/agent-policy';

test('page-agent policy separates host DOM changes from sandbox plugins', () => {
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /page_recipe_save/);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /temporary by default/i);
  assert.match(PAGE_AGENT_BOUNDARY_PROMPT, /explicit approval/i);
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
