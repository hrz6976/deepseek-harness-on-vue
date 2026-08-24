export const USER_SCRIPT_NETWORK_CHANNEL = 'harness-userscript-network-v1';

export interface UserScriptNetworkRequest {
  channel: typeof USER_SCRIPT_NETWORK_CHANNEL;
  url: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    cache?: RequestCache;
    credentials?: RequestCredentials;
    redirect?: RequestRedirect;
    referrerPolicy?: ReferrerPolicy;
  };
}

export type UserScriptNetworkResponse =
  | { ok: true; value: { body: string; headers: Record<string, string>; redirected: boolean; status: number; statusText: string; url: string } }
  | { ok: false; error: string };

export function isUserScriptNetworkRequest(value: unknown): value is UserScriptNetworkRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UserScriptNetworkRequest>;
  return candidate.channel === USER_SCRIPT_NETWORK_CHANNEL && typeof candidate.url === 'string';
}

export async function fetchForUserScript(
  request: UserScriptNetworkRequest,
  fetcher: typeof fetch = fetch,
): Promise<UserScriptNetworkResponse> {
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('User scripts can only request http(s) URLs.');
    const response = await fetcher(url, request.init);
    return {
      ok: true,
      value: {
        body: await response.text(),
        headers: Object.fromEntries(response.headers),
        redirected: response.redirected,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function withUserScriptNetwork(source: string): string {
  return `
(() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!/^https?:$/.test(url.protocol) || url.origin === location.origin) return nativeFetch(input, init);
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.clone().text();
    const response = await chrome.runtime.sendMessage({
      channel: ${JSON.stringify(USER_SCRIPT_NETWORK_CHANNEL)},
      url: request.url,
      init: {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        ...(body === undefined ? {} : { body }),
        cache: request.cache,
        credentials: request.credentials,
        redirect: request.redirect,
        referrerPolicy: request.referrerPolicy,
      },
    });
    if (!response?.ok) throw new TypeError(response?.error || 'User script network request failed.');
    const value = response.value;
    const emptyBody = value.status === 204 || value.status === 205 || value.status === 304;
    return new Response(emptyBody ? null : value.body, {
      status: value.status,
      statusText: value.statusText,
      headers: value.headers,
    });
  };
})();
${source}`;
}
