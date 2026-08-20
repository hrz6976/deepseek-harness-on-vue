# TESTING — manual test document

Phase-1 verification: per-feature manual steps and expected observations.

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
- Automated coverage: `npm test` (kernel logic); scenarios marked ✅ below were also verified by Playwright smoke runs on 2026-08-20 (fresh Chrome, mock engine + `__harness` API).

## Scenarios

1. **Connect → streaming.** Mount LLM, run a goal. Expect: text token-by-token; thinking block collapsible (auto-open while streaming) *when the model/gateway emits reasoning content*; tool cards form *during* the stream. ✅ (mock; and LIVE 2026-08-20: `deepseek-v4-flash` via opencode zen with keyless pi credential — 3-turn run_js round returning 42; no reasoning content came back from zen for flash, so no thinking block, expected)
2. **Stop mid-stream.** Click Stop during generation. Expect: network request actually aborts (DevTools Network shows cancelled), loop exits with a "stopped" note, no stuck blinking cursor.
3. **`create_plugin` with UI + tool.** Ask the agent to build itself a plugin (e.g. dice tool + panel). Expect: panel appears in the Plugins area immediately, tool callable next turn, its prompt section present in the next request. ✅ (via `__harness` manager API)
4. **Refresh → restore.** Reload the page. Expect: dynamic plugin auto-restores from OPFS (syslog: "restored dynamic plugin …"); with saved key/mock, the LLM auto-reconnects. ✅
5. **HMR.** Edit `.plugins/<name>.js` via file_editor (or ask the agent to). Expect: ~300ms later the plugin hot-reloads; old UI/tools gone, new ones live; syslog "HMR: … hot-reloaded". ✅
6. **HMR rollback.** Write syntactically broken source to `.plugins/<name>.js`. Expect: old version keeps running, "HMR failed, old version running" badge, error in syslog; writing good source again recovers. ✅
7. **`remove_plugin`.** Expect: panel, tools, prompt section, listeners all gone; no DOM residue; `.plugins/<name>.js` deleted. ✅
8. **Waterfall veto.** Create a guard plugin, e.g. setup calling `__harness.useToolGuard(req => req.name === 'run_js' ? 'run_js is disabled by policy' : null)`. Expect: next `run_js` call blocked with "vetoed by a plugin: …" as its result; unmounting the guard re-enables. (~10-line approval plugin = the demoable trust-model guard for `create_plugin`/`run_js`.)
9. **Conditional contribution.** Plugin with `<AgentTool v-if="enabled" …>` and a panel toggle. Expect: toggling removes/adds the tool (and its prompt section) from the NEXT request — inspect the proxied request body's `tools` array.
10. **Kill the proxy.** Stop serve.mjs mid-session, run a goal. Expect: LLM error lands as a note (with CORS/proxy hint when relevant); harness stays fully usable; restarting the proxy recovers.
11. **Mock engine end-to-end.** No key, no proxy: mock drives a canned tool round (a REAL `run_js` Worker execution returning `42`) + streamed text. ✅
12. **Duplicate name.** Second plugin declaring tool `x` while another owns it: creation fails loudly (PluginHost error card: `duplicate tool "x"`), no silent shadowing. Same-plugin HMR remount does NOT count as a duplicate. ✅
13. **Forced `new Function` path.** Simulate Blob-import failure (e.g. DevTools overrides blocking `blob:`, or temporarily patch `URL.createObjectURL` to throw) and load a canonical-dialect plugin. Expect: it still loads via `translateESM` + `new Function`. The *dialect subset* itself is covered by `npm test`; note the fallback deliberately re-throws real `SyntaxError`s.
14. **Mid-turn removal race (snapshot).** While the model is streaming a turn that will call tool `t`, remove the plugin owning `t`. Expect: the in-flight turn still executes `t` against the request snapshot; `t` is absent from the *next* request.
15. **DevTools claim.** With Vue DevTools on the dev build: every plugin appears as a component instance under its PluginHost; contributions appear as `AgentTool`/`PromptSection` children. (Note: `__VUE_PROD_DEVTOOLS__` is `false` — this is a dev-build demo point; not yet spot-checked under a minified prod build.)
16. **Compaction (forced).** Mock engine mounted, then in the console: `const c = __harness.services.get('compaction').value; c.settings.reserveTokens = 131000; c.settings.keepRecentTokens = 5;` and run a second goal. Expect: a "compacting…" note, then a green 📦 collapsed summary card replacing the older messages, the ctx badge shrinking, and the run continuing normally. The manual **Compact** button (idle only) re-compacts into a single leading summary. ✅ (mock, real Chrome, 9/9 script checks 2026-08-20)
17. **Compaction (live).** Long multi-file session against a real endpoint until `~112k` ctx (or crank `reserveTokens` as above to force it early). Expect: same as 16, one summarization request on the wire (tool-less, "context summarization assistant" system prompt), and the agent still knows the goal afterwards. Not yet run live.

18. **Readable component state (`expose()` → `read_state`).** Ask the agent to build a plugin with interactive UI state, e.g. "build a counter with a button" or a snake game — the recipe tells it to call `ctx.expose({ count })` in setup. Interact with the UI yourself (click, play), then ask the agent what the state is. Expect: it calls `read_state` and sees the CURRENT values (refs unwrapped, functions omitted); the system prompt carries an index line ("Plugins expose live readable state: counter {count}") only while something is exposed; plugins that never call `expose()` stay invisible (`read_state` on them errors loud); HMR remount and page refresh both re-capture; `remove_plugin` clears the registry and the index. Console check: `__harness.services.get('tools').value.call('read_state', {})`. ✅ (15/15 Playwright checks 2026-08-20: boot, discovery, DOM clicks → `{"count":2}`, un-exposed invisible, HMR, refresh restore, removal, zero console errors)

19. **Everything-from-OPFS cold boot.** Fresh profile (or after `?reset`): open the app. Expect: `.plugins/` gets seeded with every shipped plugin source (18 files incl. `.format`), all of them compile and mount from OPFS through the dynamic pipeline, badges read `core`; `llm.js` is seeded but NOT mounted until Settings connects (`autoMount: false`). ✅ (18/18 Playwright checks 2026-08-20)
20. **Core plugin is agent-editable.** Edit a shipped plugin's source in `.plugins/` (e.g. change `run-js.js`'s tool description) via file_editor or console. Expect: HMR hot-reload ~300ms later, the change visible in the next request's tool schemas; the edit SURVIVES a page refresh (boot loads from OPFS and never overwrites an existing file). Broken edits roll back exactly like scenario 6 — for core plugins too. ✅
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
- Duplicate contribution names throw across plugins; same-plugin remount replaces (`collector.js`).
- Service/collector cleanup is token-guarded — an old instance unmounting late cannot delete its replacement (`services.js`, `collector.js`). The exposed-state capture follows the same rule (`host.js`).
- Agent-readable state is opt-in: only `ctx.expose({...})` makes it visible; reads happen at call time (live), serialize as JSON (refs unwrapped, functions dropped, circular → error string), and cap at the same **8000 chars** as tool results (`state.js`).
- `create_plugin` compile-probes BEFORE persisting or mounting; broken source is never written (`manager.js`).
- EVERY plugin (core and agent-created) loads from `.plugins/` through the same runtime compile path; the only bundled plugin is `fs` (bootstrap dependency). Seeding is **write-if-missing** — agent modifications are never clobbered; `?reset` is the factory-reset escape hatch and keeps localStorage (`boot.js`).
- Plugin imports are pinned to registry specifiers (`vue`, pi-ai, `kernel/*`); cross-plugin imports fail loud at compile — plugins share through services (`compile.js`, `modules.js`).
- Contribution collectors are kernel-owned kind-keyed singletons: reloading `tools.js`/`prompt.js` must not orphan other plugins' registrations (`collector.js`, `contrib.js`).
- Hot reloads are deferred while the loop runs and flushed after — no remounting live machinery mid-run (`manager.js`).
- `llm` is seeded but `autoMount: false`; settings mounts it via `manager.mount('llm', { cfg })` and PluginHost passes the config as props; `manager.unmount` keeps the file and never surprise-remounts on a later edit (`boot.js`, `manager.js`).
- Boot checks `.plugins/.format` (now `2` = dialect v2); a mismatch boots from the SHIPPED defaults with stored files kept (skipping would brick the app — everything lives in `.plugins/` now). Corrupt plugin files can be cleaned up via `remove_plugin` even when not running (`boot.js`, `manager.js`).
- API key: localStorage only, closure-captured in the llm plugin, never exposed through the service object, never written to OPFS.
- Session reset keeps `.plugins/` (chat.js) — plugins survive "Clear session & files".
