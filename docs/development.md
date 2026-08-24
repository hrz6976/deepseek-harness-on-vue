# Development environment

Three processes make up the interactive dev loop for the Chrome extension:

| Command | Port | Purpose |
|---|---|---|
| `npm run dev` / `npm run web:ext` | 5173 | CRXJS + Vite dev server: HMR for side panel / options / sandbox / service worker |
| `npm run dev:web` | 4000 | Standalone Vue web app with HMR |
| `npm run bridge` | 8787 | Local multi-provider AI Bridge; reads git-ignored credentials from `bridge/.env` |
| `npm run serve` | 4000 | Built standalone web app only; run `npm run build:standalone` first |
| `npm run dev:fixtures` | 5174 | Test host pages: `/legacy-host/` (static) and `/react-host/` (React 19 reconciliation demo) |

## Setup

1. Start `npm run dev`, `npm run bridge`, and `npm run dev:fixtures` (each in its own terminal, or backgrounded).
2. `chrome://extensions` → Developer mode → **Load unpacked** → select `dist/extension`
   (CRXJS writes a dev manifest there pointing pages at `localhost:5173`).
3. Extension **Options** → LLM config:
   - Base URL `http://localhost:8787/v1`.
   - Leave the API key empty in local Bridge mode; provider keys stay in `bridge/.env`.
   - `deepseek-v4-flash`, `deepseek-v4-pro`, `kimi-k2.7-code`, and `kimi-k3`
     route through the configured `opencode-go` provider.
4. Open a fixture tab → click the extension icon → **Authorize & read** → snapshot /
   patch / verify / revert.
5. For `page/eval` only: enable "Allow user scripts" in the extension's details page.

## Known gotchas (and their fixes, already applied)

### 1. Vite binds IPv6-only → intermittent 504s in Chrome

**Symptom**: random `504` fetching extension scripts, or CRXJS's "Cannot connect to
http://localhost:5173/…" interstitial — while `curl http://localhost:5173/` works.

**Cause**: Vite's default host can land on `::1` only. macOS resolves `localhost` to
either stack depending on resolution order, so Chrome intermittently tries
`127.0.0.1`, gets connection-refused, and surfaces proxy-style errors.

**Fix (applied)**: `server.host: true` in `vite.config.ts` binds all interfaces.
Verify with `curl` against both `localhost` and `127.0.0.1`.

### 2. CRXJS 2.7.1 `__LIVE_RELOAD__` ReferenceError

**Symptom**: `Uncaught (in promise) ReferenceError: __LIVE_RELOAD__ is not defined`
whenever the HMR socket closes (server restart, laptop sleep).

**Cause**: CRXJS's worker HMR client contains the token twice, but its replacement
uses `String.replace()` with a string pattern — first occurrence only. The second
occurrence (socket-close handler) stays literal.

**Fix (applied)**: `crxLiveReloadFixup()` plugin in `vite.config.ts` (serve-only)
replaces all remaining occurrences at transform time.

### 3. WS handshake 400 after restarting the dev server

**Symptom**: `WebSocket connection to 'ws://localhost:5173/?token=…' failed:
Unexpected response code: 400`.

**Cause**: Vite rotates the HMR token on every server start; Chrome caches the
client-worker (with the old token) until the extension reloads.

**Fix (applied)**: `pinWebSocketToken()` in `vite.config.ts` pins the token via
`configResolved` (Vite 8 has no input option for it anymore), so restarts no
longer invalidate the extension. One manual extension reload is needed after
changing this setting; after that, server restarts are transparent.

### 4. Sandbox page fails to load in dev: production CSP blocks the dev server

**Symptom**: the sandbox side of the panel shows CRXJS's "Failed to load the
script" / "Cannot connect" interstitial even though `curl` serves the page fine.

**Cause**: CRXJS never patches manifest CSPs, and our hardened production sandbox
CSP (`script-src 'self'; connect-src 'none'`) forbids everything dev mode needs:
fetching the real page + modules from `localhost:5173` and the HMR websocket.
Production builds are unaffected because they inline all assets under `'self'`.

**Fix (applied)**: in dev (`command === 'serve'`) only, `vite.config.ts` injects
`http://localhost:5173` into both CSPs' `script-src`, and adds
`http://localhost:5173 ws://localhost:5173` to the sandbox's `connect-src`
(`ws://` in `script-src` is rejected by Chrome as an insecure CSP value;
websockets are governed by `connect-src`). Production builds keep the hardened
CSP unchanged.

## Other behaviors to know

- Editing `src/plugins/*.ts` rebuilds the embedded defaults, but OPFS seeding is
  write-if-missing: an existing browser profile keeps its old copies. Reseed via
  the sandbox URL `?reset` param (or remove + re-add the extension).
- Opening the side panel on non-http(s) tabs (e.g. `chrome://extensions`) throws
  "not bound to an inspectable tab" — that is the intended guard, not a bug.
- The HMR token rotates per server start; expect one extension reload per restart.
- If CRXJS dev mode ever becomes unusable, the fallback is `npm run watch`
  (static rebuild, no dev server): no HMR, but zero network dependencies —
  edit → wait for rebuild → reload the extension manually.
