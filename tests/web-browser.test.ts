import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { extractReadablePage, extractSearchResults } from '@/extension/web-browser';

function installWindow(html: string, url: string): Window {
  const browserWindow = new Window({ url });
  browserWindow.document.body.innerHTML = html;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browserWindow.document });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: browserWindow.HTMLElement });
  return browserWindow;
}

test('web search extraction is engine-agnostic and returns external sources', () => {
  installWindow(`
    <main>
      <article><a href="https://docs.example.test/deepseek"><h3>DeepSeek API guide</h3></a><p>Current model and API details.</p></article>
      <a href="/settings">Search settings</a>
    </main>
  `, 'https://search.example.test/?q=deepseek');
  assert.deepEqual(extractSearchResults(5), [{
    title: 'DeepSeek API guide',
    url: 'https://docs.example.test/deepseek',
    snippet: 'Current model and API details.',
  }]);
});

test('web open extraction returns bounded readable text and links', () => {
  const browserWindow = installWindow(`
    <nav>Navigation noise</nav>
    <main><h1>Primary source</h1><p>${'fact '.repeat(300)}</p><a href="/details">Details</a></main>
  `, 'https://source.example.test/article');
  browserWindow.document.title = 'Source title';
  const page = extractReadablePage(1_000);
  assert.equal(page.title, 'Source title');
  assert.equal(page.truncated, true);
  assert.equal(page.text.length, 1_000);
  assert.deepEqual(page.links, [{ title: 'Details', url: 'https://source.example.test/details' }]);
});
