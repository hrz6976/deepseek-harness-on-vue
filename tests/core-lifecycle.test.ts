import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RequestLifecycle } from '@/shared/request-lifecycle';
import { CapabilityGrants } from '@/extension/capability-grants';
import { acquireRuntimeLease } from '@/kernel/runtime-lease';
import { createActivator } from '@/plugins/manager/activation';
import { capabilities } from '@/kernel/capabilities';
import { readCapabilityPackage } from '@/kernel/capability-package';
import { runtime } from '@/kernel/cordis';
import { modules } from '@/kernel/modules';
import { applyTestPlugin, cleanupTestRuntime, provideTestService } from './runtime';
import { createTaskRuntimePlugin } from '@/plugins/task-runtime';
import { createBrokerPlugin } from '@/kernel/broker';

afterEach(cleanupTestRuntime);
const claim = { kind: 'capability' as const, id: 'file-editor', fiberId: 'test:1', scope: 'global' as const, providers: ['page'] as const, permissions: ['*'] };
const manifest = { id: 'reader', title: 'Reader', version: '1.0.0', scope: 'task' as const, requires: { providers: ['page' as const] }, permissions: [{ id: 'page.read' }] };

test('trusted grants discard forged permissions, provider lists and system identities', () => {
  const grants = new CapabilityGrants();
  const resolved = grants.resolve(claim as never);
  assert.deepEqual(resolved.providers, ['workspace']);
  assert.deepEqual(resolved.permissions, ['workspace.read', 'workspace.write']);
  assert.throws(() => grants.resolve({ ...claim, id: 'invented' } as never), /no trusted host grant/);
  assert.throws(() => grants.resolve({ ...claim, kind: 'system', id: 'file-editor' } as never), /no trusted host grant/);
  assert.throws(() => grants.resolve({ ...claim, id: 'constructor' } as never), /no trusted host grant/);
});

test('custom grants require approval, persist before use and do not silently expand', async () => {
  const grants = new CapabilityGrants();
  let prompts = 0;
  let saved = 0;
  await assert.rejects(grants.authorize(manifest, async () => false, async () => { saved++; }), /declined/);
  assert.equal(saved, 0);
  await grants.authorize(manifest, async () => { prompts++; return true; }, async () => { saved++; });
  await grants.authorize(manifest, async () => { prompts++; return true; }, async () => {});
  assert.equal(prompts, 1);
  await assert.rejects(grants.authorize({ ...manifest, permissions: [{ id: 'page.modify' }] }, async () => false, async () => {}), /declined/);
  const resolved = grants.resolve({ ...claim, id: 'reader', taskId: 't' } as never);
  assert.equal(resolved.scope, 'task');
  assert.deepEqual(resolved.permissions, ['page.read']);
  await assert.rejects(grants.authorize({ ...manifest, id: 'other' }, async () => true, async () => { throw new Error('disk failed'); }), /disk failed/);
  assert.throws(() => grants.resolve({ ...claim, id: 'other' } as never), /no trusted host grant/);
  await assert.rejects(grants.authorize({ ...manifest, permissions: [{ id: '*' }] }, async () => true, async () => {}), /system authority/);
});

test('request cancellation and deadline close every pending phase exactly once', async () => {
  const requests = new RequestLifecycle();
  const signal = requests.start('approval');
  let aborted = 0;
  signal.addEventListener('abort', () => aborted++);
  assert.throws(() => requests.start('approval'), /Duplicate/);
  requests.cancel('approval');
  requests.cancel('approval');
  assert.equal(aborted, 1);
  assert.throws(() => signal.throwIfAborted(), /abort/i);
  const expired = requests.start('expires', Date.now() + 10);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(expired.aborted, true);
  const complete = requests.start('complete');
  requests.finish('complete');
  const waiting = requests.start('waiting');
  requests.close();
  assert.equal(complete.aborted, false);
  assert.equal(waiting.aborted, true);
  assert.throws(() => requests.start('late', Date.now() - 1), /expired/);
});

test('runtime ownership rejects another writer until its lease is released', async () => {
  const owners = new Set<string>();
  const locks = { async request(name, _options, callback) {
    if (owners.has(name)) return callback(null);
    owners.add(name);
    try { return await callback({ name }); } finally { owners.delete(name); }
  } } as LockManager;
  const release = await acquireRuntimeLease('example.test', locks);
  await assert.rejects(acquireRuntimeLease('example.test', locks), /already has an active/);
  const other = await acquireRuntimeLease('other.test', locks);
  other(); release();
  await new Promise(resolve => setTimeout(resolve, 0));
  (await acquireRuntimeLease('example.test', locks))();
});

test('plugin metadata failure preserves the instance; apply or commit failure restores the previous package', async () => {
  globalThis.__harness = { modules };
  const files = new Map<string, string>();
  let rejectWrite = false;
  const fs = { ready: Promise.resolve(), read: path => files.get(path) ?? null, list: () => [...files.keys()],
    async write(path, source) { if (rejectWrite) throw new Error('disk failed'); files.set(path, source); }, async remove(path) { files.delete(path); } };
  const activate = createActivator(fs as never, () => runtime, () => {});
  const old = "export default { apply() {} }; // old";
  assert.ok((await activate('revision', old)).entry);
  const original = capabilities.get('revision')!;
  const invalid = await activate('revision', "import { z } from 'zod'; export default { Config: z.object({ required: z.string() }), apply() {} };");
  assert.equal(invalid.entry, null);
  assert.equal(capabilities.get('revision'), original);
  assert.notEqual(original.fiber?.uid, null);
  const applyError = await activate('revision', "export default { apply() { throw new Error('apply failed'); } };");
  assert.match(applyError.error, /apply failed/);
  assert.equal(capabilities.get('revision')?.status, 'active');
  assert.equal(readCapabilityPackage(fs as never, 'revision')?.source, old);
  rejectWrite = true;
  const persistError = await activate('revision', "export default { apply() {} }; // new");
  assert.match(persistError.error, /disk failed/);
  assert.equal(capabilities.get('revision')?.status, 'active');
  assert.equal(readCapabilityPackage(fs as never, 'revision')?.source, old);
});


test('task capability is attached before apply can call the broker, and failed installation detaches it', async () => {
  const files = new Map<string, string>();
  const fs = { ready: Promise.resolve(), read: path => files.get(path) ?? null, list: () => [...files.keys()],
    async write(path, source) { files.set(path, source); }, async remove(path) { files.delete(path); } };
  await provideTestService('fs', fs);
  await applyTestPlugin(createTaskRuntimePlugin());
  await runtime.task.ready;
  const seen: string[] = [];
  await applyTestPlugin(createBrokerPlugin({
    async request(principal) { seen.push(principal.taskId!); return null; },
    async *stream() {},
  }));
  const activate = createActivator(fs as never, () => runtime.task.scope(), () => {});
  const source = `export default { inject: ['broker'], async apply(ctx) {
    await ctx.broker.request({ provider: 'page', action: 'command', input: { command: { type: 'page/snapshot' } } });
  } };`;
  assert.ok((await activate('reader', source, { manifest })).entry);
  assert.deepEqual(seen, [runtime.task.activeTask()!.id]);
  assert.ok(runtime.task.activeTask()!.capabilityIds.includes('reader'));
  const failure = await activate('failing', "export default { apply() { throw new Error('no'); } }", { manifest: { ...manifest, id: 'failing' } });
  assert.equal(failure.entry, null);
  assert.equal(runtime.task.activeTask()!.capabilityIds.includes('failing'), false);
});
