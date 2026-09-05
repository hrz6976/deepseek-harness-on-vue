import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { useSandboxInspector } from '@/extension/sandbox-inspector';
import type { TaskRuntimeService } from '@/shared/runtime';
import { cleanupTestRuntime, provideTestService } from './runtime';
import { applyTestPlugin } from './runtime';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { renderMarkdown } from '@/shared/markdown';
import taskPlugin from '@/plugins/task-runtime';
import { runtime } from '@/kernel/cordis';
import { mountPlugin } from '@/kernel/host';
import { HarnessTaskStore } from '@/kernel/task-store';

afterEach(cleanupTestRuntime);

test('task drawer derives resource counts without removed TaskSession fields', async () => {
  const task = { id: 'task-1', title: 'Visible task', status: 'idle', capabilityIds: [], createdAt: 1, updatedAt: 1 };
  const service = {
    tasks: [task], contexts: [{ taskId: task.id }, { taskId: 'other' }],
    artifacts: [{ taskId: task.id }, { taskId: task.id }],
  } as unknown as TaskRuntimeService;
  await provideTestService('task', service);
  const inspector = useSandboxInspector(() => {}, () => {});

  assert.deepEqual(inspector.taskRows.value.map(row => [row.task.title, row.contextCount, row.artifactCount]), [
    ['Visible task', 1, 2],
  ]);
  const template = await readFile(new URL('../src/extension/sandbox-app.html', import.meta.url), 'utf8');
  assert.match(template, /@click="createTask">新建任务/);
  assert.doesNotMatch(template, /task\.(?:contextIds|artifactIds)/);
});

test('save as report persists the message and renders its body in the actual inspector template', async () => {
  const files = new Map<string, string>();
  const fs = {
    ready: Promise.resolve(), read: (path: string) => files.get(path) ?? null,
    list: () => [...files.keys()],
    async write(path: string, content: string) { files.set(path, content); },
    async remove(path: string) { files.delete(path); },
  };
  await provideTestService('fs', fs);
  await applyTestPlugin(taskPlugin);
  await runtime.task.ready;
  await mountPlugin('visible-capability', { apply() {} }, { builtin: true });
  const errors: string[] = [];
  const inspector = useSandboxInspector(error => errors.push(error), () => {});
  const text = '**Saved finding**\n\n<script>alert(1)</script>';
  await inspector.saveMessageArtifact({ role: 'assistant', text, thinking: '', toolCalls: [], status: 'done' });
  assert.equal(inspector.inspector.value, 'artifacts');
  assert.deepEqual(errors, []);
  assert.deepEqual((await new HarnessTaskStore(fs).load()).artifacts[0]?.content, { text });

  const source = await readFile(new URL('../src/extension/sandbox-app.html', import.meta.url), 'utf8');
  const start = source.indexOf('<n-drawer v-model:show="inspectorOpen"');
  const template = source.slice(start, source.indexOf('</n-drawer>', start) + '</n-drawer>'.length);
  const app = createSSRApp({ template, setup: () => ({ ...inspector, renderMarkdown }) });
  const slotHost = defineComponent({ setup: (_props, { slots }) => () => h('div', Object.values(slots).flatMap(slot => slot?.() ?? [])) });
  for (const name of new Set([...template.matchAll(/<(n-[\w-]+|Trash)\b/g)].map(match => match[1]!))) app.component(name, slotHost);
  const html = await renderToString(app);
  assert.match(html, /<strong>Saved finding<\/strong>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('save as report surfaces persistence failure instead of silently leaving the button unchanged', async () => {
  await provideTestService('task', { async saveMessageArtifact() { throw new Error('disk full'); } });
  const errors: string[] = [];
  const inspector = useSandboxInspector(error => errors.push(error), () => {});
  await inspector.saveMessageArtifact({ role: 'assistant', text: 'Report', thinking: '', toolCalls: [], status: 'done' });
  assert.equal(inspector.inspector.value, null);
  assert.match(errors[0] ?? '', /disk full/);
});
