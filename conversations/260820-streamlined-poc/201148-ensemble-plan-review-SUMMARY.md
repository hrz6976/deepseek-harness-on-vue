# Ensemble Report — plan-review

**Task:** Review the implementation plan at conversations/260820-streamlined-poc/implementation-plan.md — verify the architecture decisions (declarative contribution model, kernel design, pi-ai engine, OPFS persistence, phased userscript plan) and propose better ideas.
**Date:** 260820
**Participants:** claude (Fable 5, host), gpt (GPT-5.5 via codex), deepseek (v4-pro via opencode, high effort)

---

## Consensus

All three participants, independently:

1. **The declarative contribution model (mount = register) is right and worth keeping.** DeepSeek adds the strongest defense: composable-only registration can't do live `v-if` toggling at all (setup runs once), so rendered contributions are strictly more capable, not just prettier.
2. **Slot text as the model-facing prose channel is the plan's weakest implementation choice.** Both peers say make `text`/`description` **props** the canonical API. DeepSeek shows the vnode-walking strategy is *actually broken* for the plan's own example: `{{ interpolation }}` produces an interpolation vnode that only materializes at render time — pre-render walking yields a symbol, not a string. GPT: slot text at most as sugar for plain text, failing loud on component vnodes. DeepSeek proposes mirroring the harness's real shape: `PromptSection.text: string | ((ctx) => string)`.
3. **Front-load the pi-ai browser-bundling spike before any other code.** All three flag it as the highest-variance assumption (the vendoring history required hand-written Node shims). DeepSeek verified in pi-ai source: `options.fetch` (openai-completions.ts L646) and `options.apiKey` exist, `dangerouslyAllowBrowser: true` is hardcoded, retry is built in (kills our `withRetry` legitimately) — **but `deepseekProvider()` hardcodes `baseUrl: "https://api.deepseek.com"`**, so "configurable baseURL + dev proxy" doesn't work with the stock provider: need `createProvider` + `openAICompletionsApi` or a `model.baseUrl` override. The plan's engine decision is internally inconsistent until that spike runs.
4. **Duplicate contribution names must fail loud.** Instance-keyed collection makes duplicates undetectable → `schemas()` emits two same-name tools → OpenAI gateway 400 — the exact bug class the PoC already burned time on. Key by name, error/warn on collision (the harness throws; "misconfiguration fails loud" is one of its core rules).
5. **Keep raw OPFS; reject ZenFS/opfs-tools.** Unanimous. The reactive cache is the actual feature and no wrapper provides it; GPT adds opfs-tools shows "License: none" on npm (dependency risk); DeepSeek adds the thin `{read,list,write,remove,clear}` interface should be *protected* as the backend seam so Phase 2 can swap in `GM_setValue` (OPFS needs a secure context many http pages lack).
6. **Strict CSP kills `new Function` too, not just Blob import** — and Vue's runtime template compiler itself needs `unsafe-eval`. The research doc's "Chrome degrades to new Function" is half-true. Phase 2's "works on any page" claim must be scoped honestly (Firefox userscript-sandbox bypasses page CSP; Chrome MAIN_WORLD does not).
7. **Don't put the harness's Vue on `window.Vue`/`globalThis.Vue`.** Host pages in Phase 2 may define it (global-build sites) — overwriting breaks the host. Namespace it (`globalThis.__harness.Vue` or similar) **now**, because the name is baked into the agent-facing plugin recipe and can't be changed cheaply later.
8. **The trust model must be stated, and an approval seam is nearly free.** `create_plugin` is arbitrary same-origin code execution with the API key in scope. Minimum: verify the key isn't reachable through the `llm` service, document the trust model, and note that a ~10-line `tools/pre-execute` confirmation plugin doubles as the waterfall demo.

## Divergence

- **Duplicate-name policy:** host said last-wins + warning (matching HMR remount semantics); both peers say throw. Resolution both would accept: replace is legal for the *same plugin* remounting (HMR), collision across *different* plugins errors.
- **Testing:** the settled decision was "test doc only." Both peers push back — GPT wants one keyless boot smoke (mount synthetic plugin → toggle v-if → broken-source rollback); DeepSeek calls doc-only "indefensible for the pure-logic kernel" and wants a ~50-line Node test file for bus/collector/services/translateESM. This contradicts a user decision and needs a user call.
- **Mock engine:** both peers want a tiny (~10-line) canned/mock LLM plugin for offline demos — distinct from the rejected fallback SSE adapter (it satisfies the `llm.stream()` seam with canned events, no network code). Host plan had dropped all fallbacks. Also needs a user call since "single engine" was settled.
- **Collector's kernel status:** GPT says move it out of the conceptual kernel (it's a helper, not a cordis-equivalent primitive); DeepSeek says promote it — it's the headline novel code and the "~15 lines" estimate is only honest if props-canonical wins. Agreement underneath: it is not a trivial afterthought.

## Unique insights

- **GPT — per-request snapshot:** freeze the assembled prompt + tool table at `llm/request`; tool execution uses the snapshot the model saw. Otherwise HMR/v-if removing a tool mid-turn races the model's selection of it. (Host and DeepSeek both missed this; it's a genuine correctness hole in the PoC too.)
- **GPT — token-guarded service cleanup:** `provideService`'s name-based delete-on-unmount can delete a *replacement* service if the new owner mounts before the old unmounts. Guard: only delete if the slot still holds your own token.
- **GPT — safer waterfall wrappers:** raw `(arg, next)` is a footgun for agent-authored plugins (forgetting `next()` silently vetoes); offer `useToolGuard`/`useRequestTransform` sugar over the same bus.
- **DeepSeek — esbuild format:** use `format: 'esm'` + `<script type="module">`, not IIFE — the runtime hinges on `import(blobURL)` and esbuild's IIFE dynamic-import handling is the shaky case. IIFE only matters for the Phase 2 userscript.
- **DeepSeek — the `new Function` path is a different dialect, currently destined to rot:** `translateESM` strips exports but not imports, no top-level await, different strict-mode semantics. Pin the canonical plugin dialect (single `export default`, no imports, no TLA) and add a TESTING.md item that *forces* the fallback path, or it ships broken.
- **DeepSeek — idle watchdog:** the PoC's 45s silent-stream timeout exists because a real gateway drops streams with no chunk and no error; verify pi-ai has an equivalent or wrap `llm.stream()` — otherwise demo-day hang risk.
- **DeepSeek — plugin `formatVersion`** on OPFS restore, so a dialect change before Phase 2 doesn't brick restored plugins; and don't regress the PoC's "remove corrupt plugin file" cleanup path.
- **DeepSeek — port invariants list:** the loop's request filter (`status !== 'streaming'/'error'`) and the 8000-char tool-result truncation are subtle correctness properties that will get silently dropped in the port unless enumerated in TESTING.md.
- **Host — Teleport timing:** use Vue 3.5's native `<Teleport defer>` + layout-first mount order. Peers add: target *elements/refs passed via a layout service*, not `#id` selectors (host-page id collisions in Phase 2).
- **Host — `log` as a service** with console fallback so the kernel has no UI dependency (DeepSeek agrees log must be kernel-reachable; GPT silent).

## Gaps

- Conversation-history persistence (only files/plugins survive refresh) — host flagged it as an undocumented decision; neither peer engaged. Should be one line in the plan.
- Nobody assessed the layout frame's actual UX (region arrangement, responsive behavior) — acceptable at this stage.
- Nobody verified the Vue DevTools claim (plugins visible as component instances) actually holds for runtime-compiled components in prod build with `__VUE_PROD_DEVTOOLS__: false` — worth a 2-minute check during the spike; the demo pitch depends on it.

---

## Verdict

The architecture is validated — declarative contributions, everything-is-a-plugin, 5-module kernel, plain JS, raw OPFS, phased userscript all survived three independent adversarial reviews. But the plan is not ready to scaffold as written: the slot-prose mechanism is demonstrably broken for interpolation, the pi-ai "configurable baseURL" claim doesn't match the package's source, and the collector needs name-keyed fail-loud semantics plus per-request snapshotting. All fixes are cheap; none threaten the architecture.

**Confidence:** High — three independent reviews converged on the same top findings, and the two decisive claims (interpolation vnodes, hardcoded `baseUrl`) were verified against source, not opinion.

**Recommended next step:** Amend the plan (props-canonical contributions, name-keyed collector + snapshot, namespaced global, esm format, CSP caveat, trust-model paragraph), get the user's call on the three divergences (duplicate policy, mock engine, kernel tests), then run the pi-ai esbuild spike as step 0 before writing any other code.
