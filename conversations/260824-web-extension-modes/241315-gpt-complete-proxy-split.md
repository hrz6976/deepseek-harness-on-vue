# Handoff Note — 241315 · gpt · complete-proxy-split

## Inherited context

Continued from `241126-gpt-complete-web-modes.md` and `241306-gpt-diagnosed-standalone-cors.md`. The web dev server runs on 4000, and browser-side model requests require a local CORS-enabled proxy.

## Work done this session

- [x] Extracted the pi credential loading and streaming proxy implementation from `serve.mjs` into `scripts/pi-proxy.mjs`.
- [x] Added the proxy-only `proxy.mjs` entry point.
- [x] Added `npm run proxy` without coupling it to Vite or static web hosting.
- [x] Preserved `npm run serve` as the combined built-web-plus-proxy production server using the shared implementation.
- [x] Added tests for port resolution, CORS preflight, URL/query forwarding, request bodies, header stripping, and local credential injection.
- [x] Updated README and development documentation.
- [x] Smoke-tested both proxy-only and combined server entry points.
- [x] Ran the complete repository check successfully.

## Current state

| File | Change |
| --- | --- |
| `proxy.mjs` | Proxy-only executable with `/proxy/*`, `/health`, and no frontend file serving. |
| `scripts/pi-proxy.mjs` | Shared credential discovery, CORS, streaming forwarding, upstream selection, and port parsing. |
| `serve.mjs` | Static standalone server now delegates `/proxy/*` to the shared proxy module. |
| `package.json` | Added `npm run proxy`. |
| `tests/pi-proxy.test.ts` | Added two proxy behavior tests. |
| `README.md`, `docs/development.md` | Documented proxy-only and combined server workflows. |

Verification:

- `npm run check` passes: TypeScript, 71 tests, extension build/verifier, standalone build, and fixture build.
- `npm run proxy -- 7111` served `/health`, returned 404 for `/`, and returned a valid 204 CORS preflight for `/proxy/chat/completions`.
- `npm run serve -- 7112` served the standalone build and the same valid proxy preflight.

The pre-existing `package-lock.json` modification and unrelated untracked `.agents/` / `.claude/` directories were preserved.

## Open tasks for the next agent

1. None required. If requested, add a Kimi provider mapping for keyless credential discovery; explicit `LLM_PROXY_TARGET` plus a page-supplied Kimi key already works.

## Key decisions

| Decision | Rationale |
| --- | --- |
| Share the proxy implementation between two entry points | Avoids behavior drift while separating development proxy use from production static hosting. |
| Keep `npm run serve` | Preserves the existing built standalone deployment workflow. |
| Make `npm run proxy` serve no frontend files | Directly matches the requested standalone Node proxy process. |
| Strip hop-by-hop and stale content-length/content-encoding headers | Node fetch can decode/reframe bodies; forwarding stale transport headers can corrupt streaming responses. |

## Blockers

- (none)

## Suggested next step

Run `npm run dev:web` and `npm run proxy` in separate terminals, then set the standalone Base URL to `http://localhost:7100/proxy`.
