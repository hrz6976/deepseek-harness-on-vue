# Implementation Plan: Modular Self-Modifying Harness (Phase 1)

> 2026-08-20. Settled after a grill-me session, then amended after a 3-model ensemble review (host Fable 5 + GPT-5.5 + DeepSeek v4-pro — see `201148-ensemble-plan-review-SUMMARY.md`). Supersedes the first draft (a single-file "rewrite by subtraction"; the discussion turned it into a modular npm project).
> Source material: `conversations/260819-vue-harness-poc/` (research + design docs), the working PoC at `app/index.html`, the tool/prompt registration patterns in `ref_repos/deepseek-harness`, and the pi-ai source in `ref_repos/pi-mono`.

## Purpose (two parts, two phases)

1. **Part 1 / Phase 1 — the mapping artifact.** A modular harness whose kernel demonstrates, readably, how cordis / deepseek-harness core concepts translate to Vue primitives. Core engine on DeepSeek via pi-ai. Done when streaming I/O and dynamic plugin creation/loading/HMR are verified working. No 1:1 API compatibility with the real harness is required.
2. **Part 2 / Phase 2 — the interview demo.** A userscript (later possibly a Chrome extension) that injects the same harness into any web page, following the staged path from the parasite research doc: inject UI → read/write host Vue app state (`vue_inspect` / `vue_state`) → live-patch host components (mini-HMR). Built on top of Phase 1, not designed separately.

Phase 1 is the subject of this plan; every architectural choice below was checked against "does this keep Phase 2 cheap?"

## Settled decisions

| Decision | Choice | Why |
|---|---|---|
| Project shape | npm project at **repo root**, esbuild for bundling, code split into modules under `src/` | The rewrite is the repo's main artifact; `app/` stays frozen as the PoC reference |
| Language | **Plain JavaScript** | The harness is self-modifying: agent-written plugins are runtime-compiled JS, and keeping built-ins in the same language keeps the shipped/self-modified boundary thin and in-place loading simple |
| LLM engine | **pi-ai from npm** as the only *real* engine, **plus a ~10-line mock engine** for offline/keyless demo and loop tests. Config = { baseURL, apiKey, model } via a **custom provider** (see pi-ai note below), not `deepseekProvider()` | Drops the vendored 183KB bundle and Node shims; pi-ai has built-in retry (kills our `withRetry`). The mock keeps network/key off the critical path for demos and tests without reintroducing a second real adapter |
| Persistence | **Raw OPFS**, port the existing ~40 reviewed lines verbatim; reject ZenFS/opfs-tools | The reactive `Map` cache that doubles as the HMR change signal is a Vue-layer concern no wrapper provides; opfs-tools shows "License: none" on npm; ZenFS is full POSIX emulation we don't need. Keep the thin `{read,list,write,remove,clear}` interface as *the* backend seam so Phase 2 can swap in `GM_setValue` (OPFS needs a secure context many pages lack) |
| Plugin principle | **Everything is a plugin** except the kernel. UI panels (chat, files, settings, syslog, preview) are plugins too; the root app is a bare layout frame | Matches the harness's first principle; every plugin appears as a component instance in Vue DevTools — a demo point (verify it holds under prod build, see risks) |
| Built-in loading | Built-ins are **static ESM imports** (bundled, debuggable, real stack traces) exporting the same component shape as dynamic plugins; only agent-created plugins go through the runtime compiler | Lifecycle is identical after load; only the loading path differs. Avoids "one bad self-edit bricks the harness" |
| Contribution model | **Declarative** (contributions are rendered components: `<AgentTool>`, `<PromptSection>`, `<Teleport>`), with **model-facing prose carried by props, not slot text** | Mount = register, unmount = dispose; v-if/v-for/DevTools work natively; agents need no disposer discipline. Props (not slots) because vnode-walking can't extract `{{ interpolation }}` and the hidden-element `textContent` route is a DOM-flush trap (ensemble finding, verified) |
| Duplicate names | **Always throw** on a duplicate tool/section name, harness-style ("misconfiguration fails loud") | Instance-keyed collection hides duplicates → two same-name tools → gateway 400, the exact bug the PoC burned a day on. HMR unregisters before re-registering so a remount is not a duplicate |
| Demo extras | **Keep `run_js` and the iframe preview panel** (each a plugin) | Phase 1 must have enough capability to run and verify real tasks |
| Testing | **Test document + a small Node kernel test file** (~50 lines). Browser/streaming/OPFS stay manual | The kernel (bus waterfall, collector, services, `translateESM`) is pure logic testable with zero browser and guards exactly the documented traps; everything else is manual by the user and browser-capable agents |

## Loop extension seams (the harness pattern, translated declaratively)

Studied from `ref_repos/deepseek-harness`: a plugin exposes itself into the engine loop through four seams, all following **registrations are effects**. The Vue translation goes one step past porting the registry idiom: **a contribution is not something you register in `setup()` — it's something you render.** Mounting is registration, unmounting is disposal, the template is the plugin's manifest.

| harness seam | harness form | our Vue form |
|---|---|---|
| Model-callable tools | `ctx.tools.register(defineTool(...))` | `<AgentTool name="…" :description="…" :parameters="…" :run="fn" />` — a renderless contribution component; prose in props |
| System-prompt fragments | `ctx.systemPrompt.section(...)` | `<PromptSection :order="50" :text="'…' | (ctx=>'…')" />` — mirrors the harness's `PromptSection.text: string \| ((ctx)=>string)`; the loop assembles the prompt from a computed over collected sections (the PoC hardcodes the prompt inside the loop; this fixes that) |
| Behavior interception | waterfall on `agent/pre-step`, `llm/request`, `tools/pre-execute`… | bus `waterfall` with veto semantics (proven in the PoC); points: `llm/request`, `tools/pre-execute`, `tools/post-execute`. Raw `(arg, next)` stays for fidelity, but expose safer sugar — `useToolGuard({match, deny})`, `useRequestTransform(fn)` — since forgetting `next()` silently vetoes |
| UI contribution | ui-slots / session projections | **no registry**: a plugin's own render output IS its panel (inside its PluginHost box); placement into layout regions uses native `<Teleport>` to **target elements passed via a layout service**, not `#id` selectors (host-page id collisions in Phase 2). Use Vue 3.5 `<Teleport defer>` + layout-first mount order so panels can't race their targets |

What this buys over imperative registries: `v-if` on a contribution is a live feature toggle (setup-only composables can't do this — setup runs once, before `v-if`), `v-for` stamps out N tools from config, DevTools shows contributions as child instances, and the agent recipe loses all disposer discipline.

**The collector** (one shared helper behind `<AgentTool>`/`<PromptSection>`): a `Map` **keyed by contribution name** (not instance — instance-keying hides duplicates), each entry storing the def and its owning instance for cleanup; `onUnmounted` removes the entry; a duplicate name **throws**. With prose as props (no slot extraction) this is genuinely small. Composables (`useTool(def)`, `usePromptSection(def)`) are the equal-citizen secondary face for logic-only plugins — same validated store, two faces. Contribution components register globally (`app.component`) so runtime-compiled templates use them without imports.

**Per-request snapshot** (ensemble finding, and a latent PoC bug): at `llm/request` the loop freezes the assembled prompt and tool table; tool execution dispatches against that same snapshot. Otherwise HMR or a `v-if` removing a tool mid-turn races the model's selection of it.

## Module layout

```
package.json          deps: vue, @earendil-works/pi-ai; devDeps: esbuild, (vitest or node:test)
serve.mjs             dev static server + /proxy route (CORS), adapted from app/
src/
  kernel/             THE presentable core — target ≤200 lines total
    services.js         registry: shallowReactive(Map) of shallowRef slots; useService();
                        token-guarded cleanup (only delete the slot if it still holds your token —
                        else a replacement mounted before the old unmounts gets deleted)
    bus.js              emit / on / waterfall (veto by not calling next); logs listener exceptions
                        with the owning plugin; detects double next()
    host.js             plugins array, mount/unmount, PluginHost error boundary (onErrorCaptured)
    compile.js          ESM source string → component def (Blob import; new Function fallback is a
                        PINNED dialect — single export default, no imports, no top-level await)
    collector.js        name-keyed contribution collector; throws on duplicate; onUnmounted cleanup
    log.js              log service (kernel-level, console fallback) so the kernel has no UI dependency
  plugins/
    fs.js               raw OPFS reactive file cache (write-through; cache doubles as HMR signal);
                        formatVersion check on restore; keep the "remove corrupt plugin file" path
    tools.js            tools service: collector + <AgentTool> + useTool(); schemas()/call() to the loop
    prompt.js           prompt service: collector + <PromptSection> + usePromptSection(); assembled systemPrompt
    llm.js              engine seam: custom pi-ai provider (configurable baseURL) OR mock engine;
                        transport is options.fetch (the Phase 2 GM-shim seam); idle/stream timeout guard
    loop.js             agent loop: streaming consumption, tool rounds (max 20), waterfall points,
                        AbortController real stop, prompt assembly, per-request snapshot
    manager.js          plugin manager: create/remove, OPFS persistence, boot restore,
                        HMR with try-compile rollback (bad source ⇒ old version keeps running)
    tools/              file-editor.js, run-js.js, create-plugin.js, remove-plugin.js
    ui/                 chat.js, files.js, preview.js, settings.js, syslog.js
                        (each renders its panel and Teleports it into a layout-service target)
  entries/
    standalone/         index.html + main.js: layout frame, mounts the built-in plugin set
    userscript/         (Phase 2) bootstrap.user.js — injector + GM fetch shim + host-bridge plugins
tests/
  kernel.test.js        ~50 lines, Node: waterfall veto/order, collector name-collision + disposal,
                        service token-guarded cleanup, translateESM dialect
docs/
  cordis-to-vue.md      updated mapping doc (port of the P1 design doc, paths instead of line numbers)
  TESTING.md            the manual test document (see below)
```

Soft line budgets (eyeballed at review, not gated): kernel ≤200 total, any single plugin ≤120.

### Build notes

- **`format: 'esm'` + `<script type="module">`, not IIFE.** The whole runtime hinges on `import(blobURL)`; esbuild's IIFE dynamic-import handling is the shaky case. IIFE only matters for the Phase 2 single-file userscript.
- **Vue with the runtime compiler**: alias `vue` → `vue/dist/vue.esm-bundler.js` (bare `import 'vue'` gives the runtime-only build, which can't compile plugin `template` strings), and set `define: { __VUE_OPTIONS_API__: true, __VUE_PROD_DEVTOOLS__: false, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false }` or the build warns.
- **Single Vue instance, namespaced.** Expose the bundled Vue for runtime-compiled plugins under a **non-colliding key** (`globalThis.__harness.Vue`), never `window.Vue` — host pages in Phase 2 may own `window.Vue`, and this key is baked into the agent-facing recipe so it must be decided now. Built-ins import Vue normally; dynamic plugins read `__harness.Vue` and import nothing. There must be exactly one Vue namespace across the boundary or provide/inject and reactivity silently break.

### pi-ai note (the one internally-inconsistent decision, resolved)

`deepseekProvider()` hardcodes `baseUrl: "https://api.deepseek.com"`, so it ignores our `cfg.baseURL` and the dev `/proxy` route — and `api.deepseek.com` may not send browser CORS headers. Resolution: build a **custom provider** with pi-ai's exported `createProvider` + `openAICompletionsApi`, passing `baseURL`, `apiKey`, and `options.fetch`. Verified in source: `options.fetch` and `options.apiKey` are honored, `dangerouslyAllowBrowser: true` is set, retry is built in. Confirm pi-ai has an idle/stream-timeout equivalent to the PoC's 45s watchdog; if not, wrap `llm.stream()`.

## Order of work

0. **pi-ai browser spike (do this first).** Pin the version, esbuild-bundle a custom DeepSeek provider, make one streaming call through `/proxy` in a real browser. Confirm: no `process`/`Buffer`/`fs` leak into the bundle, `options.fetch` override works, streaming yields token-by-token, an idle timeout exists or is added. If the spike fails, fall back to re-vendoring the known-good esm.sh provider bundle (not to a second hand-written adapter). Also spot-check that plugins show as instances in Vue DevTools under the prod build.
1. **Scaffold**: root package.json, esbuild build/watch (esm), serve.mjs with /proxy, layout frame exposing layout-service Teleport targets.
2. **Kernel**: port the four-piece kernel into `src/kernel/` modules; add `collector.js` (name-keyed, throws), `log.js`, token-guarded `services` cleanup. Keep the hard-won comments (`shallowReactive` trap, compile-probe rollback). Pin the plugin dialect.
3. **Kernel tests**: write `tests/kernel.test.js` alongside step 2.
4. **Capability plugins**: fs (raw OPFS + formatVersion), tools, prompt, manager.
5. **llm plugin**: custom pi-ai provider + mock engine behind the same `llm.stream()` seam; trim the `toPiMessages` conversion (preserve the message-filter and 8000-char truncation invariants — enumerate them in TESTING.md).
6. **loop plugin**: port + assemble prompt from the prompt registry + per-request snapshot; keep the three waterfall points.
7. **Tool plugins**: file-editor, run-js, create-plugin, remove-plugin — each a component rendering `<AgentTool>` + its own `<PromptSection>` (the plugin-authoring recipe moves into create-plugin's section and shrinks — no disposer discipline). Wire a `tools/pre-execute` approval seam so a ~10-line confirmation plugin can gate `create_plugin`/`run_js`.
8. **UI plugins**: chat (streaming blocks: text / collapsible thinking / tool cards, stop button), files, preview, settings (baseURL/key/model → localStorage), syslog.
9. **Docs**: `docs/TESTING.md` + `docs/cordis-to-vue.md`; hand off for manual verification.

## Trust model (state it, don't solve it in Phase 1)

`create_plugin`/`run_js` are arbitrary same-origin code execution with the API key in the same page. For Phase 1 this is acceptable and inherent, but: (a) verify the `llm` service does **not** expose the key (it's closure-captured; confirm no getter leaks it to plugin/tool context); (b) surface every self-modification in the syslog so a human sees what the agent did; (c) the `tools/pre-execute` approval seam above is the demoable guard. Prompt injection is deferred to Phase 2 (Phase 1's only untrusted input is the user). Conversation history is **not** persisted (only files + plugin sources survive refresh) — a deliberate Phase-1 decision, noted so it's not an accident.

## The manual test document (`docs/TESTING.md`)

Per-feature manual steps and expected observations. Seed checklist:

1. Connect → streaming visible token-by-token; thinking block collapses; tool cards form during the stream.
2. Stop mid-stream → network request actually aborts; loop exits cleanly; no stuck cursor.
3. `create_plugin` with UI + tool → panel appears, tool callable next turn, prompt section present.
4. Refresh → plugin auto-restores from OPFS.
5. Edit `.plugins/<name>.js` via file-editor → HMR reload; old UI/tools gone, new ones live.
6. Write broken source → old version keeps running, error surfaced, retry works.
7. `remove_plugin` → panel, tools, prompt section, listeners all gone; no DOM residue.
8. Waterfall veto: demo plugin vetoes a `tools/pre-execute` → tool call blocked with the veto message.
9. Conditional contribution: `<AgentTool v-if="enabled">` — toggling adds/removes the tool (and its prompt section) from the next request.
10. Kill the proxy → LLM error lands as a note; harness stays usable.
11. Mock engine: with no key/proxy, the mock drives a canned tool round + streamed text end-to-end.
12. Duplicate name: two plugins both declaring tool `x` → the second throws visibly, not silently shadowing.
13. Force the `new Function` compile path (simulate Blob-import failure) → a canonical-dialect plugin still loads.

## Phase 2 outline (not in scope now, kept for orientation)

Staged per the parasite research doc: (A) userscript bootstrap injects the same plugin set into a container on any page (`@sandbox MAIN_WORLD`, GM fetch shim for pi-ai); (B) host-bridge plugin: `vue_inspect` / `vue_state` over `__vue_app__` / `__vnode`; (C) `vue_patch` mini-HMR (render replacement).

Corrected/added risks from the ensemble:

- **CSP is worse than the research doc says.** On a strict-CSP Chrome site (`script-src` without `blob:`/`'unsafe-eval'`), **both** Blob import *and* `new Function` are blocked — `new Function` is not a magic escape hatch, and Vue's runtime template compiler needs `unsafe-eval` too. So runtime-compiled plugins degrade or fail on such sites (the injected bundled UI still loads via userscript privilege). Firefox's userscript sandbox bypasses page CSP; Chrome MAIN_WORLD does not. Scope the "works on any page" promise accordingly — this is an open decision, not a solved fallback.
- **The GM fetch shim is the top Phase-2 technical risk.** pi-ai consumes `options.fetch`'s return as a standard `Response` whose `.body` is a `ReadableStream`; `GM_xmlhttpRequest` yields buffered text/arraybuffer with no stream, so the shim must synthesize a `Response` + `ReadableStream`. De-risk early by keeping `llm.stream()` the sole transport boundary (it already is).
- **Teleport targets** must be harness-unique elements/refs, never coincidental host-page ids.
- API keys move to userscript/extension storage (`GM_setValue`), not page localStorage.
- Prompt injection from page content is the #1 real risk (research doc); SPA route changes need re-injection.
