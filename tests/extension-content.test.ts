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
  'Node', 'MutationObserver', 'CSS', 'DocumentFragment', 'getComputedStyle',
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
