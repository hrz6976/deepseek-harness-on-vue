# Ensemble answer — claude (host, Fable 5)

Reviewing the plan as an adversary, focusing on what would actually break or embarrass us in a demo.

## 1. Declarative contribution model

Sound overall — mount=register genuinely is the Vue-native expression, and the payoffs (v-if toggling, DevTools visibility, no disposer discipline in the agent recipe) are real. Four footguns the plan under-specifies:

- **Teleport target timing.** UI plugins Teleport into layout regions. If a plugin mounts before the layout frame's region elements exist, Vue errors ("Invalid Teleport target"). Mount order must be: layout first, then plugins — or use `<Teleport defer>` (Vue 3.5 has native `defer` support; we're on 3.5, use it). This must be an explicit invariant, not luck.
- **Duplicate tool names.** Two plugins rendering `<AgentTool name="roll_dice">` — the collector needs a stated policy. Recommend: last-mounted wins + syslog warning (matches HMR remount semantics where the new version re-registers under the same name).
- **`:run` in runtime-compiled templates.** Trivial run functions fit inline in the template; real ones must be defined in `setup()` and bound. The agent-facing recipe must show the setup-bound form as the default, or agents will write 300-char arrow functions in attributes.
- **Slot-text extraction** is flagged in the plan already; the vnode-walk-in-computed approach works (computed tracks deps accessed during slot invocation) but will print a dev-mode warning for compiled slots. The hidden-element/textContent fallback is the safer default; whitespace needs dedent+trim normalization either way.

## 2. Kernel boundaries

The 5-module cut (services/bus/host/compile/collector) is right. One adjustment: `log` is currently kernel-global in the PoC; make it a `log` *service* provided by the syslog UI plugin with a `console.log` fallback in the kernel, otherwise the kernel depends on a UI concern. Compile belongs in the kernel (the manager plugin uses it, but Phase 2's host-bridge will too).

## 3. pi-ai as the only engine — the plan's biggest unverified assumption

The vendoring experience (190128 note) proved pi-ai's browser story is fragile: the esm.sh bundle needed hand-written process/buffer/fs shims, and the core package's API implementations were stripped lazy imports — only the provider subpath bundle worked. **Bundling pi-ai from npm with esbuild will hit the same Node-built-in imports**, now as our problem to solve with esbuild aliases/shims/defines. This might work in an hour or become a tar pit. The order of work must front-load a spike: step 0 = "esbuild-bundle pi-ai deepseek provider, load in browser, one streaming call through the proxy." If the spike fails, fall back to vendoring the known-good esm.sh bundle again (not to the hand-written SSE adapter — that decision is settled). Also: single-engine + proxy means every demo depends on the proxy running; the test doc should include a "proxy down" case (it does, item 10).

## 4. OPFS

Keep the raw code. The existing ~40 lines are reviewed, working, and integrated with the reactive cache — which is the actual product feature (HMR signal). ZenFS/opfs-tools give you a POSIX-ish API but zero reactivity, so we'd still write the cache layer, and they add a dependency whose browser-quirk surface we'd have to learn. The npm-wrapper evaluation can be a 15-minute look, but the expected answer is no.

## 5. Runtime compilation under esbuild — one invariant the plan understates

**There must be exactly one Vue instance.** The bundle imports Vue via esbuild; dynamic plugins use `globalThis.Vue`. If these are ever two copies (e.g., a second entry accidentally bundling its own Vue), provide/inject and reactivity silently break across the boundary — the classic dual-instance bug, and brutal to debug. The entry must do `globalThis.Vue = <the bundled namespace>` and dynamic plugins must never import. Add to the test doc: a dynamic plugin's `inject('services')` reaches the same registry (this implicitly verifies the invariant). Also needed: esbuild `define` for `__VUE_OPTIONS_API__`/`__VUE_PROD_DEVTOOLS__`, and the esm-bundler-with-compiler alias the plan already names.

## 6. Phase 2 readiness — the CSP story is rosier in the plan than in reality

The research doc says strict-CSP sites block Blob import, with `new Function` as fallback. But strict CSP (`script-src` without `unsafe-eval`) blocks `new Function` **too**, and — worse — **Vue's runtime template compiler itself uses `new Function`**, so on such sites dynamic plugins can't compile templates at all, by any path. The honest Phase 2 statement: on strict-CSP sites, the harness UI still injects (bundled code is fine via userscript privileges) but *runtime-compiled plugins* degrade to render-function-only or don't work; Firefox's userscript world bypasses page CSP, Chrome MAIN_WORLD does not. Nothing in Phase 1 needs to change, but the plan's Phase 2 outline should carry this caveat so nobody promises "works on any page" to an interviewer. Same CSP concern applies to `run_js`'s Blob Worker.

## 7. Omissions

- **Conversation history is not persisted** (only files + plugin sources survive refresh). Fine for Phase 1, but say it out loud in the plan so it's a decision, not an accident.
- **Self-modifying code security**: agent-written plugins run with full page privilege by design. Acceptable and inherent for this PoC; one sentence in the README prevents an interviewer from thinking we didn't notice.
- **Prompt injection** is correctly deferred to Phase 2 (Phase 1's only untrusted input is the user).
- The plan has no **module line budgets**; the old ~500-line discipline died silently. Suggest a soft budget: kernel ≤200 lines total, any plugin ≤120, enforced by eyeball at review.

## Top 5 takeaways

1. **Front-load a pi-ai esbuild-bundling spike** before any other code; the vendoring history says this is the plan's highest-variance assumption. Fallback = re-vendor the esm.sh provider bundle, not a second engine.
2. **State the single-Vue-instance invariant** (bundled Vue === globalThis.Vue) and test it via a dynamic plugin reaching `inject('services')`.
3. **Use Teleport `defer` (Vue 3.5) + layout-first mount order** so UI plugins can't race their targets; define duplicate-tool-name policy as last-wins + warning.
4. **Correct the Phase 2 CSP claim**: strict CSP kills `new Function` and Vue's template compiler, not just Blob import — scope the userscript promise accordingly.
5. **Keep raw OPFS** (reactivity is the feature, wrappers don't provide it); make `log` a service so the kernel has zero UI dependencies.
