import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import taskPlugin from '@/plugins/task-runtime';
import promptPlugin from '@/plugins/prompt';
import pagePlugin from '@/extension/page-policy';
import { HarnessTaskStore } from '@/kernel/task-store';
import type { CapabilityRequest } from '@/shared/capability-protocol';
import type { JsonValue } from '@/shared/runtime';

async function headless(request: (request: CapabilityRequest) => Promise<JsonValue> = async () => null) {
  const ctx = new Context();
  const files = new Map<string, string>([['notes.txt', 'Read this file']]);
  const fs = {
    ready: Promise.resolve(), read: (path: string) => files.get(path) ?? null,
    list: () => [...files.keys()],
    async write(path: string, content: string) { files.set(path, content); },
    async remove(path: string) { files.delete(path); },
    async refresh() {},
  };
  const host = ctx.plugin({ name: 'headless-test', apply(owner) {
    owner.provide('fs', fs);
    owner.provide('broker', { request });
    owner.plugin(taskPlugin);
    owner.plugin(promptPlugin);
    owner.plugin(pagePlugin);
  } });
  await host;
  await ctx.task.ready;
  return { ctx, fs, files, dispose: () => host.dispose() };
}

test('headless task operations name a run, attach a file atomically and save an assistant report', async () => {
  const { ctx, fs, dispose } = await headless();
  try {
    await ctx.task.beginRun(new AbortController(), 'Research launch');
    assert.equal(ctx.task.activeTask()?.title, 'Research launch');
    await ctx.task.endRun();
    await ctx.task.beginRun(new AbortController(), 'Follow-up');
    assert.equal(ctx.task.activeTask()?.title, 'Research launch');
    await ctx.task.endRun();

    const write = fs.write;
    let saves = 0;
    fs.write = async (path, content) => { saves++; await write(path, content); };
    await ctx.task.attachFile('notes.txt');
    assert.equal(saves, 1);
    const state = await new HarnessTaskStore(fs).load();
    assert.equal(state.contexts[0]?.locator, 'notes.txt');
    assert.equal(state.events.at(-1)?.type, 'context/attached');
    const previous = fs.read('.harness/tasks.json');
    fs.write = async () => { throw new Error('disk full'); };
    await assert.rejects(ctx.task.addContext({ kind: 'page', title: 'Page', locator: 'https://example.test' }, {
      type: 'context/read', data: null,
    }), /disk full/);
    assert.equal(ctx.task.contexts.length, 1);
    assert.equal(fs.read('.harness/tasks.json'), previous);
    fs.write = write;
    assert.equal(await ctx.task.saveMessageArtifact({ role: 'note', text: 'diagnostic' }), null);
    const artifact = await ctx.task.saveMessageArtifact({ role: 'assistant', text: 'Report', thinking: '', toolCalls: [], status: 'done' });
    assert.deepEqual(artifact?.content, { text: 'Report' });
    assert.equal((await new HarnessTaskStore(fs).load()).artifacts.length, 1);
  } finally { await dispose(); }
});

test('headless page reads persist context and reject results that arrive after switching tasks', async () => {
  let release: (() => void) | undefined;
  let delay = false;
  const page = { scope: { tabId: 1, frameId: 0, url: 'https://example.test/', origin: 'https://example.test' }, title: 'Example', capturedAt: 1, truncated: false, nodes: [] };
  const { ctx, fs, dispose } = await headless(async request => {
    assert.equal(request.provider, 'page');
    if (delay) await new Promise<void>(resolve => { release = resolve; });
    return { ok: true, value: page };
  });
  try {
    const result = await ctx.pageSession.snapshot();
    assert.equal(result.nodeCount, 0);
    const stored = await new HarnessTaskStore(fs).load();
    assert.equal(stored.contexts[0]?.locator, page.scope.url);
    assert.equal(stored.events[0]?.type, 'context/read');
    delay = true;
    const pending = ctx.pageSession.snapshot();
    const rejected = assert.rejects(pending, /Task changed/);
    const next = await ctx.task.createTask('Other task');
    release!();
    await rejected;
    assert.equal(ctx.task.contexts.some(context => context.taskId === next.id), false);
  } finally { await dispose(); }
});

test('page plugin activation only applies after a successful save, without UI', async () => {
  const calls: string[] = [];
  let denySave = true;
  const { ctx, dispose } = await headless(async request => {
    calls.push(request.action);
    if (request.action === 'save' && denySave) throw new Error('permission denied');
    return null;
  });
  const plugin = { type: 'userscript' as const, id: 'theme', name: 'Theme', matches: ['https://example.test/*'], runAt: 'document_start' as const, source: '', enabled: false, createdAt: 1, updatedAt: 1 };
  try {
    await assert.rejects(ctx.pageSession.setPluginEnabled(plugin, true), /permission denied/);
    assert.deepEqual(calls, ['save']);
    denySave = false;
    calls.length = 0;
    await ctx.pageSession.setPluginEnabled(plugin, true);
    assert.deepEqual(calls, ['save', 'apply']);
    calls.length = 0;
    await ctx.pageSession.setPluginEnabled(plugin, false);
    assert.deepEqual(calls, ['save']);
  } finally { await dispose(); }
});

test('workspace invalidation refreshes without a view and waits for an active run to finish', async () => {
  const { ctx, fs, dispose } = await headless();
  let refreshed = 0;
  fs.refresh = async () => { refreshed++; };
  const waitForRefresh = () => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { off(); reject(new Error('No workspace refresh')); }, 2000);
    const off = ctx.on('task/activated', () => { clearTimeout(timeout); off(); resolve(); });
  });
  try {
    await ctx.task.beginRun(new AbortController());
    await ctx.parallel('loop/busy');
    ctx.emit('workspace/invalidated');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(refreshed, 0);
    const refreshedAfterStop = waitForRefresh();
    await ctx.task.endRun();
    await ctx.parallel('loop/idle');
    await refreshedAfterStop;
    assert.equal(refreshed, 1);
    const refreshedWhileIdle = waitForRefresh();
    ctx.emit('workspace/invalidated');
    await refreshedWhileIdle;
    assert.equal(refreshed, 2);
  } finally { await dispose(); }
});
