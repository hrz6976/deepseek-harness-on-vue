import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '@/kernel/cordis';
import promptPlugin from '@/plugins/prompt';
import toolsPlugin from '@/plugins/tools';
import { AGENT_CORE_PROMPT } from '@/plugins/loop';
import loopPlugin from '@/plugins/loop';
import type { HarnessMessage, LlmRequest } from '@/shared/runtime';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';

afterEach(async () => { await cleanupTestRuntime(); });

test('core agent prompt defines Codex-like execution and communication behavior', () => {
  assert.match(AGENT_CORE_PROMPT, /collaborate with them until their goal is genuinely handled/i);
  assert.match(AGENT_CORE_PROMPT, /answers, explanations, reviews, audits, and plans/i);
  assert.match(AGENT_CORE_PROMPT, /changes, builds, fixes, and implementation/i);
  assert.match(AGENT_CORE_PROMPT, /Do not stop at a proposal/i);
  assert.match(AGENT_CORE_PROMPT, /Continue through multi-step work/i);
  assert.match(AGENT_CORE_PROMPT, /Preserve existing user work/i);
  assert.match(AGENT_CORE_PROMPT, /persistent host-page installation/i);
  assert.match(AGENT_CORE_PROMPT, /Never claim that code works/i);
  assert.match(AGENT_CORE_PROMPT, /Lead with the outcome/i);
});

test('core agent prompt is first in every assembled loop request', async () => {
  await applyTestPlugin(toolsPlugin);
  await applyTestPlugin(promptPlugin);
  runtime.prompt.register({ name: 'boundary-probe', order: -100, text: 'BOUNDARY_PROBE' });
  runtime.prompt.register({ name: 'tool-probe', order: 10, text: 'TOOL_PROBE' });

  const messages: HarnessMessage[] = [];
  let systemPrompt = '';
  await provideTestService('fs', {
    ready: Promise.resolve(), files: new Map(), read: () => null, list: () => [],
    write: async () => { }, remove: async () => { },
  });
  await provideTestService('task', {
    ready: Promise.resolve(), messages, activeTask: () => null,
    async appendEvent() { }, async saveCheckpoint() { },
  });
  await provideTestService('llm', {
    stream: async function*(request: LlmRequest) {
      systemPrompt = request.systemPrompt;
      yield { type: 'done' as const, text: 'ok', thinking: '', finishReason: 'stop' as const, toolCalls: [] };
    },
  });
  await applyTestPlugin(loopPlugin);

  await runtime.loop.run('audit prompt assembly');

  const boundaryIndex = systemPrompt.indexOf('BOUNDARY_PROBE');
  const toolIndex = systemPrompt.indexOf('TOOL_PROBE');
  assert.ok(systemPrompt.startsWith(AGENT_CORE_PROMPT));
  assert.ok(boundaryIndex >= AGENT_CORE_PROMPT.length);
  assert.ok(toolIndex > boundaryIndex);
});
