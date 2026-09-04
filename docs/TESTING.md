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
4. Configure one or more OpenAI-compatible Provider Profiles in **设置**, select a profile/model for the task, then ask the agent to inspect the page. Expect assistant text to update incrementally; user messages, page events, annotations, patch results, and final replies must stay in actual occurrence order. Profile summaries may cross into the sandbox, but endpoint credentials must not appear in sandbox storage or page messages.
5. Ask about an element's layout or a `::before`/`::after` decoration. Expect `page_style_inspect` to return computed values plus readable matching rules without a confirmation dialog or `page_script_run`.
6. Ask for a patch. Expect preview before apply, per-operation verification, and a transaction id that can be reverted.
7. Save the approved operations as a recipe, click **授权本站**, refresh or navigate through an SPA route, and expect the recipe to reapply.
8. Automated Happy DOM coverage exercises snapshot/query/style inspection, apply/verify/revert, node-identity-preserving undo, sanitization, rollback, and real React reconciliation (`tests/extension-content.test.ts`).
9. Keep the panel open, switch between two HTTP tabs, and expect distinct live panel instances. Switching back restores that tab's panel. On `chrome://newtab`, expect the inert “Harness 等待网页” fallback with no previous conversation or errors; navigating that tab to HTTP(S) must boot a panel bound to the new tab id.

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
17. **Compaction (live).** Long multi-file session against a real DeepSeek V4 endpoint until `~840k` ctx (or lower `safetyTokens`/the test model limits to force it early). Expect: same as 16, one summarization request on the wire (tool-less, "context summarization assistant" system prompt), and the agent still knows the goal afterwards. Not yet run live.

18. **Readable component state (`expose()` → `read_state`).** Ask the agent to build a plugin with interactive UI state, interact with it, then ask the agent to read the current state. Expect explicit `expose()` state to be visible through `read_state`, unexposed state to remain absent, and HMR/removal to clean the registry. ✅ (15/15 Playwright checks 2026-08-20)

19. **Capability cold boot.** Fresh profile (or after `?reset`): open the app. Expect `.plugins/` to receive shipped capability sources and auto-mounted capabilities to compile through the dynamic pipeline. Framework services (`fs`, `ui`, `tools`, `prompt`, `manager`, `task-runtime`, `loop`) are bundled Cordis Fibers and must not appear in OPFS; protected `llm.js` remains seeded but unmounted until Settings connects (`autoMount: false`).
20. **Editable versus protected shipped capabilities.** Edit an editable shipped capability such as `.plugins/run-js.js`. Expect HMR ~300ms later, the next request to see the new schema, and the edit to survive refresh. Attempts to write/remove `.plugins/loop.js` or `.plugins/page.js`, and every direct mutation under manager-owned `.harness/...`, must fail at the workspace provider even through a custom writer capability. Protected on-demand `llm` must mount from its embedded source; create/remove/self-HMR attempts fail. Broken editable capability edits roll back exactly like scenario 6. ✅
21. **Broken core plugin at boot → fail-soft; `?reset` recovers.** Leave syntactically broken source in `.plugins/chat.js` and refresh. Expect: boot logs the compile failure, skips chat, everything else comes up (no white page). `?reset` wipes `.plugins/`, reseeds factory sources, and strips itself from the URL; localStorage (connection config) survives; files outside `.plugins/` survive. ✅
22. **Turn-safe HMR during a run.** Have a tool edit a mounted capability that contributes tools or waterfall hooks. Expect: the current request and its entire tool batch finish against one frozen generation; after every post-execute hook settles, the pending reload commits at `loop/safe-point`; the next internal request sees the new tools/hooks without replacing the task, broker, or loop session. A final/aborted run still flushes pending edits at `loop/idle`. (Node-tested in `tests/boot.test.ts`; manual spot-check optional.)
23. **Provider Profile switch.** Add the OpenCode Go preset and a second OpenAI-compatible profile in extension settings. Select OpenCode Go plus `deepseek-v4-flash` for one task and the other profile for a second task. Expect each request to use the selected endpoint/key, switching to adopt the profile's default model, Stop to abort either provider through the same `llm/cancel` path, and a deleted explicitly selected profile to fail clearly rather than silently charge the default provider. Legacy `secrets.llm` settings must continue to appear as one `Default` profile.

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
- Shipped and agent-created capabilities use the manager-owned activation path. Framework services are bundled system Fibers and their legacy OPFS copies are removed. Editable shipped sources are write-if-missing and preserve Agent changes; protected shipped drafts are restored from embedded source and cannot be mutated by capability callers. `?reset` remains the capability factory-reset escape hatch and keeps localStorage (`plugin-policy.ts`, `runtime-supervisor.ts`, `manager.ts`).
- Plugin imports are pinned to the public registry (`vue`, Cordis, Zod, pi-ai, `@harness/sdk`); kernel/shared and cross-plugin imports fail loud at compile (`compile.js`, `modules.js`).
- Contribution services are Cordis services. Caller-context tracing makes every `ctx.tools/prompt/ui.register()` effect belong to the calling Fiber, not the registry provider (`tools.js`, `prompt.js`, `ui.js`).
- Hot reloads never remount contributors inside an LLM request or tool/hook batch. Pending source commits at the next `loop/safe-point`, after all post-execute hooks settle, and the next request takes a fresh tool snapshot; `loop/idle` remains the terminal fallback (`manager.ts`, `loop.ts`).
- `llm` is protected and seeded but `autoMount: false`; settings mounts its trusted embedded source via `manager.mount('llm', { cfg })`, Cordis passes config to `apply(ctx, config)`, and `manager.unmount` revokes the service without deleting the protected source (`manager.ts`).
- There is no persisted source-format gate while the project is pre-release. Corrupt editable plugin files fail soft and can be cleaned up via `remove_plugin` even when not running; protected drafts are restored from embedded source (`manager.ts`).
- Standalone API key: localStorage only, closure-captured in the llm plugin. Extension Provider Profile keys: trusted `chrome.storage.local` keys under `secrets.*`. Neither is exposed through service objects, broker status, sandbox storage, page messages, or OPFS.
- Session reset keeps `.plugins/` (chat.js) — plugins survive "Clear session & files".
