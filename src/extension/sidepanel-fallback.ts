import { isInspectableUrl, sidePanelPath } from './tab-scope';

export interface FallbackPanelTab {
  id?: number;
  active?: boolean;
  pendingUrl?: string;
  url?: string;
}

export interface FallbackPanelRouterPorts {
  getTab(tabId: number): Promise<FallbackPanelTab>;
  queryActive(windowId?: number): Promise<FallbackPanelTab[]>;
  onActivated(listener: (tabId: number) => void): () => void;
  onUpdated(listener: (tabId: number, change: { status?: string; url?: string }, tab: FallbackPanelTab) => void): () => void;
  onWindowFocused(listener: (windowId: number) => void): () => void;
  navigate(path: string): void;
}

export function fallbackPanelTarget(tab: FallbackPanelTab | undefined): string | null {
  if (tab?.id == null || tab.active === false) return null;
  const url = tab.pendingUrl ?? tab.url;
  return isInspectableUrl(url) ? sidePanelPath(tab.id) : null;
}

/**
 * The manifest fallback can already be visible when Chrome changes the
 * tab-specific side-panel path. setOptions() affects the next open, but does
 * not reliably navigate that existing document, so the fallback follows the
 * active tab itself and hands off as soon as an inspectable page appears.
 */
export function startFallbackPanelRouter(ports: FallbackPanelRouterPorts): () => void {
  let routed = false;
  const cleanups: Array<() => void> = [];

  const route = (tab: FallbackPanelTab | undefined): void => {
    if (routed) return;
    const target = fallbackPanelTarget(tab);
    if (!target) return;
    routed = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
    ports.navigate(target);
  };
  const inspect = (tabId: number): void => {
    void ports.getTab(tabId).then(route, () => undefined);
  };

  cleanups.push(
    ports.onActivated(inspect),
    ports.onUpdated((_tabId, change, tab) => {
      if (!change.url && change.status !== 'loading' && change.status !== 'complete') return;
      route(tab);
    }),
    ports.onWindowFocused(windowId => {
      void ports.queryActive(windowId).then(tabs => route(tabs[0]), () => undefined);
    }),
  );
  void ports.queryActive().then(tabs => route(tabs[0]), () => undefined);

  return () => {
    routed = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}

if (typeof chrome !== 'undefined') {
  startFallbackPanelRouter({
    getTab: tabId => chrome.tabs.get(tabId),
    queryActive: windowId => chrome.tabs.query(windowId == null
      ? { active: true, lastFocusedWindow: true }
      : { active: true, windowId }),
    onActivated(listener) {
      const wrapped = ({ tabId }: chrome.tabs.OnActivatedInfo) => listener(tabId);
      chrome.tabs.onActivated.addListener(wrapped);
      return () => chrome.tabs.onActivated.removeListener(wrapped);
    },
    onUpdated(listener) {
      chrome.tabs.onUpdated.addListener(listener);
      return () => chrome.tabs.onUpdated.removeListener(listener);
    },
    onWindowFocused(listener) {
      const wrapped = (windowId: number) => {
        if (windowId !== chrome.windows.WINDOW_ID_NONE) listener(windowId);
      };
      chrome.windows.onFocusChanged.addListener(wrapped);
      return () => chrome.windows.onFocusChanged.removeListener(wrapped);
    },
    navigate: path => location.replace(chrome.runtime.getURL(path)),
  });
}
