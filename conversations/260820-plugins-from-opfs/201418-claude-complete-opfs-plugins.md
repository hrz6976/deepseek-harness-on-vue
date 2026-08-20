# Handoff Note — 201418 · claude · complete-opfs-plugins

## Inherited context

Same session as `201340-claude-researched-opfs-plugins.md` (investigation) and `201359-claude-drafted-impl-plan.md` (executable plan). User decisions honored: dumb boot in `kernel/boot.js` (two-stage bootloader deferred, documented in 201340), always load from OPFS, `?reset` as the only escape hatch. Mid-investigation another session landed the `state`/`read_state` feature (host.js `exposedStates`, state.js, read-state.js) — absorbed into this refactor as one more seeded plugin.

## Work done this session — ALL PLAN STEPS COMPLETE

- [x] **Step 0**: baseline commit `37eed02` (tree was 40/40 green, nothing committed since `2c195a5`).
- [x] **Step 1** (`bbc9683`): `getCollector(kind)` kind-keyed singleton registry in `kernel/collector.js`; new `kernel/contrib.js` owns `AgentTool`/`PromptSection`/`useTool`/`usePromptSection`/`useLayoutTarget`; tools.js/prompt.js keep only the services; `ui/layout.js` deleted; loop/UI plugins/main.js/tests repointed.
- [x] **Step 2** (`b8b5f99`): `kernel/modules.js` frozen registry (vue, pi-ai + `.lazy` subpath, `kernel/{services,bus,log,collector,host,contrib,compile,boot}`); `compile.js` `rewriteImports` — pinned single-line named/namespace/default forms → `globalThis.__harness.modules[...]` reads, leading-block-only scan (template literals immune), kernel paths normalized from any depth, unknown/cross-plugin specifiers throw listing allowed keys; `//# sourceURL=harness-plugin://<name>` stamped. The `modules.js ↔ compile.js`/`boot.js` import cycles are benign (call-time reads only) — verified by build + runtime.
- [x] **Steps 3–5** (`89465fe`): `kernel/boot.js` (`?reset` → wipe `.plugins/` + strip param via replaceState, localStorage survives; write-if-missing seeding; `.format` = `'2'`; format mismatch boots from SHIPPED defaults with files kept; fail-soft per-plugin mount; waits reactively for the fs service — it appears only when the fs component renders). manager.js slimmed to policy: `mount(name, config)`/`unmount` (file kept, no surprise-remount later — reload() baselines unmounted files without mounting), reloads **deferred while `loop.running`** and flushed after, self-HMR-capable (adopts existing files from `fs.list()` on setup). llm.js: default export with `props: { cfg }` (PluginHost passes `entry.config` as props; config survives HMR via entry-reuse), `makeLlmPlugin` kept for tests. settings.js connects via `manager.mount('llm', { cfg })`. Plugin names flattened (`tool:x`/`ui:x` → `x`); every seeded file got `export default`. build.mjs embeds sources as `virtual:plugin-defaults` (`ON_DEMAND = {llm}` → `autoMount:false`); main.js keeps ONLY the fs static import + `boot(defaults)`; badge = `core`/`user` from the manifest. RECIPE/file-editor/remove-plugin prose updated (core plugins are editable examples; remove core = factory copy on refresh).
- [x] **Step 6** (`72d59d9` docs): `tests/boot.test.js` — 10 new tests (seed/no-clobber/extras-order/format-fallback/fail-soft/?reset; manager config-through-HMR, unmount-no-surprise-remount, defer-while-running, broken-edit rollback). **55/55 node tests.** **Browser smoke 18/18** in real Chrome (fresh profile): cold-boot seeding (18 files), all core services from OPFS, llm seeded-not-mounted, core badges, mock connect through manager.mount, mock agent round with real run_js Worker (42), core-plugin HMR via fs edit, broken-chat rollback badge, reload skips broken core + rest up + edit persisted, create/remove dynamic plugin, `?reset` factory restore incl. localStorage + URL-strip, zero unexpected console errors. Script: scratchpad `opfs-smoke.mjs` (session-temp; needs `npm i --no-save playwright`, Chrome channel; server was `serve.mjs 7103`, killed after). Docs: TESTING.md scenarios 19–22 + 7 new invariant lines; README OPFS/dialect-v2 bullets; cordis-to-vue.md item 8.

## Current state

`npm test` 55/55 · `npm run build` green · smoke 18/18 · all committed through `72d59d9` on `main` (not pushed; no remote configured). `dist/main.js` still ~1.1MB dev (sources-as-text add ~100KB pre-bundle).

| Area | Where things live now |
|---|---|
| Bundled ("kernel") | `src/kernel/{log,services,bus,collector,host,compile,contrib,modules,boot}.js`, `src/plugins/fs.js`, `src/entries/standalone/{main.js,index.html}`, Vue, pi-ai |
| Seeded to OPFS `.plugins/` | tools, prompt, manager, state, loop, compaction, llm (`autoMount:false`), create-plugin, file-editor, read-state, remove-plugin, run-js, settings, chat, files, preview, syslog |
| Build | `build.mjs` `pluginDefaults` esbuild plugin → `virtual:plugin-defaults` |

## Key decisions (beyond the two plan notes)

| Decision | Rationale |
|---|---|
| boot waits reactively (`watch`) for the fs service | Services are provided at component RENDER, one pass after `mountPlugin('fs')` — grabbing synchronously was a real bug caught pre-smoke |
| Frame badge derives from the manifest, not `entry.builtin` | manager-mounted plugins (llm) would otherwise show `user`; host keeps accepting `builtin` for compat |
| `manager.remove` on a core plugin allowed | File deleted now, factory copy reseeds next boot — documented in the tool description as intentional semantics |
| `reload()` of an unmounted file only refreshes the baseline | Otherwise editing `.plugins/llm.js` while disconnected would surprise-mount llm configless |
| HMR defer applies to ALL plugins during a run, not just loop | Remounting chat/tools mid-run is equally disruptive; single code path in `scheduleReload` |
| Seeded files keep named exports + trailing `export default X;` | Node tests import the named symbols; the runtime compiler needs the default; translateESM handles both |

## Traps for the next agent

- **Dev workflow**: seeding is write-if-missing — after editing a shipped plugin in the repo, reload with `?reset` or the browser keeps the old OPFS copy. (README documents this.)
- `tests/boot.test.js` calls `managerPlugin.setup()` outside a component: Vue warns about `onUnmounted` — harmless, expected.
- The smoke script's "console errors" check must whitelist the intentional broken-chat log lines; anything else is a real failure.
- `import` rewriting only scans the leading block — an import statement AFTER the first non-import line is a silent no-op that then fails at runtime module load (blob path, bare specifier). Dialect docs say top-of-file; keep it that way.
- Port hygiene: `pkill -f "serve.mjs <port>"` after smoke runs (orphaned 7100 server bit two earlier sessions).

## Open tasks for the next agent

1. **Live checks** (need key/credential): TESTING.md 17 (compaction live), 1–2/8–10 live leftovers, and a live run exercising a CORE-plugin edit by the actual model ("edit your own persona in .plugins/loop.js" is a good demo).
2. TESTING.md 13 (forced `new Function` path in browser), 15 (DevTools), 22 manual spot-check (defer-while-running in browser; node-tested).
3. Optional: `--minify` build target; settings UI for compaction knobs; `reset_plugin`-style per-plugin factory reset tool (currently only global `?reset` + remove/refresh).
4. Phase 2 (userscript entry) per `implementation-plan.md` — `kernel/boot.js` is entry-agnostic by design: Phase 2 mounts its own fs backend (GM storage) and calls `boot(defaults)`.
5. Someday/deferred: the two-stage bootloader (`.boot/loader.js` + watchdog + A/B slots) — design recorded in `201340-claude-researched-opfs-plugins.md`; retrofit = swap boot's mount phase for "run the stage-1 loader".

## Blockers

- (none)

## Suggested next step

Run the app (`npm run dev`, mock engine) and ask the agent to read `.plugins/loop.js` and change its own persona prompt section — the one-sentence demo of what this refactor bought.
