import type { PageEvent } from '@/shared/page-protocol';

const SIDE_PANEL_BASE_PATH = 'src/extension/sidepanel.html';
const SIDE_PANEL_PORT_PREFIX = 'harness-sidepanel-v2';

export function isInspectableUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sidePanelPath(tabId: number): string {
  assertTabId(tabId);
  return `${SIDE_PANEL_BASE_PATH}?tabId=${tabId}`;
}

export function sidePanelPortName(tabId: number): string {
  assertTabId(tabId);
  return `${SIDE_PANEL_PORT_PREFIX}:${tabId}`;
}

export function parseSidePanelTabId(value: string): number | null {
  try {
    const raw = new URL(value).searchParams.get('tabId');
    return raw == null ? null : parseTabId(raw);
  } catch {
    return null;
  }
}

export function parseSidePanelPortName(value: string): number | null {
  const prefix = `${SIDE_PANEL_PORT_PREFIX}:`;
  return value.startsWith(prefix) ? parseTabId(value.slice(prefix.length)) : null;
}

export function pageEventTabId(event: PageEvent): number | null {
  if ('scope' in event) return validEventTabId(event.scope.tabId);
  if ('annotation' in event) return validEventTabId(event.annotation.scope.tabId);
  if ('transaction' in event) return validEventTabId(event.transaction.scope.tabId);
  return null;
}

function parseTabId(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const tabId = Number(value);
  return Number.isSafeInteger(tabId) ? tabId : null;
}

function validEventTabId(tabId: number): number | null {
  return Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : null;
}

function assertTabId(tabId: number): void {
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error(`Invalid Chrome tab id: ${tabId}`);
}
