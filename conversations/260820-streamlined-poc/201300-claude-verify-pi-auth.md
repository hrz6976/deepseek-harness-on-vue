# Handoff Note — 201300 · claude · verify-pi-auth

## Inherited context

Same session as `201234-claude-complete-phase1.md` (read that first). Its open task #1 — real-API verification — was blocked on a key. User then pointed out pi is configured locally; this note covers wiring the harness to local pi credentials and the live verification that followed.

## Work done this session

- [x] Found local credentials: `~/.pi/agent/auth.json` has api_key entries for `opencode-go` and `minimax-cn` (plus kimi oauth); **no `deepseek` key**. pi's own defaults: provider `opencode-go`, model `deepseek-v4-pro`. The opencode-go catalog serves `deepseek-v4-flash`/`-pro` over openai-completions at `https://opencode.ai/zen/go/v1`.
- [x] `serve.mjs`: reads pi auth at startup (`PI_AUTH_PROVIDER` to force; else prefers `deepseek`, then `opencode-go`), auto-selects the proxy target to match the credential (zen target includes `/v1` so page Base URL stays `/proxy` for both gateways), and injects `Authorization: Bearer <key>` on proxied requests when the browser sent none or the `pi-local` placeholder. A key typed into the page always wins. Key is never logged, never sent to the page.
- [x] `src/plugins/llm.js`: relative baseURL absolutized against `location.origin` (the SDK under pi-ai rejects relative bases); empty apiKey → `pi-local` placeholder.
- [x] `src/plugins/ui/settings.js`: keyless Connect allowed when Base URL starts with `/` (same-origin proxy); auto-reconnect now gated on an explicit `harness.autoconnect` localStorage flag (set on Connect, cleared on Disconnect) instead of inferring from saved key/mock.
- [x] **LIVE end-to-end PASS** (headless Chrome, fresh storage): keyless connect via /proxy → `deepseek-v4-flash` on zen → goal "Use run_js to compute 6*7" → 3 turns (first run_js returned "(no output)" because the model omitted console.log; it self-corrected; result 42; final text "42"), streaming state visible, all proxied requests 200, loop finished cleanly in <5s.
- [x] docs/TESTING.md + README updated (pi-credential setup section; scenario 1 marked live-verified).
- [x] Build + 9/9 kernel tests still green.

## Key decisions

| Decision | Rationale |
|---|---|
| Credential injected server-side by the proxy, not read into the page | Keeps the key out of localStorage/OPFS/page JS entirely — strictly better than the paste-a-key flow for the Phase-1 trust model; `pi-local` placeholder makes the override rule deterministic (never clobbers a real user key) |
| Zen auto-target includes `/v1` | So Base URL `/proxy` works identically for api.deepseek.com (no /v1) and zen (/v1) |
| Preference order deepseek → opencode-go | A native DeepSeek key, if the user adds one later, should win over the gateway |
| Auto-reconnect via explicit flag | Keyless proxy connect made "has saved key" useless as an intent signal |

## Observations for the next agent

- Zen returned **no reasoning_content for deepseek-v4-flash**, so no thinking block live (mock covers the thinking UI). To see live thinking, try `deepseek-v4-pro` (pi's default; `reasoning: true` in the catalog) — one manual run.
- The earlier live-test timeout was a test-script bug (waited for the Run button to re-enable; it stays disabled while the textarea is empty) — the loop itself was already done. Poll `loop.running` via `__harness` instead.

## Open tasks for the next agent

1. TESTING.md scenarios 2 (stop mid-stream) and 8–10 against the live gateway — quick manual runs, spend-conscious.
2. Scenario 13 (forced `new Function`) and 15 (DevTools) — unchanged from the previous note.
3. Optional: `deepseek-v4-pro` run to see live thinking blocks.

## Blockers

- (none)

## Suggested next step

`npm run build && node serve.mjs 7101` → open, leave key empty, Mount, and give it a real multi-file task (e.g. the snake game) on `deepseek-v4-pro`.
