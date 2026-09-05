export const PUBLIC_WEB_ORIGIN_PATTERNS = ['http://*/*', 'https://*/*'] as const;

export interface WebLink {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchResponse {
  type: 'search_results';
  query: string;
  searchUrl: string;
  pageTitle: string;
  results: WebLink[];
}

export interface WebPageResponse {
  type: 'page';
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  links: WebLink[];
}

/** Serialized into the temporary search tab; keep this function self-contained. */
export function extractSearchResults(limit: number): WebLink[] {
  const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/gu, ' ').trim();
  const unwrap = (href: string): URL | null => {
    let target: URL;
    try { target = new URL(href, window.location.href); }
    catch { return null; }
    if (!/^https?:$/u.test(target.protocol)) return null;
    if (target.origin === window.location.origin) {
      for (const parameter of ['q', 'url', 'uddg', 'target']) {
        const candidate = target.searchParams.get(parameter);
        if (!candidate) continue;
        try {
          const decoded = new URL(candidate);
          if (/^https?:$/u.test(decoded.protocol)) return decoded;
        } catch { /* Not an absolute result URL. */ }
      }
      return null;
    }
    return target;
  };

  const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')];
  anchors.sort((left, right) => Number(Boolean(right.querySelector('h1,h2,h3'))) - Number(Boolean(left.querySelector('h1,h2,h3'))));
  const results: WebLink[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const target = unwrap(anchor.href);
    if (!target || seen.has(target.href)) continue;
    const heading = anchor.querySelector('h1,h2,h3');
    const title = clean(heading?.textContent ?? anchor.textContent ?? anchor.getAttribute('aria-label'));
    if (title.length < 3) continue;
    const container = anchor.closest('article, li, .g, .b_algo, .result, [data-sokoban-container]') ?? anchor.parentElement;
    const rawSnippet = clean((container as HTMLElement | null)?.innerText ?? container?.textContent)
      .replace(title, '').trim();
    seen.add(target.href);
    results.push({ title: title.slice(0, 300), url: target.href, ...(rawSnippet ? { snippet: rawSnippet.slice(0, 700) } : {}) });
    if (results.length >= limit) break;
  }
  return results;
}

/** Serialized into an arbitrary public page; keep this function self-contained. */
export function extractReadablePage(maxChars: number): Omit<WebPageResponse, 'type'> {
  const clean = (value: string | null | undefined) => (value ?? '')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const root = document.querySelector('main, article, [role="main"]') ?? document.body;
  const text = clean((root as HTMLElement | null)?.innerText ?? root?.textContent);
  const links: WebLink[] = [];
  const seen = new Set<string>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    let target: URL;
    try { target = new URL(anchor.href, window.location.href); }
    catch { continue; }
    if (!/^https?:$/u.test(target.protocol) || seen.has(target.href)) continue;
    const title = clean(anchor.textContent ?? anchor.getAttribute('aria-label'));
    if (!title) continue;
    seen.add(target.href);
    links.push({ title: title.slice(0, 300), url: target.href });
    if (links.length >= 60) break;
  }
  return {
    url: window.location.href,
    title: document.title,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    links,
  };
}

async function withTemporaryTab<T>(ownerTabId: number, url: string | undefined, signal: AbortSignal | undefined, read: (tabId: number) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const owner = await chrome.tabs.get(ownerTabId);
  signal?.throwIfAborted();
  const tab = await chrome.tabs.create({ ...(url ? { url } : {}), active: false, windowId: owner.windowId });
  if (tab.id == null) throw new Error('Chrome did not create a temporary web tab.');
  const close = () => { void chrome.tabs.remove(tab.id!).catch(() => undefined); };
  signal?.addEventListener('abort', close, { once: true });
  try { signal?.throwIfAborted(); return await read(tab.id); }
  finally { signal?.removeEventListener('abort', close); await chrome.tabs.remove(tab.id).catch(() => undefined); }
}
export function searchWebInBackground(ownerTabId: number, query: string, limit = 5, signal?: AbortSignal): Promise<WebSearchResponse> {
  return withTemporaryTab(ownerTabId, undefined, signal, async tabId => {
    await chrome.search.query({ text: query, tabId });
    const loaded = await waitForPublicPage(tabId, signal);
    signal?.throwIfAborted();
    const [{ result = [] } = {}] = await chrome.scripting.executeScript({
      target: { tabId }, func: extractSearchResults, args: [Math.max(1, Math.min(10, Math.trunc(limit)))],
    });
    return { type: 'search_results', query, searchUrl: loaded.url ?? '', pageTitle: loaded.title ?? '', results: result };
  });
}
export function openWebPageInBackground(ownerTabId: number, url: string, maxChars = 20_000, signal?: AbortSignal): Promise<WebPageResponse> {
  const target = new URL(url);
  if (!/^https?:$/u.test(target.protocol)) throw new Error('web_open accepts only http(s) URLs.');
  return withTemporaryTab(ownerTabId, target.href, signal, async tabId => {
    await waitForPublicPage(tabId, signal);
    signal?.throwIfAborted();
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId }, func: extractReadablePage, args: [Math.max(1_000, Math.min(60_000, Math.trunc(maxChars)))],
    });
    if (!result) throw new Error('The page did not return readable content.');
    return { type: 'page', ...result };
  });
}

async function waitForPublicPage(tabId: number, signal?: AbortSignal, timeoutMs = 20_000): Promise<chrome.tabs.Tab> {
  const ready = (tab: chrome.tabs.Tab) => tab.status === 'complete' && /^https?:/u.test(tab.url ?? '');
  const current = await chrome.tabs.get(tabId);
  signal?.throwIfAborted();
  if (ready(current)) return current;
  return await new Promise<chrome.tabs.Tab>((resolve, reject) => {
    const timer = setTimeout(() => finish(undefined, new Error('Timed out waiting for the web page.')), timeoutMs);
    const onUpdated = (updatedTabId: number, _change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (updatedTabId === tabId && ready(tab)) finish(tab);
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish(undefined, new Error('The temporary web tab was closed before it loaded.'));
    };
    const cancel = () => finish(undefined, new Error('Web request cancelled.'));
    const finish = (tab?: chrome.tabs.Tab, error?: Error) => {
      signal?.removeEventListener('abort', cancel);
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error); else resolve(tab!);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}
