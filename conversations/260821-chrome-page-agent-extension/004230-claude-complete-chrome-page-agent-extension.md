# Handoff Note — 004230 · claude · complete-chrome-page-agent-extension

## Inherited context

Same thread as `004201-claude-researched-extension-architecture.md` (design) and `004210-claude-drafted-extension-plan.md` (plan). Phase 1 kernel + OPFS plugin loading were already green (`72d59d9`…`5b43461`); this session delivered Phase 2's Chrome extension form plus the deferred TypeScript migration, all landed as the single commit **`6226114` "feat: add Chrome page agent extension"** (84 files, +7,465/−773).

## Work done — ALL PLAN STEPS COMPLETE

- [x] **TS migration**: every `src/kernel/*`, `src/plugins/*`, and test file `.js → .ts`; strict `tsconfig.json`; `npm run typecheck` prepended to `npm run check`. Runtime dialect unchanged — builtin sources are still shipped to OPFS as type-stripped JS.
- [x] **Build swap**: `build.mjs` deleted; Vite + `@crxjs/vite-plugin` owns manifest/SW/pages/content-script IIFE. `vite.config.ts` `pluginDefaults()` virtual module reads the `.ts` builtins, strips types with `transformWithOxc`, embeds as `virtual:plugin-defaults` (`llm` stays `autoMount: false`). Standalone entry moved to root `index.html`.
- [x] **Shared protocol** (`src/shared/`): `runtime.ts` (HarnessMessage/LlmStreamEvent/FsService), `page-protocol.ts` (ElementRef{nodeRef,selector,fingerprint}, 9-kind PatchOperation union, transaction lifecycle, SiteRecipe, PageCommand/PageEvent/BrokerRequest unions), `broker-schema.ts` (Zod mirror with size caps; `createBrokerEnvelope` re-parses so Vue proxies never cross postMessage).
- [x] **Trusted shell** (`src/extension/`): `manifest.ts` (MV3, Chrome ≥135, sandbox CSP `connect-src 'none'`); `service-worker.ts` (tab-scoped side panels via `sidePanel.setOptions({tabId, path:?tabId=N})`, port names `harness-sidepanel-v2:<tabId>`, streaming LLM via official OpenAI SDK + `OpenAiStreamAccumulator`, MCP via official SDK StreamableHTTP keyed `${tabId}:${id}` and closed on tab close, recipe store in `public.recipes` with permission-gated auto-replay on load-complete/route-change, `secrets.*` refused for sandbox storage, `page/eval` only via `chrome.userScripts.execute`); `sidepanel.ts` (OPFS broker lives HERE — fs requests intentionally throw in the SW; origin authorization button inside the user gesture; approval dialog per `approval-policy.ts`); `options.ts` (LLM config → `secrets.llm`); `tab-scope.ts` (pure, node-tested).
- [x] **Agent policy**: `PAGE_AGENT_BOUNDARY_PROMPT` (plugin DOM = side panel, never host page; temporary-by-default patches; "page plugin" user-facing vocabulary) + `guardPageAgentTool` vetoing `create_plugin` sources that touch `document`/`window.document`.
- [x] **Sandbox runtime**: `sandbox.ts` boots the untouched Phase 1 kernel with swapped backends (`broker-fs.ts` OPFS-over-broker, `broker-llm.ts` streaming completion); `broker()` 30 s timeout, `brokerStream()` async generator with 75 s watchdog; annotation context wired into message submission. New builtin `plugins/tools/page.ts`: page_snapshot / page_query / page_patch_preview / page_patch_apply / page_patch_revert / page_recipe_save / page_recipe_list / page_recipe_remove / page_picker_start + PromptSection.
- [x] **Content runtime** (`content-script.ts`): compressed snapshots; ElementRef resolution nodeRef→selector→fingerprint; transactions preview/apply(reverse-order rollback)/verify/revert(undo closures preserve node identity & listeners); sanitized insert-html (scripts/objects/embeds/base/meta-refresh/inline handlers/`javascript:` stripped); MutationObserver batching + route-change events; closed-Shadow-DOM picker/annotation composer; `__harnessContentRuntimeV1` double-install guard.
- [x] **Tests**: new suites tab-scope, broker-schema, agent-policy, approval-policy, annotation-context, openai-stream, plugin-defaults, extension-content (happy-dom DOM integration). All legacy suites migrated to TS under `tsx --test`.
- [x] **Fixtures & docs**: `examples/legacy-host` (static page) + `examples/react-host` (real React 19 createRoot, demonstrates reconciliation overwriting external patches), built by `examples/vite.config.ts`. README rewritten extension-first; `docs/extension-architecture.md`; TESTING.md updated.

## Current state

All committed through `6226114` on `main`. ⚠️ **This working copy's `node_modules` predates the commit** — `tsx`, `vite`, `@crxjs/*`, `typescript`, `happy-dom`, react fixture deps are absent, so `npm test` fails with "tsx: command not found". Run `npm install` before any check.

| Layer | Where |
|---|---|
| Trusted shell | `src/extension/{service-worker,sidepanel,options,tab-scope,approval-policy,agent-policy,opfs-store,broker-fs,broker-llm,openai-stream}.ts` |
| Sandboxed runtime | `src/extension/sandbox.{ts,html,css}` + untouched `src/kernel/*`, `src/plugins/*` (now TS) |
| Protocol | `src/shared/{runtime,page-protocol,broker-schema}.ts` |
| Host runtime | `src/extension/content-script.ts` |
| Build | `vite.config.ts` (+ `examples/vite.config.ts`), `src/extension/manifest.ts` |

## Key decisions (beyond the plan notes)

| Decision | Rationale |
|---|---|
| fs broker handled in the side panel, not the service worker | OPFS is only available in window contexts; the SW deliberately throws on fs kinds so routing mistakes fail loud |
| Zod re-parse at envelope creation | Doubles as the structured-clone boundary — reactive proxies would otherwise throw or leak across postMessage |
| Recipes store audited operations only; `source` rejected at save | Executable persisted code would turn recipe replay into a persistence XSS vector |
| LLM streaming has its own chunk protocol (`BrokerStreamChunk`) | Tool-call loops need incremental deltas; a single request/response would time out on long generations |
| `dangerouslyAllowBrowser` OpenAI client in the SW | The SW *is* the trusted context holding the key; browser-flag just unlocks the SDK in that environment |
| React host fixture kept even though React edits are DOM-only | Reconciliation overwriting patches must be observable, not just documented |

## Traps for the next agent

- **Stale `node_modules`** (above). Also note `npm run dev` now means CRXJS extension dev mode, not the old standalone server; standalone is `build:standalone` + `npm run serve`.
- Chrome **135+** required (`chrome.userScripts.execute`); `page/eval` additionally needs the per-extension "Allow user scripts" toggle in `chrome://extensions` — DOM tools don't need it.
- Editing a builtin `.ts` plugin does NOT update an existing browser profile: rebuild, then reload with `?reset` semantics (write-if-missing seeding) — same trap as the OPFS session, one build step earlier now.
- Plugin source embedded in the bundle still obeys the dialect v2 import rewriting (extensionless specifiers, top-of-file imports only).
- Port-name prefix `harness-sidepanel-v2:` and side-panel query param `?tabId=` are a matched pair across `tab-scope.ts` / service worker / side panel — change them together.
- `assertPublicStorageKeys` blocks only the `secrets.` prefix; don't stash anything sensitive under other namespaces.
- Content-script scope sets `tabId: -1` locally; the service worker overwrites it from `sender.tab` (`withSenderScope`) — content scripts can't be trusted to self-report their tab.

## Open tasks for the next agent

1. Run `npm install && npm run check` to confirm the suite is green on this machine (should be — CI-authored commit — but unverified locally).
2. Manual browser pass per README: load `dist/extension`, authorize origin, full snapshot→patch→verify→revert round-trip on both fixtures; confirm React host shows reconciliation overwrite.
3. From `docs/extension-architecture.md` 后续扩展点: Vue dev adapter (read-only component/props summary), React devtools-hook diagnostics, Native Messaging MCP bridge, trusted-shell patch approval queue, Playwright-on-Chrome CI covering both fixtures.
4. Live LLM/MCP checks need a real key (DeepSeek endpoint pre-allowed in host_permissions).

## Blockers

- None.

## Suggested next step

`npm install && npm run check`, then the manual fixture pass (task 2) — everything else builds on knowing the round-trip actually works in a real Chrome profile.
