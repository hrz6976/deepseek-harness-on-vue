# Implementation Plan — 004210 · claude · chrome-page-agent-extension

> Executed in one commit (`6226114 feat: add Chrome page agent extension`, ~7,465 insertions across 84 files). Builds on the OPFS-plugins refactor (`conversations/260820-plugins-from-opfs/`) and the Phase 1 kernel (`conversations/260820-streamlined-poc/`). Design basis: `004201-claude-researched-extension-architecture.md`.

## Scope decision: bundle the TS migration with the extension

The extension's trusted shell must be type-checked (Zod-validated boundaries, `chrome.*` typings), and half-measures would leave kernel/plugin call sites untyped against new shared protocols. Decision: migrate **everything** to TypeScript in the same change — `src/kernel/*`, `src/plugins/*`, all tests `.js → .ts`; strict `tsconfig.json`; `npm run typecheck` (tsc --noEmit) added to `npm run check`. Builtins stay user-editable *JavaScript at runtime*: the build strips types via Oxc before embedding them as OPFS factory sources.

## Build system swap

Delete handwritten `build.mjs` (esbuild). Adopt **Vite + @crxjs/vite-plugin**, which owns the MV3 manifest, service worker, HTML pages, and content-script IIFE bundling. A custom `pluginDefaults()` Vite plugin replaces the old esbuild equivalent:

- scans `src/plugins{,/tools,/ui}/*.ts` (excluding `fs.ts`),
- `transformWithOxc(..., { lang: 'ts' })` to strip types,
- embeds results as `virtual:plugin-defaults` with `autoMount: false` for `llm`,
- registers watch files for HMR.

Entry reshuffle: standalone entry moves to root `index.html` + `src/entries/standalone/main.ts`; `serve.mjs` repointed. New fixtures under `examples/` built by a separate `examples/vite.config.ts` (`build:fixtures`): `legacy-host` (static shuttle-query page) and `react-host` (real React 19 `createRoot`) to demonstrate reconciliation overwriting external patches.

## Work breakdown

1. **Shared protocol layer** (`src/shared/`)
   - `runtime.ts`: framework-neutral types extracted from the kernel (HarnessMessage, LlmRequest/stream events, FsService, JsonValue helpers).
   - `page-protocol.ts`: PageScope, ElementRef/fingerprint, SnapshotNode, PatchOperation discriminated union (9 kinds), PatchTransaction lifecycle, Annotation, SiteRecipe, PageCommand/PageEvent unions, BrokerRequest union (page / fs / recipe / storage / llm / mcp), envelope + response + stream-chunk shapes.
   - `broker-schema.ts`: Zod mirror of every request shape with size caps; `createBrokerEnvelope()` re-parses through Zod so validated plain data (never Vue proxies) crosses the sandbox postMessage boundary.
2. **Trusted shell** (`src/extension/`)
   - `manifest.ts`: MV3, minimum Chrome 135, permissions `activeTab/scripting/sidePanel/storage/tabs/userScripts`, optional http(s) host permissions, sandbox CSP with `connect-src 'none'`.
   - `service-worker.ts`: tab-scoped side panel configuration; broker port registry keyed by tabId; streaming `llm/complete` via the official OpenAI SDK (message/tool-call translation, `OpenAiStreamAccumulator`); MCP via official SDK StreamableHTTP clients keyed `${tabId}:${id}`, closed on tab removal; recipe store + pattern-matched auto-replay gated by origin permission; `secrets.*` storage refused; `page/eval` routed exclusively to `chrome.userScripts.execute`.
   - `sidepanel.ts` (+ html/css): trusted chrome around the sandbox iframe — port wiring with auto-reconnect, **OPFS broker lives here** (fs requests never reach the service worker), first-use origin authorization button (`chrome.permissions.request` inside the user gesture, then triggers sandbox snapshot), approval `<dialog>` driven by `approval-policy.ts`.
   - `options.ts`: LLM endpoint/model/key settings into `secrets.llm`.
   - `tab-scope.ts`: pure helpers (inspectable-url check, sidePanel path/port-name encode/parse, event→tab routing) — node-testable without Chrome.
   - `agent-policy.ts` / `approval-policy.ts`: prompt boundary text + `create_plugin` source guard (veto any plugin source touching `document`/`window.document` — plugin DOM is the side panel, not the host page); approval mapping for eval / recipe save-remove / mcp connect.
3. **Sandbox runtime** (`sandbox.ts` + `broker-fs.ts` / `broker-llm.ts` / `annotation-context.ts`)
   - Boot the existing Phase 1 kernel unchanged, but swap backends: fs service → OPFS-over-broker, llm engine → streaming broker completion. `broker()` = promise + 30 s timeout over `parent.postMessage`; `brokerStream()` = async generator pulling queued stream chunks (75 s watchdog).
   - Page tools registered via the declarative contribution components in a new builtin plugin `plugins/tools/page.ts` (snapshot/query/patch preview-apply-revert-verify/recipe save-list-remove/picker start) plus its PromptSection.
4. **Host content runtime** (`content-script.ts`, ~531 lines)
   - Compressed DOM snapshot (selector/maxNodes/maxDepth caps), ElementRef resolution (nodeRef reuse → selector fallback → fingerprint check).
   - Transactions: preview resolves without writing; apply executes sequentially with reverse-order rollback on failure; verify checks per-operation postconditions; revert uses captured undo closures (text ops restore original child nodes, preserving identity/listeners).
   - `insert-html` sanitization: strip script/object/embed/base/meta-refresh/inline handlers/`javascript:` URLs.
   - MutationObserver batching → throttled `page/mutation` events; pushState/replaceState + popstate watching → `page/route-changed`; picker + annotation composer inside a closed Shadow DOM island; idempotent install via a `__harnessContentRuntimeV1` global guard.
5. **Tests** (all TS, `tsx --test`): new suites for tab-scope, broker-schema, agent-policy, approval-policy, annotation-context, openai-stream accumulator, plugin-defaults embedding, and `extension-content.test.ts` — content-script DOM integration under happy-dom (snapshot/patch/revert/sanitize). Existing kernel/boot/compaction/invariants tests migrated.
6. **Docs**: rewrite README (extension-first), add `docs/extension-architecture.md`, update `docs/TESTING.md`.

## Acceptance

`npm run check` green = strict tsc + full test suite + three builds (extension, standalone, fixtures). Manual bar: load `dist/extension` unpacked, authorize an origin, snapshot → patch preview → apply → verify → revert round-trip on both fixture hosts.
