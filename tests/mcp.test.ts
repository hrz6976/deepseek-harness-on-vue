import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { runtime } from '@/kernel/cordis';
import promptPlugin from '@/plugins/prompt';
import toolsPlugin, { type ToolsRuntime } from '@/plugins/tools';
import mcpPlugin from '@/plugins/tools/mcp';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';

afterEach(async () => { await cleanupTestRuntime(); });

test('MCP loads a Draft-07 remote tool and keeps creation guidance distinct', async () => {
  await applyTestPlugin(toolsPlugin);
  await applyTestPlugin(promptPlugin);
  await provideTestService('task', { activeTaskId: ref('task-1') });
  const requests: Array<{ action?: string; input?: { name?: string; arguments?: unknown } }> = [];
  await provideTestService('broker', {
    async request(request: { action?: string; input?: { name?: string; arguments?: unknown } }) {
      requests.push(request);
      if (request.action === 'list-tools') return {
        tools: [{
          name: 'echo',
          description: 'Echo a message.',
          inputSchema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object', properties: { message: { type: 'string' } }, required: ['message'],
          },
        }],
      };
      if (request.action === 'call-tool') return { content: [{ type: 'text', text: request.input?.arguments }] };
      return null;
    },
  });
  await applyTestPlugin(mcpPlugin);

  const tools = runtime.reflect.get('tools') as ToolsRuntime;
  assert.equal(tools.load('mcp'), true);
  assert.match(String(await tools.call('mcp_load_tool', { id: 'everything', name: 'echo' })), /"loaded":true/);
  assert.match(String(await tools.call('mcp_everything_echo', { message: 'hello' })), /hello/);
  assert.deepEqual(requests.map(request => request.action), ['list-tools', 'call-tool']);
});
