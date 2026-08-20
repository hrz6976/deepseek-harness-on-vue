[TASK] Review the implementation plan below for a modular Vue-based self-modifying agent harness. Verify the architecture decisions (declarative contribution model, kernel design, pi-ai engine choice, OPFS persistence, phased userscript plan) and propose better ideas where you see weaknesses. Attack assumptions; do not rubber-stamp.

Context you may also read in this repo (read-only):
- The working 915-line single-file PoC this plan streamlines: app/index.html
- Prior research: conversations/260819-vue-harness-poc/调研结论详解.md (cordis→Vue mapping research), 调研报告-Self-Modifying-Agent寄生任意Vue网站.md (userscript parasite feasibility), 设计文档-cordis核心能力的Vue表达.md (P1 design doc)
- The reference architecture being mapped: ref_repos/deepseek-harness (plugin-based agent harness on cordis; "everything is a plugin"; tools registered via ctx.tools.register, prompt sections via ctx.systemPrompt.section, waterfall event interception)

Key background facts:
- The PoC works: streaming chat, tool-call loop, agent creates its own Vue-component plugins at runtime (compiled from ESM source via Blob import), OPFS persistence, HMR with rollback.
- The plan below is the agreed rewrite: modular npm project, plain JS, esbuild, pi-ai npm package as the only LLM engine, everything-is-a-plugin including UI panels, and a NEW declarative contribution model (contributions rendered as components rather than registered imperatively).
- Phase 2 (later, not being built now): a Tampermonkey userscript injecting this harness into arbitrary pages, reading/writing host Vue app state via __vue_app__, eventually live-patching host components.

=== THE PLAN UNDER REVIEW ===

# Implementation Plan: Modular Self-Modifying Harness (Phase 1)

> 2026-08-20, settled after grill-me session. Supersedes the first draft (which proposed a single-file "rewrite by subtraction" — the discussion turned it into a modular npm project).
> Source material: `conversations/260819-vue-harness-poc/` (research + design docs), the working PoC at `app/index.html`, and the tool/prompt registration patterns in `ref_repos/deepseek-harness`.

## Purpose (two parts, two phases)

1. **Part 1 / Phase 1 — the mapping artifact.** A modular harness whose kernel demonstrates, readably, how cordis / deepseek-harness core concepts translate to Vue primitives. Core engine on DeepSeek via pi-ai. Done when streaming I/O and dynamic plugin creation/loading/HMR are verified working. No 1:1 API compatibility with the real harness is required.
2. **Part 2 / Phase 2 — the interview demo.** A userscript (later possibly a Chrome extension) that injects the same harness into any web page, following the staged path from the parasite research doc: inject UI → read/write host Vue app state (`vue_inspect` / `vue_state`) → live-patch host components (mini-HMR). Built on top of Phase 1, not designed separately.

Phase 1 is the subject of this plan; every architectural choice below was checked against "does this keep Phase 2 cheap?"

## Decisions settled in the grill session

| Decision | Choice | Why |
|---|---|---|
| Project shape | npm project at **repo root**, esbuild for bundling, code split into modules under `src/` | The rewrite is the repo's main artifact; `app/` stays frozen as the PoC reference |
| Language | **Plain JavaScript** | The harness is self-modifying: agent-written plugins are runtime-compiled JS, and keeping built-ins in the same language keeps the shipped/self-modified boundary thin and in-place loading simple |
| LLM engine | **pi-ai from npm** (single engine, no fallback adapter), configurable baseURL / API key / model | Drops the vendored 183KB bundle and Node shims. CORS: local proxy for development now; in Phase 2 a fetch-compatible shim over `GM_xmlhttpRequest` (page-world fetch stays CORS-bound even under Tampermonkey) |
| Persistence | **OPFS** kept; evaluate npm wrappers (ZenFS `@zenfs/dom`, opfs-tools) vs. porting the existing ~40 reviewed lines — take a library only if it genuinely thins the fs plugin | Refresh-survival of agent-created plugins is the core demo of durable self-modification; per-origin isolation becomes per-site workspaces in Phase 2 |
| Plugin principle | **Everything is a plugin** except the absolutely essential kernel. UI panels (chat, files, settings, syslog, preview) are plugins too; the root app is a bare layout frame | Matches the harness's first principle; every plugin appears as a component instance in Vue DevTools — a demo point in itself |
| Built-in loading | Built-ins are **static ESM imports** (bundled, debuggable, real stack traces) exporting the exact same component shape as dynamic plugins; only agent-created plugins go through the runtime compiler | Lifecycle is identical after load; only the loading path differs. Avoids "one bad self-edit bricks the harness" |
| Contribution model | **Declarative**: contributions are rendered components (`<AgentTool>`, `<PromptSection>`, `<Teleport>`), not imperative `register()` calls; composables as secondary face | Mount = register, unmount = dispose; v-if/v-for/DevTools work on contributions natively; agent-authored plugins need no disposer discipline |
| Demo extras | **Keep `run_js` and the iframe preview panel** (each as a plugin) | Phase 1 must have enough capability to run and verify real tasks |
| Testing | **A test document**, not a test suite: verify the basic interfaces work, then enumerate what needs testing as a checklist. Manual testing by the user plus browser-capable agents | Right-sized evidence for a PoC; automation can come when Phase 2 stabilizes surfaces |

## Loop extension seams (the harness pattern, translated declaratively)

Studied from `ref_repos/deepseek-harness`: a plugin exposes itself into the engine loop through four seams, all following **registrations are effects**. The Vue translation goes one step further than porting the registry idiom: **a contribution is not something you register in `setup()` — it's something you render.** Mounting is registration, unmounting is disposal, the template is the plugin's manifest. Design rule: *slot content is what the model reads; props are what the machine reads.*

| harness seam | harness form | our Vue form |
|---|---|---|
| Model-callable tools | `ctx.tools.register(defineTool(...))` | `<AgentTool name="…" :parameters="…" :run="fn">description as slot text</AgentTool>` — a renderless contribution component |
| System-prompt fragments | `ctx.systemPrompt.section(...)` | `<PromptSection :order="50">prose, with {{ interpolation }}</PromptSection>` — the loop assembles the prompt from a computed over collected sections (today's PoC hardcodes the prompt inside the loop; this fixes that) |
| Behavior interception | waterfall listeners on `agent/pre-step`, `llm/request`, `tools/pre-execute`… | bus `waterfall` with veto semantics (proven in the PoC); points: `llm/request`, `tools/pre-execute`, `tools/post-execute`; `useBusOn()` composable, auto-disposed |
| UI contribution | ui-slots / session projections | **no mechanism at all**: a plugin's own render output IS its panel (rendered inside its PluginHost box); placement into named layout regions uses native `<Teleport to="#region-…">` — Teleport is Vue's ui-slots primitive |

What this buys over imperative registries: `v-if` on a contribution is a live feature toggle (conditional tool registration through plain reactivity), `v-for` stamps out N tools from config, Vue DevTools shows each plugin's contributions as child component instances, and the agent-authoring recipe loses all disposer discipline — the system prompt no longer needs to teach `register()`/`onUnmounted` symmetry.

Under the hood: one shared collector helper (`shallowReactive(Map)` keyed by component instance, entry as computed, ~15 lines). Composables (`useTool(def)`, `usePromptSection(fn)`) remain as the secondary face for logic-only plugins — same store, two faces. Contribution components are registered globally (`app.component`) so runtime-compiled plugin templates use them without imports.

Known implementation risk: extracting text from a slot outside a render function triggers a Vue dev-mode warning (tracking through a computed does work). Two same-surface strategies — walk slot vnodes in a computed, or render into a `display:none` element and read `textContent` — pick at implementation time.

## Module layout

```
package.json          deps: vue, @earendil-works/pi-ai; devDeps: esbuild
serve.mjs             dev static server + /proxy route (CORS), adapted from app/
src/
  kernel/             THE presentable core — target ~150 lines total
    services.js         service registry: shallowReactive(Map) of shallowRef slots; useService()
    bus.js              emit / on / waterfall (veto by not calling next)
    host.js             plugins array, mount/unmount, PluginHost error boundary (onErrorCaptured)
    compile.js          ESM source string → component def (Blob import, new Function fallback)
    collector.js        the shared contribution collector (~15 lines) behind AgentTool/PromptSection
  plugins/
    fs.js               OPFS-backed reactive file cache (write-through; cache doubles as HMR signal)
    tools.js            tools service: collector + <AgentTool> + useTool(); exposes schemas()/call() to the loop
    prompt.js           prompt service: collector + <PromptSection> + usePromptSection(); exposes assembled systemPrompt computed
    llm.js              pi-ai engine; config = { baseURL, apiKey, model }
    loop.js             agent loop: streaming consumption, tool rounds (max 20), waterfall
                        interception points, AbortController real stop, prompt assembly
    manager.js          plugin manager: create/remove, OPFS persistence, boot restore,
                        HMR with try-compile rollback (bad source ⇒ old version keeps running)
    tools/              file-editor.js, run-js.js, create-plugin.js, remove-plugin.js
    ui/                 chat.js, files.js, preview.js, settings.js, syslog.js
                        (each renders its panel and Teleports it into a named layout region)
  entries/
    standalone/         index.html + main.js: layout frame, mounts the built-in plugin set
    userscript/         (Phase 2) bootstrap.user.js — injector + GM fetch shim + host-bridge plugins
docs/
  cordis-to-vue.md      updated mapping doc (port of the P1 design doc, paths instead of line numbers)
  TESTING.md            the test document (see below)
```

Build notes (implementation-time defaults, flagging here for visibility):

- Vue must be the **build with the runtime compiler** (`vue/dist/vue.esm-bundler.js` alias) — dynamic plugins carry `template` strings.
- Expose `Vue` on `globalThis` from the entry: runtime-compiled plugins reference `Vue.ref` etc. and import nothing.
- Two esbuild targets from day one, even though only one exists yet: `standalone` (IIFE bundle for index.html) and later `userscript` (single-file .user.js with GM banner).

## Order of work

1. **Scaffold**: root package.json, esbuild build/watch scripts, serve.mjs with /proxy, layout frame exposing named Teleport regions.
2. **Kernel**: port the four-piece kernel from `app/` into `src/kernel/` modules, add `collector.js`. Keep the hard-won comments (`shallowReactive` trap, compile-probe rollback). Settle the slot-text extraction strategy here.
3. **Capability plugins**: fs (evaluate OPFS lib here), tools, prompt, manager.
4. **llm plugin**: pi-ai from npm, streaming event normalization (the `toPiMessages` conversion from app/ carries over, trimmed).
5. **loop plugin**: port + two changes — assemble system prompt from the prompt registry; keep the three waterfall points.
6. **Tool plugins**: file-editor, run-js, create-plugin, remove-plugin — each a component rendering `<AgentTool>` + its own `<PromptSection>` (the plugin-authoring recipe moves from the monolithic system prompt into create-plugin's section, and shrinks: the declarative model needs no disposer discipline).
7. **UI plugins**: chat (streaming blocks: text / collapsible thinking / tool cards, stop button), files, preview, settings (baseURL/key/model → localStorage), syslog.
8. **Write docs/TESTING.md + docs/cordis-to-vue.md**, hand off for manual verification.

## The test document (deliverable, not suite)

`docs/TESTING.md` enumerates, per feature, the manual steps and expected observations. Seed checklist (ported from the PoC acceptance lists, still valid):

1. Connect → streaming visible token-by-token; thinking block collapses; tool cards form during the stream.
2. Stop mid-stream → network request actually aborts; loop exits cleanly; no stuck cursor.
3. `create_plugin` with UI + tool → panel appears, tool callable in next turn, prompt section present.
4. Refresh → plugin auto-restores from OPFS.
5. Edit `.plugins/<name>.js` via file-editor → HMR reload; old UI/tools gone, new ones live.
6. Write broken source → old version keeps running, error surfaced, retry works.
7. `remove_plugin` → panel, tools, prompt section, listeners all gone; no DOM residue.
8. Waterfall veto: demo plugin vetoes a `tools/pre-execute` → tool call blocked with the veto message in the result.
9. Conditional contribution: a plugin with `<AgentTool v-if="enabled">` — toggling the flag adds/removes the tool (and its prompt section) from the next request.
10. Kill the proxy → LLM error lands as a note in the conversation, harness stays usable.

## Phase 2 outline (not in scope now, kept for orientation)

Staged per the parasite research doc: (A) userscript bootstrap injects the same plugin set into a container div on any page (`@sandbox MAIN_WORLD`, GM fetch shim for pi-ai); (B) host-bridge plugin: `vue_inspect` / `vue_state` tools over `__vue_app__` / `__vnode`; (C) `vue_patch` mini-HMR (render replacement). Known risks logged there: prompt injection from page content is the #1 real risk; CSP-strict sites need the `new Function` compile fallback; SPA route changes need re-injection.

=== END PLAN ===

Review focus questions:
1. Declarative contribution model (<AgentTool>/<PromptSection> as renderless components, slot text = model-facing prose): sound, or does it hide footguns (slot text extraction, reactivity timing, contribution ordering, duplicate names)? Is there a better Vue-native mechanism?
2. Kernel boundaries: is the 5-module kernel (services/bus/host/compile/collector) the right minimal cut? Anything that should move in/out?
3. pi-ai as the ONLY engine (no fallback adapter): right call for a PoC that must demo reliably (incl. offline/proxy scenarios)?
4. OPFS + npm wrapper evaluation: keep raw OPFS code vs ZenFS/opfs-tools?
5. Runtime plugin compilation (Blob import + new Function fallback): risks under esbuild bundling (Vue on globalThis, runtime template compiler) that the plan misses?
6. Phase 2 readiness: does anything in Phase 1's design actively hurt the userscript port (CSP, single-file bundling, GM fetch shim for pi-ai)?
7. Anything important the plan omits entirely (security of self-modifying plugins, prompt injection, state migration, error UX)?

Instructions:
- Think independently. Do not try to give the expected answer.
- Be specific. Vague generalities are not useful.
- If you disagree with common wisdom, say so and explain why.
- End with: Top 5 takeaways, ranked by importance.
