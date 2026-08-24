# Handoff Note — 241306 · gpt · diagnosed-standalone-cors

## Inherited context

Continued from `241126-gpt-complete-web-modes.md`. Standalone development now runs on port 4000, while the extension remains the default target.

## Work done this session

- [x] Traced standalone LLM URL construction through `src/shared/pi-engine.ts`.
- [x] Confirmed that `openAICompletionsApi()` appends `chat/completions` to the configured base URL.
- [x] Sent an actual browser-style `OPTIONS` preflight to OpenCode Zen and confirmed it returns 404 without CORS headers.
- [x] Confirmed that only `serve.mjs` provides the repository's CORS-enabled `/proxy` endpoint.

## Current state

No source files were changed. The reported URL has two independent problems:

1. `https://opencode.ai/zen/go/v1/chat/completions` was configured as a base URL, so the SDK generated `.../chat/completions/chat/completions`.
2. Even the corrected direct base `https://opencode.ai/zen/go/v1` cannot be called from `http://localhost:4000`, because OpenCode Zen does not authorize browser cross-origin requests.

For the current standalone dev setup, run `npm run serve` and configure the web UI Base URL as `http://localhost:7100/proxy`. The proxy adds CORS headers and forwards `/proxy/chat/completions` to the selected upstream.

## Open tasks for the next agent

1. If requested, integrate the proxy into `npm run dev:web` so standalone development needs only one command.

## Key decisions

| Decision | Rationale |
| --- | --- |
| Recommend the repository proxy instead of disabling browser security | CORS authorization must come from the upstream or a same-origin/authorized server; it cannot be safely fixed in frontend JavaScript. |

## Blockers

- Direct browser access to OpenCode Zen is blocked by the upstream's missing CORS/preflight support.

## Suggested next step

Start the local proxy on port 7100 and replace the persisted direct OpenCode Base URL with `http://localhost:7100/proxy`.
