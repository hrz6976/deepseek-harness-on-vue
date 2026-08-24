# Handoff Note — 241334 · gpt · fixed-bridge-cors

## Inherited context

Continued from `241126-gpt-complete-web-modes.md`, `241306-gpt-diagnosed-standalone-cors.md`, and `241315-gpt-complete-proxy-split.md`. The standalone app runs on port 4000. During this continuation, the custom repository proxy was replaced by the untracked `bridge/` package, local reusable pi API-key credentials were migrated into git-ignored `bridge/.env`, and the page endpoint moved to `http://localhost:8787/v1`.

## Work done this session

- [x] Removed the unconfigured `modelhub-sg`, `modelhub-trae`, `modelhub-cn`, and `deepseek` providers from `bridge/bridge.config.json`.
- [x] Removed all model entries and the catch-all fallback that depended on those providers.
- [x] Left only `openrouter`, `opencode-go`, and `minimax-cn`, backed by the migrated pi credentials.
- [x] Updated Bridge documentation, environment example, and routing tests to match the reduced config.
- [x] Fixed browser CORS preflight for `pi-ai` by reflecting `Access-Control-Request-Headers` only after validating the request origin.
- [x] Added a regression test covering `http://127.0.0.1:4000` with `x-stainless-os` and `x-stainless-runtime`.
- [x] Verified Bridge startup has no missing-key warnings and stopped the smoke-test process afterward.

## Current state

| File | Change |
| --- | --- |
| `bridge/bridge.config.json` | Three credential-backed providers, seven explicit models, and two valid fallbacks. |
| `bridge/bridge.js` | Loopback-only server with approved-origin CORS and dynamic preflight header reflection. |
| `bridge/test.cors.js` | Starts an isolated Bridge instance and verifies the pi-ai preflight contract. |
| `bridge/test.e2e.js` | Updated fallback probes for OpenCode-backed models. |
| `bridge/package.json` | Offline config and CORS tests run under `npm test`; live upstream probes remain opt-in. |
| `bridge/.env.example`, `bridge/README.md` | Removed stale ModelHub/DeepSeek key documentation and documented current providers. |

Verification:

- `npm --prefix bridge test`: 12/12 routing checks plus CORS regression pass.
- `npm --prefix bridge audit --omit=dev`: 0 vulnerabilities after compatible dependency updates.
- `npm run check`: 69 tests, typecheck, extension build, standalone build, and fixtures build all pass.
- Config integrity: 3 providers, 7 models, no dangling references.
- Port 8787 is free at handoff; run `npm run bridge` before using the page.

## Open tasks for the next agent

1. None required for this fix. If a browser still has an old endpoint in localStorage, reconnect using `http://127.0.0.1:8787/v1` after starting Bridge.

## Key decisions

| Decision | Rationale |
| --- | --- |
| Reflect requested CORS headers only for allowed origins | Supports current and future Stainless SDK metadata headers without granting arbitrary origins access. |
| Keep Bridge bound to `127.0.0.1` by default | Provider credentials should not be exposed to the LAN. |
| Remove every model and fallback tied to missing credentials | Prevents startup warnings and avoids advertising routes that cannot succeed. |
| Do not copy Kimi OAuth into `.env` | It is expiring session state; Kimi coding models remain available through the static OpenCode credential. |

## Blockers

- (none)

## Suggested next step

Run `npm run bridge`, keep it running, then reload the standalone page on port 4000 and reconnect.
