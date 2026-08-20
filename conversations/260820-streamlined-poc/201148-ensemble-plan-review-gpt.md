I’ll read the project context and the handoff instructions first, then I’ll inspect the PoC and design docs before judging the plan. Since the workspace is read-only, I’ll keep this to analysis and recommendations.

I found an existing matching thread, `conversations/260820-streamlined-poc`, so I’m reading its notes as inherited context before reviewing the architecture. After that I’ll cross-check the PoC and prior research rather than reviewing the plan in isolation.

The matching handoff thread mostly contains the exact plan and task prompt; the two model-review files appear empty from the first read. I’m going deeper into the PoC now, especially the implemented kernel, OPFS, compilation, and loop behavior.

The PoC confirms a few non-obvious lessons that the new plan partially preserves: `shallowReactive(Map)` is not optional, precompile-before-swap is the rollback boundary, and the current fallback SSE path is doing real reliability work. I’m checking the reference harness seams next so the review can distinguish “faithful mapping” from unnecessary novelty.

One issue the plan underestimates is that pi-ai’s current public docs emphasize the `createModels()` provider collection path, while the PoC uses direct `provider.stream()`. That is not a blocker, but it argues for a pinned-version browser smoke before building the rest of the loop around an assumed call surface.

I would not rubber-stamp this as written. The core direction is sound, but several details are currently too optimistic.

I read the PoC, prior design/research docs, harness prompt/tool docs, and pi-ai source. Key refs: [PoC kernel](/Users/hrz/Documents/GitHub/deepseek-harness-on-vue/app/index.html:145), [PoC HMR rollback](/Users/hrz/Documents/GitHub/deepseek-harness-on-vue/app/index.html:455), [PoC fallback engine](/Users/hrz/Documents/GitHub/deepseek-harness-on-vue/app/index.html:587), [harness system prompt contract](/Users/hrz/Documents/GitHub/deepseek-harness-on-vue/ref_repos/deepseek-harness/packages/core/system-prompt/README.md:20), [pi-ai fetch option](/Users/hrz/Documents/GitHub/deepseek-harness-on-vue/ref_repos/pi-mono/packages/ai/src/types.ts:124), [userscript risks](/Users/hrz/Documents/GitHub/deepseek-harness-on-vue/conversations/260819-vue-harness-poc/调研报告-Self-Modifying-Agent寄生任意Vue网站.md:91).

**Verdict**
The rewrite should proceed, but change these before implementation:

1. Do not make slot text the primary prompt/tool prose API.
Use `<PromptSection name order :text="...">` and `<AgentTool name :description="..." ...>` as the stable path. Slot text can be sugar, but only for plain text/interpolation and should fail loud on component VNodes. “Render to `display:none` then read textContent” is a timing and DOM-flush trap.

2. Add registry invariants now.
Duplicate tool names, duplicate prompt section names, non-finite orders, invalid schemas, and ambiguous order ties must surface as harness errors before a model request. Harness does this for prompt sections: duplicate names and bad orders throw, and complete sections have strict semantics. Your collector plan is currently too loose.

3. Snapshot contributions per request.
At `llm/request`, freeze the assembled prompt and tool table. Tool execution should use the same snapshot the model saw, or you will get mid-turn races when HMR/v-if removes a tool after the model selected it.

4. Keep declarative contributions, but make composables equal citizens.
The declarative model is Vue-native and good for DevTools/HMR. But some plugins will be logic-only, and forcing them through renderless VNodes is artificial. Implement both faces over the same validated registry.

5. Move `collector` out of the conceptual kernel.
The minimal kernel is `services`, `bus`, `host`, and maybe `compile`. `collector` is a reusable registry helper used by `tools` and `prompt`, not a cordis-equivalent primitive. More important kernel work: guarded service overwrite/delete, better waterfall diagnostics, and async-error attribution.

**Specific Weaknesses**
`provideService()` needs token-guarded cleanup. The current PoC pattern deletes by name on unmount; if a replacement service is installed before the old owner unmounts, the old cleanup can delete the new service.

The raw `waterfall(next)` API is powerful but dangerous for agent-authored plugins. Forgetting `next()` silently vetoes. Keep it for harness fidelity, but expose safer helpers for common policy: `useToolGuard({ match, deny })`, `useRequestTransform(fn)`, etc. Also detect double `next()` and log listener exceptions with the owning plugin.

pi-ai as the only real LLM engine is reasonable, but “no fallback” is bad demo engineering. The PoC’s SSE fallback handles custom OpenAI-compatible endpoints and package failure. If you want only one real engine, add a tiny `mock/faux llm` plugin for offline smoke tests and demos. Also pin pi-ai and do a browser-build spike first; current docs emphasize `createModels()`, and DeepSeek’s provider hardcodes `https://api.deepseek.com`, while the plan wants configurable `baseURL`. pi-ai does support custom `fetch`, which is good for a GM transport shim, but streaming `GM_xmlhttpRequest` as a fetch-compatible `ReadableStream` still needs a spike.

For OPFS, keep the raw code for Phase 1. ZenFS is too much unless you need POSIX-like APIs. `opfs-tools` is closer, but the npm page currently shows “License: none”, which is a serious dependency risk unless verified upstream. Your existing OPFS layer is small, understood, and tailored to reactive HMR.

Runtime compilation has two missed traps. First, `globalThis.Vue` will collide with host pages in Phase 2. Use a namespaced global like `globalThis.__HARNESS__.Vue`. Second, “Blob import + new Function fallback” does not solve strict CSP. Strict CSP often blocks both `blob:` and `unsafe-eval`; userscript sandbox mode may avoid page CSP, but `MAIN_WORLD` may not. Treat CSP as a Phase 2 spike, not a solved fallback.

Phase 2 readiness is mostly okay, but hardcoded Teleport selectors hurt. In arbitrary pages, IDs collide and Shadow DOM isolation matters. Prefer injected region elements (`:to="regions.sidebar"`) over `to="#region-..."`. Phase 1 can still use Teleport, but pass actual targets through a layout service.

The plan underplays security. Self-modifying plugins are arbitrary same-origin code with access to localStorage, OPFS, page state, and probably the API key. That may be acceptable for a demo, but state it as the trust model. For Phase 2, API keys must move to userscript/extension storage, not page localStorage.

Manual testing only is too weak for the rewrite. Keep `docs/TESTING.md`, but add one keyless smoke: build, open app, mount a synthetic plugin with tool + prompt section, toggle v-if contribution, write broken source, verify rollback. This catches the exact failure modes the architecture depends on.

Sources checked externally: pi-ai package/docs on [npm](https://www.npmjs.com/package/%40earendil-works/pi-ai?activeTab=readme) and [GitHub](https://github.com/earendil-works/pi), OPFS wrapper docs for [opfs-tools](https://www.npmjs.com/package/opfs-tools?activeTab=readme) and [ZenFS](https://zenfs.dev/core/).

**Top 5 takeaways, ranked by importance.**
1. Keep declarative contributions, but use explicit `text`/`description` props as the canonical API; slot text is only sugar.
2. Add fail-loud registry invariants and per-request snapshots before wiring the loop.
3. pi-ai-only is fine for the real engine, but add a mock/offline LLM and pin + smoke-test the pi-ai browser path.
4. Raw OPFS is the right Phase 1 choice; wrappers do not yet buy enough.
5. Phase 2 needs Shadow DOM/target-element Teleports, namespaced globals, and a real CSP/GM streaming spike.
