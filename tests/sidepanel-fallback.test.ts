import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fallbackPanelTarget,
  startFallbackPanelRouter,
  type FallbackPanelRouterPorts,
  type FallbackPanelTab,
} from '@/extension/sidepanel-fallback';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function fakeRouter(initial: FallbackPanelTab) {
  let active = initial;
  let activated: ((tabId: number) => void) | null = null;
  let updated: ((tabId: number, change: { status?: string; url?: string }, tab: FallbackPanelTab) => void) | null = null;
  let focused: ((windowId: number) => void) | null = null;
  const navigations: string[] = [];
  const ports: FallbackPanelRouterPorts = {
    async getTab() { return active; },
    async queryActive() { return [active]; },
    onActivated(listener) { activated = listener; return () => { activated = null; }; },
    onUpdated(listener) { updated = listener; return () => { updated = null; }; },
    onWindowFocused(listener) { focused = listener; return () => { focused = null; }; },
    navigate(path) { navigations.push(path); },
  };
  return {
    ports,
    navigations,
    activate(tab: FallbackPanelTab) {
      active = tab;
      activated?.(tab.id!);
    },
    update(tab: FallbackPanelTab, change: { status?: string; url?: string }) {
      active = tab;
      updated?.(tab.id!, change, tab);
    },
    focus(windowId = 1) { focused?.(windowId); },
  };
}

test('fallback routes an already-open panel when the current tab becomes HTTP(S)', async () => {
  const router = fakeRouter({ id: 10, active: true, url: 'chrome://newtab/' });
  startFallbackPanelRouter(router.ports);
  await settle();
  assert.deepEqual(router.navigations, []);

  router.update({ id: 10, active: true, url: 'https://example.test/' }, { status: 'loading', url: 'https://example.test/' });
  assert.deepEqual(router.navigations, ['src/extension/sidepanel.html?tabId=10']);
});

test('fallback rebinds to the replacement active tab after the original tab closes', async () => {
  const router = fakeRouter({ id: 10, active: true, url: 'chrome://newtab/' });
  startFallbackPanelRouter(router.ports);
  await settle();

  router.activate({ id: 27, active: true, url: 'https://replacement.test/page' });
  await settle();
  assert.deepEqual(router.navigations, ['src/extension/sidepanel.html?tabId=27']);
});

test('fallback ignores background and privileged tabs', () => {
  assert.equal(fallbackPanelTarget({ id: 1, active: false, url: 'https://background.test/' }), null);
  assert.equal(fallbackPanelTarget({ id: 2, active: true, url: 'chrome://extensions/' }), null);
});

test('fallback HTML loads only the lightweight router, not the sandbox runtime', async () => {
  const html = await readFile(new URL('../src/extension/sidepanel-fallback.html', import.meta.url), 'utf8');
  assert.match(html, /sidepanel-fallback\.ts/);
  assert.doesNotMatch(html, /harness-sandbox|sandbox\.ts/);
});
