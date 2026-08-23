import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { ElementRef, PageCommand, PageCommandResult, PatchTransaction } from '../src/shared/page-protocol';

const browserWindow = new Window({ url: 'https://legacy.example.test/dashboard' });
browserWindow.document.body.innerHTML = `
  <main id="app">
    <h1 class="title">Legacy dashboard</h1>
    <a id="action" href="/old">Open</a>
  </main>`;
browserWindow.document.title = 'Legacy fixture';
browserWindow.setInterval = (() => 0) as typeof browserWindow.setInterval;

for (const key of [
  'window', 'document', 'location', 'navigator', 'Element', 'HTMLElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'InputEvent', 'Event', 'Node', 'MutationObserver', 'CSS', 'DocumentFragment', 'getComputedStyle',
] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browserWindow : browserWindow[key] });
}

type ContentListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: PageCommandResult) => void,
) => boolean | undefined;
let contentListener: ContentListener | null = null;
const emitted: unknown[] = [];
Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: {
    runtime: {
      onMessage: { addListener(listener: ContentListener) { contentListener = listener; } },
      async sendMessage(message: unknown) { emitted.push(message); },
    },
  },
});

await import('../src/extension/content-script');

async function command(value: PageCommand): Promise<PageCommandResult> {
  assert.ok(contentListener, 'content-script message listener should be installed');
  return await new Promise(resolve => {
    const keepAlive = contentListener!({ channel: 'harness-page-v1', command: value }, {}, resolve);
    assert.equal(keepAlive, true);
  });
}

test('content runtime snapshots and queries framework-neutral DOM references', async () => {
  const snapshot = await command({ type: 'page/snapshot', options: { maxNodes: 20, maxDepth: 4 } });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.value.title, 'Legacy fixture');
  assert.equal(snapshot.value.scope.origin, 'https://legacy.example.test');

  const query = await command({ type: 'page/query', selector: '#action' });
  assert.equal(query.ok, true);
  if (!query.ok) return;
  const refs = query.value as ElementRef[];
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.fingerprint.tag, 'a');
  assert.equal(refs[0]?.selector, '#action');
  assert.ok(refs[0]?.documentId);
  assert.equal(refs[0]?.generation, 0);

  const stale = await command({
    type: 'page/click',
    target: { ...refs[0]!, generation: refs[0]!.generation! + 1 },
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error, /lease expired/);
});

test('page capability paginates queries and performs approved-style interactions', async () => {
  const form = browserWindow.document.createElement('div');
  form.innerHTML = '<input id="agent-input"><button class="bulk">One</button><button class="bulk">Two</button><button class="bulk">Three</button>';
  browserWindow.document.body.append(form);
  const input = form.querySelector<HTMLInputElement>('#agent-input')!;
  let inputEvents = 0;
  let clicks = 0;
  input.addEventListener('input', () => inputEvents++);
  form.querySelector('button')!.addEventListener('click', () => clicks++);

  const inputQuery = await command({ type: 'page/query', selector: '#agent-input' });
  const inputTarget = inputQuery.ok ? (inputQuery.value as ElementRef[])[0]! : null;
  assert.ok(inputTarget);
  assert.equal((await command({ type: 'page/type', target: inputTarget!, value: 'Harness' })).ok, true);
  assert.equal(input.value, 'Harness');
  assert.equal(inputEvents, 1);

  const buttonQuery = await command({ type: 'page/query', selector: '.bulk' });
  const buttonTarget = buttonQuery.ok ? (buttonQuery.value as ElementRef[])[0]! : null;
  assert.ok(buttonTarget);
  assert.equal((await command({ type: 'page/click', target: buttonTarget! })).ok, true);
  assert.equal(clicks, 1);

  const page = await command({ type: 'page/query-page', selector: '.bulk', offset: 1, limit: 1 });
  assert.equal(page.ok, true);
  if (page.ok) assert.deepEqual({ total: (page.value as { total: number }).total, nextOffset: (page.value as { nextOffset?: number }).nextOffset }, { total: 3, nextOffset: 2 });
  assert.equal((await command({ type: 'page/wait', selector: '#agent-input', state: 'attached', timeoutMs: 100 })).ok, true);
  assert.equal((await command({ type: 'page/settle', quietMs: 0, timeoutMs: 100 })).ok, true);
  form.remove();
});

test('content runtime applies, verifies, and reverts one DOM transaction', async () => {
  const query = await command({ type: 'page/query', selector: '.title' });
  assert.equal(query.ok, true);
  if (!query.ok) return;
  const target = (query.value as ElementRef[])[0]!;
  const applied = await command({
    type: 'page/patch-apply',
    label: 'modernize heading',
    operations: [
      { kind: 'set-text', target, value: 'Modern dashboard' },
      { kind: 'set-style', target, property: 'color', value: 'rgb(79, 140, 255)' },
    ],
  });
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  const transaction = applied.value as PatchTransaction;
  assert.equal(transaction.status, 'applied');
  assert.equal(browserWindow.document.querySelector('.title')?.textContent, 'Modern dashboard');

  const verified = await command({ type: 'page/patch-verify', transactionId: transaction.id });
  assert.equal(verified.ok, true);
  const reverted = await command({ type: 'page/patch-revert', transactionId: transaction.id });
  assert.equal(reverted.ok, true);
  assert.equal(browserWindow.document.querySelector('.title')?.textContent, 'Legacy dashboard');
});

test('set-text undo restores the original node identity and listeners', async () => {
  const heading = browserWindow.document.createElement('h2');
  heading.id = 'structured-heading';
  const child = browserWindow.document.createElement('button');
  child.textContent = 'Original child';
  let clicks = 0;
  child.addEventListener('click', () => clicks++);
  heading.append(child);
  browserWindow.document.body.append(heading);

  const query = await command({ type: 'page/query', selector: '#structured-heading' });
  assert.equal(query.ok, true);
  if (!query.ok) return;
  const target = (query.value as ElementRef[])[0]!;
  const applied = await command({
    type: 'page/patch-apply',
    label: 'replace structured heading temporarily',
    operations: [{ kind: 'set-text', target, value: 'Temporary text' }],
  });
  assert.equal(applied.ok, true);
  if (!applied.ok) return;

  const transaction = applied.value as PatchTransaction;
  assert.equal((await command({ type: 'page/patch-revert', transactionId: transaction.id })).ok, true);
  assert.equal(heading.firstChild, child, 'undo must restore the same framework-owned node');
  child.dispatchEvent(new browserWindow.Event('click'));
  assert.equal(clicks, 1, 'listeners on restored nodes must survive undo');
  heading.remove();
});

test('content runtime sanitizes HTML and rolls back a rejected patch', async () => {
  const query = await command({ type: 'page/query', selector: '#action' });
  assert.equal(query.ok, true);
  if (!query.ok) return;
  const target = (query.value as ElementRef[])[0]!;
  const preview = await command({
    type: 'page/patch-preview',
    label: 'reject unsafe preview',
    operations: [{ kind: 'set-attribute', target, name: 'onclick', value: 'alert(1)' }],
  });
  assert.equal(preview.ok, true);
  assert.equal((preview.ok ? preview.value as PatchTransaction : null)?.status, 'verification-failed');
  const inserted = await command({
    type: 'page/patch-apply',
    label: 'safe insertion',
    operations: [{ kind: 'insert-html', target, position: 'afterend', html: '<button onclick="alert(1)">Safe</button><script>bad()</script>' }],
  });
  assert.equal(inserted.ok, true);
  const button = browserWindow.document.querySelector('button');
  assert.ok(button);
  assert.equal(button?.hasAttribute('onclick'), false);
  assert.equal(browserWindow.document.querySelector('script'), null);

  const rejected = await command({
    type: 'page/patch-apply',
    label: 'reject javascript URL',
    operations: [
      { kind: 'set-text', target, value: 'must roll back' },
      { kind: 'set-attribute', target, name: 'href', value: 'javascript:alert(1)' },
    ],
  });
  assert.equal(rejected.ok, false);
  assert.equal(browserWindow.document.querySelector('#action')?.textContent, 'Open');
  assert.ok(emitted.length >= 2, 'content runtime should publish lifecycle and patch events');
});

test('declarative live rules apply to future matching nodes and can be stopped', async () => {
  const rules = [{
    id: 'ready-card',
    selector: '.dynamic-card',
    predicate: { attributes: [{ name: 'data-state', equals: 'ready' }] },
    actions: [
      { kind: 'add-class' as const, value: 'harness-ready' },
      { kind: 'set-style' as const, property: 'border-color', value: 'rgb(49, 94, 231)' },
    ],
  }];
  const preview = await command({ type: 'page/live-rules-preview', rules });
  assert.equal(preview.ok, true);
  if (preview.ok) assert.equal((preview.value as { totalMatches: number }).totalMatches, 0);

  const installed = await command({ type: 'page/live-rules-install', id: 'dynamic-cards', label: 'dynamic cards', rules });
  assert.equal(installed.ok, true);
  const first = browserWindow.document.createElement('article');
  first.className = 'dynamic-card';
  first.setAttribute('data-state', 'ready');
  browserWindow.document.body.append(first);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(first.classList.contains('harness-ready'), true);
  assert.equal(first.style.getPropertyValue('border-color'), 'rgb(49, 94, 231)');

  assert.equal((await command({ type: 'page/live-rules-remove', id: 'dynamic-cards' })).ok, true);
  const second = browserWindow.document.createElement('article');
  second.className = 'dynamic-card';
  second.setAttribute('data-state', 'ready');
  browserWindow.document.body.append(second);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(second.classList.contains('harness-ready'), false);
  first.remove();
  second.remove();
});

test('page observation publishes mutation events independently from live rules', async () => {
  const before = emitted.length;
  assert.equal((await command({ type: 'page/observe', enabled: true })).ok, true);
  const node = browserWindow.document.createElement('aside');
  browserWindow.document.body.append(node);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.ok(emitted.slice(before).some(value => (value as { event?: { type?: string } }).event?.type === 'page/mutation'));
  assert.equal((await command({ type: 'page/observe', enabled: false })).ok, true);
  node.remove();
});

test('React hosts support DOM patches but reconciliation remains authoritative', async () => {
  const container = browserWindow.document.createElement('div');
  browserWindow.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  flushSync(() => root.render(createElement('strong', { id: 'react-value' }, 'React value 1')));
  const query = await command({ type: 'page/query', selector: '#react-value' });
  assert.equal(query.ok, true);
  if (!query.ok) return;
  const target = (query.value as ElementRef[])[0]!;
  const patched = await command({
    type: 'page/patch-apply',
    label: 'temporary React DOM patch',
    operations: [{ kind: 'set-text', target, value: 'Agent value' }],
  });
  assert.equal(patched.ok, true);
  assert.equal(container.textContent, 'Agent value');

  flushSync(() => root.render(createElement('strong', { id: 'react-value' }, 'React value 2')));
  assert.equal(container.textContent, 'React value 2', 'React state/source wins on the next reconciliation');
  root.unmount();
  container.remove();
});
