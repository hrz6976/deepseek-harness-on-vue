# TESTING — manual test document

Standalone and Chrome-extension verification: per-feature manual steps and expected observations.

## Chrome extension smoke test

```bash
npm run check
# Chrome → chrome://extensions → Developer mode → Load unpacked
# choose dist/extension
```

1. Open a normal HTTP(S) page and click the extension action. The side panel should boot the sandboxed harness and seed builtin sources into extension OPFS.
2. On a new origin, click the trusted **授权并读取** banner. Expect one origin-scoped permission prompt followed by an automatic compressed snapshot. Reopening that origin should not prompt again.
3. Click **批注**, then click a page element and save a note. Expect the closed-Shadow-DOM composer, a visible annotation count above the Harness input, and the next vague user message to resolve against the annotation's selector/fingerprint without another broad snapshot.
4. Configure an OpenAI-compatible endpoint in **设置**, then ask the agent to inspect the page. Expect assistant text to update incrementally; user messages, page events, annotations, patch results, and final replies must stay in actual occurrence order. The key must not appear in sandbox storage or page messages.
5. Ask for a patch. Expect preview before apply, per-operation verification, and a transaction id that can be reverted.
6. Save the approved operations as a recipe, click **授权本站**, refresh or navigate through an SPA route, and expect the recipe to reapply.
7. Automated Happy DOM coverage exercises snapshot/query, apply/verify/revert, node-identity-preserving undo, sanitization, rollback, and real React reconciliation (`tests/extension-content.test.ts`).
8. Keep the panel open, switch between two HTTP tabs, and expect distinct fresh conversations. Switching back restores that tab's panel instance. On `chrome://newtab`, the Harness panel should be unavailable rather than retaining another tab's errors.

## Setup

```bash
npm install
npm run build          # or: npm run watch
node serve.mjs 7100    # dist/ + /proxy → https://api.deepseek.com (override: LLM_PROXY_TARGET)
# then open http://localhost:7100
```

- **Real engine**: Base URL `/proxy`, model e.g. `deepseek-v4-flash`, paste an API key, Mount LLM plugin. (Direct `https://api.deepseek.com` fails CORS in browsers by design — that's what /proxy is for. Explicit gateway override: `LLM_PROXY_TARGET=... node serve.mjs`.)
- **Local pi credentials (keyless)**: if `~/.pi/agent/auth.json` exists, serve.mjs picks an api_key credential (`PI_AUTH_PROVIDER` to force one; else deepseek, then opencode-go), auto-targets the matching gateway, and injects the Bearer token server-side whenever the page sends no key (the page uses a `pi-local` placeholder). Leave the API key field EMPTY, Base URL `/proxy`, Mount. The key never enters the browser.
- **Mock engine**: tick "mock engine", Mount. No key, no network; drives a canned `run_js` round + streamed text through the entire real pipeline.
- Automated coverage: `npm test` (kernel logic); scenarios marked ✅ below were also verified by Playwright smoke runs on 2026-08-20. The former broad `__harness` diagnostic API has since been removed; only the frozen public plugin module map remains global.

## Scenarios

1. **Connect → streaming.** Mount LLM, run a goal. Expect: text token-by-token; thinking block collapsible (auto-open while streaming) *when the model/gateway emits reasoning content*; tool cards form *during* the stream. ✅ (mock; and LIVE 2026-08-20: `deepseek-v4-flash` via opencode zen with keyless pi credential — 3-turn run_js round returning 42; no reasoning content came back from zen for flash, so no thinking block, expected)
2. **Stop mid-stream.** Click Stop during generation. Expect: network request actually aborts (DevTools Network shows cancelled), loop exits with a "stopped" note, no stuck blinking cursor.
3. **`create_plugin` with UI + tool.** Ask the agent to build a Cordis capability (e.g. dice tool + panel). Expect its `apply(ctx)` to call `ctx.tools.register`, `ctx.prompt.register`, and `ctx.ui.register`; the panel appears immediately, the tool is callable next turn, and its prompt section is present in the next request.
4. **Refresh → restore.** Reload the page. Expect: dynamic plugin auto-restores from OPFS (syslog: "restored dynamic plugin …"); with saved key/mock, the LLM auto-reconnects. ✅
5. **HMR.** Edit `.plugins/<name>.js` via file_editor (or ask the agent to). Expect: ~300ms later the plugin hot-reloads; old UI/tools gone, new ones live; syslog "HMR: … hot-reloaded". ✅
6. **HMR rollback.** Write syntactically broken source to `.plugins/<name>.js`. Expect: old version keeps running, "HMR failed, old version running" badge, error in syslog; writing good source again recovers. ✅
7. **`remove_plugin`.** Expect: panel, tools, prompt section, listeners all gone; no DOM residue; `.plugins/<name>.js` deleted. ✅
8. **Waterfall veto.** Create a Cordis guard plugin whose `apply(ctx)` registers `ctx.on('tools/pre-execute', (req, next) => req.name === 'run_js' ? Object.assign(req, { veto: 'disabled by policy' }) : next())`. Expect the next `run_js` call to be blocked; disposing the guard Fiber re-enables it.
9. **Conditional contribution.** Register a tool inside a child `ctx.plugin()` or a `ctx.effect()` controlled by a UI toggle. Expect disposal to remove the tool from the NEXT request snapshot and reactivation to add it again. No null-rendering Vue contribution component should exist.
10. **Kill the proxy.** Stop serve.mjs mid-session, run a goal. Expect: LLM error lands as a note (with CORS/proxy hint when relevant); harness stays fully usable; restarting the proxy recovers.
11. **Mock engine end-to-end.** No key, no proxy: mock drives a canned tool round (a REAL `run_js` Worker execution returning `42`) + streamed text. ✅
12. **Duplicate name.** A second Fiber declaring tool `x` while another owns it fails loudly with `duplicate tool "x"`; no silent shadowing. Same-Fiber replacement is token-guarded, while HMR first disposes the previous Fiber.
13. **Forced `new Function` path.** Simulate Blob-import failure (e.g. DevTools overrides blocking `blob:`, or temporarily patch `URL.createObjectURL` to throw) and load a canonical-dialect plugin. Expect: it still loads via `translateESM` + `new Function`. The *dialect subset* itself is covered by `npm test`; note the fallback deliberately re-throws real `SyntaxError`s.
14. **Mid-turn removal race (snapshot).** While the model is streaming a turn that will call tool `t`, remove the plugin owning `t`. Expect: the in-flight turn still executes `t` against the request snapshot; `t` is absent from the *next* request.
15. **DevTools claim.** Vue DevTools shows only actual contributed panels. Use the capability inspector and Cordis diagnostics exposed through trusted development tooling; the sandbox global must not expose root Cordis or mount/unmount.
16. **Compaction (forced).** Mount the mock engine, lower the compaction threshold through the settings UI/development fixture, then run a second goal. Expect: a "compacting…" note, then a collapsed summary card replacing older messages and the run continuing normally. ✅ (mock, real Chrome, 9/9 script checks 2026-08-20)
17. **Compaction (live).** Long multi-file session against a real endpoint until `~112k` ctx (or crank `reserveTokens` as above to force it early). Expect: same as 16, one summarization request on the wire (tool-less, "context summarization assistant" system prompt), and the agent still knows the goal afterwards. Not yet run live.

18. **Readable component state (`expose()` → `read_state`).** Ask the agent to build a plugin with interactive UI state, interact with it, then ask the agent to read the current state. Expect explicit `expose()` state to be visible through `read_state`, unexposed state to remain absent, and HMR/removal to clean the registry. ✅ (15/15 Playwright checks 2026-08-20)

19. **Capability cold boot.** Fresh profile (or after `?reset`): open the app. Expect `.plugins/` to receive shipped capability sources and auto-mounted capabilities to compile through the dynamic pipeline. Framework services (`fs`, `tools`, `prompt`, `manager`, `task-runtime`, `state`, `loop`) are bundled Cordis Fibers and must not appear in OPFS; `llm.js` remains seeded but unmounted until Settings connects (`autoMount: false`).
20. **Shipped capability is agent-editable.** Edit a shipped non-system capability's source in `.plugins/` (e.g. change `run-js.js`'s tool description) via file_editor or console. Expect: HMR hot-reload ~300ms later, the change visible in the next request's tool schemas; the edit SURVIVES a page refresh. Attempts to overwrite a reserved framework path such as `.plugins/loop.js` through workspace tools must fail. Broken capability edits roll back exactly like scenario 6. ✅
21. **Broken core plugin at boot → fail-soft; `?reset` recovers.** Leave syntactically broken source in `.plugins/chat.js` and refresh. Expect: boot logs the compile failure, skips chat, everything else comes up (no white page). `?reset` wipes `.plugins/`, reseeds factory sources, and strips itself from the URL; localStorage (connection config) survives; files outside `.plugins/` survive. ✅
22. **HMR deferred during a run.** While the agent is mid-run, edit any mounted plugin's file. Expect: syslog "changed during a run — reload deferred", no remount until the run ends, then the reload flushes. (Node-tested in `tests/boot.test.js`; manual spot-check optional.)

## Ported invariants (do not silently drop)

- Request filter: `note` messages and `streaming`/`error` partials never reach the model; `summary` checkpoints DO (`loop.js`, `llm.js`).
- Turn ceiling is a FAILSAFE (500), not a control: stopping is the Stop button's job, context size is the compaction plugin's job (`loop.js`).
- Compaction never destroys data uncompensated: the splice happens only after the summarizer returned non-empty text; summarizer failure = loud note, log untouched (`compaction.js`).
- The summarizer request bypasses the `llm/request` waterfall (plugins that rewrite agent requests must not touch it) and carries `tools: []` (`compaction.js`).
- Tool results truncate at **8000 chars** before entering history (`loop.js`).
- Every assistant `toolCall` is followed by a matching `toolResult`; aborted ones get the `(aborted, not executed)` stub (`llm.js`, `toPiMessages`).
- Idle watchdog: 45s with no stream data ⇒ error, not a hang (`llm.js` — pi-ai has no idle guard of its own; its `timeoutMs` is an SDK request timeout).
- Duplicate contribution names throw across Fibers; same-Fiber replacement and cleanup are token-guarded (`tools.js`, `prompt.js`, `ui.js`).
- Cordis owns service, event, contribution, watcher, and resource cleanup; `await fiber.dispose()` completes asynchronous LIFO teardown before host metadata is removed. The exposed-state capture remains token-guarded (`ui.js`).
- Agent-readable state is opt-in: only `ctx.expose({...})` makes it visible; reads happen at call time (live), serialize as JSON (refs unwrapped, functions dropped, circular → error string), and cap at the same **8000 chars** as tool results (`state.js`).
- `create_plugin` compile-probes BEFORE persisting or mounting; broken source is never written (`manager.js`).
- Shipped and agent-created capabilities load from `.plugins/` through the same runtime compile path. Framework services are bundled system Fibers; boot removes legacy OPFS copies of their reserved names. Capability seeding is **write-if-missing** — agent modifications are never clobbered; `?reset` is the capability factory-reset escape hatch and keeps localStorage (`runtime-supervisor.js`, `boot.js`).
- Plugin imports are pinned to the public registry (`vue`, Cordis, Zod, pi-ai, `@harness/sdk`); kernel/shared and cross-plugin imports fail loud at compile (`compile.js`, `modules.js`).
- Contribution services are Cordis services. Caller-context tracing makes every `ctx.tools/prompt/ui.register()` effect belong to the calling Fiber, not the registry provider (`tools.js`, `prompt.js`, `ui.js`).
- Hot reloads are deferred while the loop runs and flushed after — no remounting live machinery mid-run (`manager.js`).
- `llm` is seeded but `autoMount: false`; settings mounts it via `manager.mount('llm', { cfg })`, Cordis passes config to `apply(ctx, config)`, and `manager.unmount` keeps the file without surprise-remounting after a later edit (`boot.js`, `manager.js`).
- There is no persisted source-format gate while the project is pre-release. Corrupt plugin files fail soft and can be cleaned up via `remove_plugin` even when not running (`boot.js`, `manager.js`); `?reset` reseeds shipped sources.
- API key: localStorage only, closure-captured in the llm plugin, never exposed through the service object, never written to OPFS.
- Session reset keeps `.plugins/` (chat.js) — plugins survive "Clear session & files".
