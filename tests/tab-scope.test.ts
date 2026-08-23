import assert from 'node:assert/strict';
import test from 'node:test';
import type { PageEvent, PageScope } from '@/shared/page-protocol';
import {
  isInspectableUrl,
  pageEventTabId,
  parseSidePanelPortName,
  parseSidePanelTabId,
  sidePanelPath,
  sidePanelPortName,
} from '@/extension/tab-scope';

const scope = (tabId: number): PageScope => ({
  tabId,
  frameId: 0,
  url: 'https://example.test/page',
  origin: 'https://example.test',
});

test('tab scope accepts web pages and rejects privileged or malformed URLs', () => {
  assert.equal(isInspectableUrl('https://example.test/'), true);
  assert.equal(isInspectableUrl('http://127.0.0.1:7331/'), true);
  assert.equal(isInspectableUrl('chrome://newtab/'), false);
  assert.equal(isInspectableUrl('chrome-extension://abc/options.html'), false);
  assert.equal(isInspectableUrl('not a URL'), false);
});

test('side panel path and port carry one validated tab id', () => {
  assert.equal(sidePanelPath(42), 'src/extension/sidepanel.html?tabId=42');
  assert.equal(parseSidePanelTabId(`chrome-extension://id/${sidePanelPath(42)}`), 42);
  assert.equal(parseSidePanelTabId('chrome-extension://id/sidepanel.html?tabId=-1'), null);
  assert.equal(parseSidePanelPortName(sidePanelPortName(42)), 42);
  assert.equal(parseSidePanelPortName('harness-sidepanel-v1:42'), null);
  assert.throws(() => sidePanelPath(-1), /Invalid Chrome tab id/u);
});

test('page events resolve to their owning tab while global recipe events broadcast', () => {
  const scoped: PageEvent = { type: 'page/ready', scope: scope(17) };
  const transaction: PageEvent = {
    type: 'patch/reverted',
    transaction: {
      id: 'p1', scope: scope(18), label: 'test', operations: [], createdAt: 1,
      status: 'reverted', verification: [],
    },
  };
  const globalEvent: PageEvent = { type: 'recipe/disposed', recipeId: 'recipe-1' };
  assert.equal(pageEventTabId(scoped), 17);
  assert.equal(pageEventTabId(transaction), 18);
  assert.equal(pageEventTabId(globalEvent), null);
});
