# Handoff Note — 201234 · claude · complete-phase1

## Inherited context

Read `implementation-plan.md` (settled after grill-me + 3-model ensemble review, see `201148-ensemble-plan-review-SUMMARY.md`) and the PoC at `app/index.html`. All settled decisions honored: npm project at repo root, plain JS, esbuild ESM, pi-ai custom provider + mock engine, raw OPFS, everything-is-a-plugin, declarative contributions with prose-in-props, name-keyed fail-loud collector, per-request snapshot, kernel tests + manual test doc.

## Work done this session

- [x] **Step 0 spike PASSED**: pi-ai 0.84.2 bundles clean for browser (esbuild esm/browser; only dead `node:` refs behind `typeof process` guards). Custom provider via `createProvider` + `openAICompletionsApi` honors `baseUrl`, `options.fetch`, `apiKey`; streams token-by-token with thinking + tool calls (verified against a local mock SSE server through the actual bundle).
- [x] Full Phase-1 source tree (23 files, ~1280 lines incl. comments): kernel (6 modules, ~234 lines), capability plugins (fs/tools/prompt/llm/loop/manager), tool plugins (file-editor, run-js, create-plugin, remove-plugin), UI plugins (settings/chat/files/preview/syslog), standalone entry, build.mjs, serve.mjs.
- [x] `tests/kernel.test.js`: 9 node:test tests, all passing (waterfall order/veto/double-next, collector duplicate/token-guard/snapshot, services token-guard, translateESM dialect, normalizePluginDef).
- [x] **Playwright smoke test in real Chrome: 21/21 checks** (mock engine): boot, panels, mock agent round through a REAL run_js Worker (returns 42), thinking UI, create_plugin runtime compile + panel + tool + prompt section, OPFS restore after refresh, HMR hot-reload, broken-source rollback with badge, cross-plugin duplicate-name loud failure, remove_plugin full reclamation, zero unexpected console errors. Script: scratchpad `smoke.mjs` (session-temp; not committed).
- [x] Docs: `docs/cordis-to-vue.md` (mapping table ported to module paths + what the rewrite added), `docs/TESTING.md` (15 scenarios, ✅ marks what the smoke run already covered, ported-invariants list), `README.md`.
- [ ] NOT done: real-key end-to-end against api.deepseek.com (needs the user's key); Vue DevTools spot-check; Phase 2 entirely.

## Current state

`npm run build` green (dist/main.js 1.1MB dev, unminified), `npm test` 9/9. Dev flow: `npm run dev` (or `npm run build && node serve.mjs 7100`). NOTE: an old PoC server (pid 73533, from `app/`) was still holding port 7100 during this session — kill it or use another port.

| Path | What |
|---|---|
| `src/kernel/{log,services,bus,collector,host,compile}.js` | the presentable core; bus has `useToolGuard`/`useRequestTransform` sugar |
| `src/plugins/{fs,tools,prompt,llm,loop,manager}.js` | capability plugins; tools/prompt each expose component + composable faces |
| `src/plugins/tools/*.js`, `src/plugins/ui/*.js` | contribution + panel plugins; templates are the manifests |
| `src/entries/standalone/{index.html,main.js}` | layout frame, `__harness` global, built-in mounts |
| `build.mjs`, `serve.mjs`, `package.json` | esbuild (vue aliased to esm-bundler, ESM out), dev server with `/proxy` |
| `tests/kernel.test.js`, `docs/{TESTING,cordis-to-vue}.md` | tests + docs |

## Key decisions (made autonomously where the plan was silent)

| Decision | Rationale |
|---|---|
| Collector duplicate policy: same-plugin re-add replaces, cross-plugin throws | Implements the ensemble resolution; robust to Vue's mount-new-before-unmount-old ordering because removal is token-guarded. Cost: a true duplicate *within one plugin* replaces silently — documented, acceptable |
| Kernel functions return explicit dispose fns; `onUnmounted` auto-wired only when inside a component | Makes the kernel testable in bare Node (no DOM/happy-dom dep); the Vue wiring is one trusted line each |
| `collector.add(name, def, owner?)` third param | Test seam for owner attribution; runtime callers rely on injected `pluginName` from PluginHost |
| Custom pi-ai provider id = `"deepseek"` even behind proxy URLs | pi-ai's `detectCompat` keys on provider id OR baseUrl; id keeps DeepSeek compat (thinking format, `max_tokens` field, reasoning_content-on-assistant) working through `/proxy` |
| Idle watchdog wraps the pi-ai event stream in `llm.js` (45s) | Verified pi-ai has NO idle-stream guard (`timeoutMs` = SDK request timeout only); watchdog + transport errors surface as `{type:'error'}` events, not loop crashes |
| Mock engine calls `run_js` only if that tool is actually registered | Keeps the canned round exercising the real pre-execute→call→result path without hard dependency |
| `formatVersion` = `.plugins/.format` file (manager-owned), current `"1"` | Mismatch skips restore but KEEPS files; plan had it under fs.js but it's a manager concern |
| Settings auto-reconnects LLM on boot when key/mock saved (deferred to `onMounted`+`nextTick`) | Refresh restores plugins AND connection — better demo UX; no request is sent until the user runs. Deferral needed: mountPlugin mutates the array the frame is iterating |
| compile.js re-throws `SyntaxError` instead of trying `new Function` fallback | A parse error fails both paths; falling through would mask the real error with a translateESM artifact |
| English UI/comments/prompts (PoC was Chinese) | Matches the plan doc language and this thread's working language |
| `serve.mjs` default proxy target `https://api.deepseek.com` (PoC used opencode zen) | Matches the "DeepSeek official" default cfg; zen still works via `LLM_PROXY_TARGET` + Base URL `/proxy/v1` |
| Kernel is 234 lines vs ≤200 soft budget | Overage is comments carrying the hard-won trap explanations; plan says soft, not gated |

## Open tasks for the next agent

1. **Real-key verification** (user must supply key): `node serve.mjs 7100`, Base URL `/proxy`, model `deepseek-v4-flash` (or current), run TESTING.md scenarios 1–2 and 8–10 against the live API. Watch for: DeepSeek rejecting `reasoning: true` models without thinking support — if the chosen model has no reasoning, thinking events simply won't appear (harmless).
2. TESTING.md scenario 13 (forced `new Function` path) and 15 (DevTools instance visibility) — 10 minutes in DevTools.
3. Consider `--minify` production build target in build.mjs (1.1MB dev is fine for demos; not for Phase 2 userscript).
4. Phase 2 (userscript): start from `implementation-plan.md` §Phase 2 outline. The GM fetch shim is the top risk; `llm.stream()` is already the sole transport boundary and `cfg.fetch` already plumbs through to pi-ai.

## Blockers

- (none for the code) Real-API run blocked only on an API key.

## Suggested next step

Run `npm run build && node serve.mjs 7101`, open http://localhost:7101, tick mock engine → Mount → run "build yourself a dice plugin" to see the whole self-modification story; then repeat with a real key for scenarios 1–2.
