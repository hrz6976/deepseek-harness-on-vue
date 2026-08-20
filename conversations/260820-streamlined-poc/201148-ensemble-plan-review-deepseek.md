I read the PoC (`app/index.html`), the four research/design docs, the harness `AGENTS.md`, `system-prompt/src/index.ts`, `agent-loop/src/*`, and the pi-ai source (`@earendil-works/pi-ai@0.84.2`). Verdict: the plan is directionally right, but two decisions are wrong enough to fix before scaffolding, and one "settled" choice silently depends on a code path the plan doesn't spell out.

## 1. Declarative contribution model — keep "mount = register", drop "slot text = prose"

The core idea (contributions are rendered, mount=register / unmount=dispose) is **sound and is the best Vue-native fit**. It's strictly better than imperative `register()` because `v-if` in `setup()`-driven composables can't do live toggling (setup runs once, before `v-if`), whereas a rendered `<AgentTool v-if>` genuinely mounts/unmounts. I'd defend this against any "composables are simpler" pushback.

The implementation choice is the problem: **extracting prose from slot text is the single riskiest thing in the plan, and the plan under-weights it despite flagging it.**

- "Walk slot vnodes in a computed" is **broken for your own example**. `<PromptSection>prose with {{ interpolation }}</PromptSection>` produces an interpolation vnode whose text is only materialized at render time; walking vnodes pre-render gives you `{type: Symbol(interpolate)}`, not a string. So that strategy silently can't do the interpolation you advertise.
- "Render into `display:none` and read `textContent`" works, but each contribution becomes a real mount, child-component `setup` runs even though it's hidden, and you get the dev-mode tracking warning you already spotted. That's a heavy, fragile mechanism for prose.
- Two compile paths (Blob import vs `new Function`) with different slot semantics will drift.

**Fix:** keep `<AgentTool>` / `<PromptSection>` as renderless components, but make the model-facing content a **prop**, mirroring the harness's actual shape — `PromptSection.text: string | ((ctx) => string)` (harness `system-prompt/src/index.ts:67`). So:

```html
<AgentTool name="dice" :description="'roll an N-sided die'" :parameters="..." :run="fn" />
<PromptSection :order="50" :text="ctx => 'today is ' + ctx.date" />
```

Every claimed benefit survives (v-if toggle, v-for stamping, DevTools visibility as named instances, no disposer discipline). The entire slot-extraction risk category disappears. The only thing you lose is the aesthetic "slot content is what the model reads" — and you lose it in exchange for not shipping a footgun. "The template is the plugin's manifest" stays true; the manifest just uses attributes, not element body.

Corollary: the "~15 line collector" is optimistic. With slot extraction it balloons; with props it's a genuinely small `Map` + `onUnmounted` cleanup.

**Separate bug in the collector as specced:** keying by *component instance* (`shallowReactive(Map)` keyed by instance) makes **duplicate names undetectable**. Two `<AgentTool name="x">` become two entries, `schemas()` emits `[{name:'x'},{name:'x'}]`, and the OpenAI gateway 400s — the exact class of bug the PoC already burned a day on (L317-319 comment: "name must be taken from the registry key"). The harness throws on duplicate section registration (`NamedEntries` with error, `system-prompt/src/index.ts:316-318`). Key the collector by **contribution name**, throw (or warn) on collision, and bind lifecycle cleanup to the instance. "Misconfiguration fails loud" is a harness core rule and you should inherit it.

## 2. Kernel boundaries — right shape, one mis-scoped file

services / bus / host / compile / collector is the correct minimal cut. Three adjustments:

- **`collector.js` is not a 15-line afterthought — it's your headline contribution and the most novel, riskiest code.** Promote it from "~15 lines" to a first-class `contributions` concept with the duplicate-name + ordering semantics above. Rename is optional; the scope is the issue.
- **`log` is missing.** Both `host.js` (mount/unmount events) and `manager.js` (HMR events) need it; the PoC keeps it at kernel level (L222-225). Put a `log` service in the kernel or you'll re-implement it in three plugins.
- Everything else is in the right place. `compile.js` in-kernel is correct (normalize/translateESM/importPluginSource all belong together). Waterfall points stay in `loop.js` (capability), not the bus — correct, the bus is a generic primitive.

## 3. pi-ai as only engine — right package, wrong to drop the fallback

The npm-package decision is correct and verified: `openai-completions.ts` accepts `options.fetch` (L239, L646) and `options.apiKey` (L231), hardcodes `dangerouslyAllowBrowser: true` (L683), and has built-in retry (`retryProviderRequest`, L250). That kills your hand-rolled `withRetry` and the 183KB vendor bundle legitimately.

But three things:

- **"Configurable baseURL" is a claim without a code path.** `deepseekProvider()` hardcodes `baseUrl: "https://api.deepseek.com"` (`providers/deepseek.ts`). Stock provider ignores your `cfg.baseURL` and your dev `/proxy` route. You must either mutate `model.baseUrl` or build a custom provider with `createProvider` + `openAICompletionsApi` (both exported). This is a concrete spike to run before committing to "no fallback adapter" — because **api.deepseek.com may not send CORS headers to the browser**, and the proxy is the only dev path that avoids that. The plan says "local proxy for development now" and "pi-ai single engine" in the same breath, but the stock provider won't hit the proxy.
- **Drop the fallback, but keep a ~10-line mock/canned engine** for offline demo. Your own TESTING.md item 10 ("kill the proxy → error lands as a note") proves you still need error-path demos; a real offline *demo* (model does a canned tool round) is nearly free and removes "does it run without a key/network" as a demo-day variable. You don't need the 75-line SSE adapter — a canned stream satisfies the `llm.stream()` seam.
- **Verify the idle watchdog.** The PoC added a 45s silent-stream timeout because the gateway drops streams with no chunk and no error (L632-655) — the loop otherwise hangs forever. pi-ai may not have this; check `event-stream.ts` and, if absent, wrap `llm.stream()` with your own timeout. This is a real "demo hangs" risk, not hypothetical.
- Don't assume "drops Node shims" until you've bundled it: `uuid.ts` uses `globalThis.crypto` (good), but the vendor bundle + `buffer/fs/process` shims in `app/vendor/node/` existed for a reason. Do the esbuild of the npm package early (step 4 is too late) to confirm no `process`/`Buffer` leaks into the standalone bundle.

## 4. OPFS — keep raw, reject ZenFS/opfs-tools

Your own decision rule ("take a library only if it genuinely thins the fs plugin") gives the answer: **raw, port the ~40 lines verbatim.**

- ZenFS (`@zenfs/dom`) is a full POSIX filesystem emulation — inodes, path resolution, permissions, buffering. You need none of it: your fs is a flat cache keyed by path plus a `.plugins/` prefix. You'd pay a large dependency and an async API surface for negative value.
- The fs plugin's actual value is the **reactive `Map` cache that doubles as the HMR change signal** (L266 comment) — no OPFS wrapper provides that; it's a Vue-layer concern.
- Phase 2 argument cuts the other way from what you'd expect: you want to **keep** the thin `{ read, list, write, remove, clear }` interface as *the* backend seam, because OPFS requires a secure context (many http pages aren't) and `GM_setValue` will be the reliable Phase 2 store. A wrapper like ZenFS would abstract that seam away and make the swap harder. Keep raw now; swap the implementation behind the same interface in Phase 2.

## 5. Runtime compilation under esbuild — the plan misses four things

- **IIFE is a landmine.** You say "IIFE bundle for index.html" but the whole runtime hinges on `import(blobURL)`. Use `format: 'esm'` + `<script type="module">`. (Dynamic `import()` does work in classic scripts, but there's zero reason to force IIFE for a standalone app, and esbuild's IIFE output is the one place dynamic-import handling is genuinely shaky.) IIFE only becomes relevant for the userscript in Phase 2.
- **Vue feature flags.** Aliasing to `vue/dist/vue.esm-bundler.js` (full build, runtime compiler included — correct and necessary, since `import 'vue'` gives you the runtime-only build) requires `define: { __VUE_OPTIONS_API__: true, __VUE_PROD_DEVTOOLS__: false, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false }` or you get build-time warnings. The plan doesn't mention this.
- **The `new Function` fallback is a *different dialect*, not a fallback.** `translateESM` (L230-234) strips `export default` but not `import`, has no top-level `await`, and has different scope/strict-mode semantics than Blob import. An agent-written plugin can work under one path and silently break under the other, and the fallback only fires on Safari/strict-CSP — i.e., it's dead code that will rot. Pin the canonical plugin dialect now (single `export default` object, no imports, no top-level await) and **add a TESTING.md item that forces the `new Function` path**, otherwise you'll never exercise it.
- **`window.Vue` will collide in Phase 2.** Many Vue sites expose `window.Vue` (global-build sites). Overwriting it to inject your harness breaks the host. Expose under a non-colliding key (`globalThis.__harnessVue`) and have the plugin recipe reference that. Phase 1 can't fix this later without a re-authoring recipe change, so decide it now.

## 6. Phase 2 readiness — two real risks the plan under-specifies

- **The GM fetch shim is harder than "fetch-compatible" implies.** pi-ai's `options.fetch` override (L646) is the right seam — you don't monkeypatch global fetch. But that fetch must return a standard `Response` whose `.body` is a `ReadableStream`, because pi-ai's SSE parsing consumes it as one. `GM_xmlhttpRequest` gives you text/arraybuffer and no stream — the shim must synthesize a `Response` + `ReadableStream` from buffered text. That's the single highest Phase 2 technical risk, and Phase 1 should de-risk it early by confirming `llm.stream()` consumes only `options.fetch` (it does) and that you can inject a custom fetch at the `llm` plugin seam. Keep `stream()` as the transport boundary; you already have this shape, just protect it.
- **CSP is worse than the research doc admits.** On a strict-CSP Chrome site (`script-src` without `blob:` or `'unsafe-eval'`), **both** Blob import *and* `new Function` are blocked — `new Function` is not a magic escape hatch, it needs `'unsafe-eval'`. The research's "Chrome degrades to `new Function`" is only half-true. Since "live self-modification on any page" is the Phase 2 headline, this needs a real decision (accept degraded read-only mode, or pre-compile templates server-side — impossible — or require Firefox/userscript-sandbox). Flag it as an open risk, don't inherit it silently.
- Minor: `<Teleport to="#region-…">` uses `document.querySelector`, which can match a *host page* element with a coincidental id. Use harness-unique ids or Teleport to a ref.

## 7. Omissions

- **Trust/approval model is the biggest hole.** `create_plugin` is arbitrary code execution in the page's main world, and the agent's *entire tool surface plus the API key* are in scope. The PoC and research both name prompt injection as the #1 risk, but Phase 1 has no guard, no audit, and no TESTING.md item. Minimum: (a) confirm the API key is not reachable from plugin/tool context (currently it's closure-captured in `makeLlmPlugin` — verify the `llm` service doesn't expose it), (b) wire a `tools/pre-execute` veto *before* `create_plugin`/`run_js` as an approval seam (the waterfall point already exists — a ~10-line confirmation plugin is the demo), (c) document the trust model in the plan. At least surface the self-modification in the syslog so a human can see what the agent did.
- **"Test document, not a suite" is right for browser/streaming/OPFS and wrong for the kernel.** `bus.waterfall`, the collector, `services` shallow/markRaw discipline, and `translateESM` are pure logic testable in Node with zero browser. A ~50-line test file here is nearly free and catches regressions in exactly the traps you've documented (shallowReactive, duplicate names, rollback). Don't ship a "presentable" kernel that's only manually verified.
- **Plugin-format versioning.** If the plugin dialect changes before Phase 2, restored `.plugins/*.js` break. A one-line `formatVersion` check on restore ("skip + keep the `remove_plugin` cleanup path" — which the PoC already has, L484-490) is enough. Don't regress that cleanup path.
- **Hidden loop invariants.** The request filter `m.status !== 'streaming' && m.status !== 'error'` (L776) and tool-result truncation to 8000 chars (L799) are subtle correctness properties that must survive the port; enumerate them in TESTING.md or they'll be silently dropped during the "trim" of `toPiMessages`.

---

## Top 5 takeaways (ranked)

1. **Replace slot-text extraction with a `text`/`description` prop** on `<PromptSection>`/`<AgentTool>` (mirroring `PromptSection.text: string | ((ctx) => string)`). The "mount = register" model is right; the slot-prose implementation is the one part of the plan that is genuinely broken (interpolation can't be extracted by vnode-walking) and it's also the only part that's *not* free. This should be fixed before scaffolding.
2. **Key the contribution collector by name, not by instance, and throw on duplicates.** Instance-keying makes duplicate tool/section names undetectable, reproducing the exact gateway-400 bug the PoC already hit; the harness throws on duplicate and you should too.
3. **"pi-ai single engine, configurable baseURL" is internally inconsistent.** `deepseekProvider()` hardcodes `baseUrl`, so your dev proxy and CORS story don't work until you build a custom provider or override `model.baseUrl`. Run that spike first, and keep a ~10-line mock engine for offline demo + verify pi-ai has an idle/stream-timeout (the PoC's 45s watchdog exists for a real gateway behavior).
4. **Use `format: 'esm'`, not IIFE**, and define the `__VUE_*` feature flags; more importantly, pin the plugin dialect and *force-test* the `new Function` fallback, because it's a different language subset than Blob import and currently dead code. Also rename `window.Vue` → a non-colliding global key now, before it becomes the agent-facing recipe.
5. **Add an approval seam and a ~50-line kernel test file.** The trust model (arbitrary code execution + API key in scope, prompt injection as the #1 risk) has zero guard or even an audit trail in Phase 1, and "test document only" is indefensible for the pure-logic kernel (waterfall, collector, services, `translateESM`). Both are cheap and close the plan's two biggest omissions.

(Everything else — raw OPFS, everything-is-a-plugin, the 5-module kernel, plain JS, the phased userscript plan — is well-founded; I'd ship it as-is once the five items above are addressed.)
