# Handoff Note — 201340 · claude · researched-opfs-plugins

## Inherited context

New thread based on `conversations/260820-streamlined-poc/201234-claude-complete-phase1.md` (Phase 1 complete: kernel + built-in plugins, 36/36 tests, smoke green) and `201329-claude-complete-compaction.md` (compaction plugin added; nothing committed since `2c195a5`). A `state` plugin (`src/plugins/state.js` + `exposedStates` in host.js) appeared from another session mid-investigation — it follows the same import patterns and migrates like the rest.

Question investigated: **move every plugin except the kernel to initial OPFS state, loaded by the kernel at runtime, so the agent can modify builtin tools.**

## Verdict

Feasible. Two structural prerequisites, then mechanical migration. Scope was deliberately SIMPLIFIED with the user (this session, after discussion): a fancy two-stage bootloader (ROM + OPFS stage-1 + watchdog/A-B/boot-counter handshake) was designed, judged sound, and then **deferred as too complicated for a PoC**. Settled design: a ~40-line "dumb boot" in the kernel, always load from OPFS, `?reset` as the only escape hatch. The two-stage design remains a documented future upgrade (swap dumb-boot step 3 for "run `.boot/loader.js`").

## Why it doesn't work as-is

Built-ins are static ESM imports bundled via `main.js`. They violate the dynamic-plugin dialect (no imports, `__harness` only) four ways:

1. **npm imports**: `vue` everywhere; `@earendil-works/pi-ai` (+ `.lazy` subpath) in llm.js/compaction.js. Must stay bundled, shared single instances (two Vues silently breaks reactivity).
2. **Kernel imports**: `../kernel/*.js` in every plugin.
3. **Cross-plugin imports**: loop.js→`usePromptSection` (prompt.js); ui/settings.js→`makeLlmPlugin` (llm.js); all UI panels→`useLayoutTarget` (ui/layout.js); main.js registers `AgentTool`/`PromptSection` globally from tools/prompt exports.
4. **Module-scope collectors** (`tools.js:13`, `prompt.js:10`) — worst trap: an OPFS reload creates a NEW empty collector, orphaning every other plugin's registered tools/sections.

Plus: llm is mount-on-connect (settings passes frozen cfg) → needs an autoMount exception. Chicken-and-egg: fs must stay bundled; something bundled must seed first-boot OPFS.

## The plan (simplified, settled)

Kernel (bundled) = `kernel/*` + Vue + pi-ai + fs plugin + dumb boot + entry frame. Everything else — tools, prompt, llm, loop, compaction, manager, state, all `tool:*`, all `ui:*` — is seeded into `.plugins/` and loaded through the same compile path as agent-created plugins.

### Step 1 — kernel-owned contribution ABI (pure move, no behavior change)

- `kernel/collector.js`: keyed registry — `getCollector(kind)` returns the existing singleton (survives plugin reloads; fixes trap 4).
- New `kernel/contrib.js`: `AgentTool`, `PromptSection`, `useTool`, `usePromptSection`, `useLayoutTarget` move here (stateless glue over reactive registries = the stable ABI; fixes trap 3). tools.js/prompt.js keep the agent-editable *services* (snapshot/assemble policy).
- main.js registers globals from kernel. Tests stay green.

### Step 2 — import-rewriting compiler (dialect v2)

Chosen over rewriting plugins to the no-import dialect: files stay valid ESM → node tests import `src/plugins/*.js` unchanged, repo source == OPFS seed verbatim, agent reads `.plugins/*.js` as working examples.

- New `kernel/modules.js`: frozen `__harness.modules` registry: `'vue'`, `'@earendil-works/pi-ai'`, `'@earendil-works/pi-ai/api/openai-completions.lazy'`, `'kernel/services'`, `'kernel/bus'`, `'kernel/log'`, `'kernel/collector'`, `'kernel/host'`, `'kernel/contrib'`.
- `compile.js` transform, applied before BOTH blob and `new Function` paths:
  - `import { a, b as c } from 'x'` → `const { a, b: c } = __harness.modules['x'];`
  - `import * as ns from 'x'` → `const ns = __harness.modules['x'];`
  - `import d from 'x'` → `const d = __harness.modules['x'].default ?? __harness.modules['x'];`
  - Specifier normalization: any path ending `kernel/<name>.js` → `kernel/<name>`; npm ids verbatim. Unknown specifier → loud error listing allowed keys. Only the leading import block is transformed (template-literal `import` text immune).
- Cross-plugin imports stay banned (module-identity/HMR-ordering tar pit; step 1 removed the need).
- `//# sourceURL=harness-plugin://<name>` appended (named DevTools stack frames; esbuild sourcemaps are lost for plugins).
- `PLUGIN_FORMAT_VERSION` → `'2'`.

### Step 3 — dumb boot (~40 lines, kernel)

`await fs.ready` → **seed** (write `.plugins/<name>.js` only if missing) → format check → compile+mount every `.plugins/*.js` except `autoMount:false` → done. Boot-compile failure: log + skip (manager's existing restore behavior) — rest of app comes up.

- Manager (now itself OPFS-loaded) keeps create/remove + HMR watchers; on mount it attaches watchers to ALL `.plugins/*.js` from `fs.list()` (including itself). Its old boot-restore block moves to kernel boot.
- **llm on-demand**: manifest `autoMount:false`; settings calls `manager.mount('llm', cfg)`; llm.js becomes default-export component with `props: { cfg }` — PluginHost already passes `plugin.config` as props (`host.js:47`); `loadAndMount`'s entry-reuse preserves config across HMR. Keep `makeLlmPlugin` named export for tests.
- DROPPED for PoC (recorded so nobody re-adds them casually): watchdog/boot-counter/A-B slots, `?safe` mode, hash-manifest auto-upgrade (stale seeded defaults after a new build are handled by `?reset`), per-plugin reset UI, boot log.

### Step 4 — build embedding + `?reset`

- `build.mjs`: esbuild plugin generates virtual module `virtual:plugin-defaults` = `{ name: { source, autoMount } }` from `src/plugins/**/*.js`. main.js drops all static plugin imports.
- **`?reset`** (the one escape hatch, ~5 lines): wipe `.plugins/` + reseed + reload. Loses agent-created plugins (acceptable factory-reset semantics); preserves localStorage (API key/config) — which DevTools "clear site data" would not.

### Step 5 — migrate plugin sources

Delete cross-plugin imports in favor of `kernel/contrib`; llm.js props change; manager slimming; include `state.js`. Frame badge: `built-in`/`dynamic` → `core` (seeded) / `user` (agent-created), derived from the defaults manifest. Filename slugging for `tool:x`/`ui:x` names (`:` → `--` or flatten). Update create-plugin RECIPE: dialect now allows the pinned imports; point the agent at `.plugins/` sources as examples.

### Step 6 — tests, smoke, docs

- Unit: import transform (4 forms + unknown-specifier rejection + template-literal immunity), collector singleton across reload, seed-if-missing/never-overwrite, llm config survives HMR, `?reset`.
- Smoke: edit `.plugins/<run-js>.js` via file-editor → HMR → changed behavior; break a UI plugin → boot skips it, app up; `?reset` restores.
- TESTING.md scenarios, README, cordis-to-vue.md.

## Key decisions

| Decision | Rationale |
|---|---|
| Import-rewrite dialect over no-import rewrite | Files stay valid ESM → tests unchanged; repo == seed verbatim; agent reads real sources as examples |
| Collectors + contribution glue into kernel | Module-scope collectors would be re-created on OPFS reload, orphaning all registrations; the ABI must outlive the plugins |
| Dumb boot; two-stage ROM+bootloader+watchdog design deferred | User: too complicated for PoC. Design is sound (firmware A/B-slot pattern) and retrofittable later by swapping boot step 3 for "run `.boot/loader.js`" |
| Always load from OPFS; `?reset` only escape hatch | Compile failures at boot are skipped harmlessly; the compiles-but-broken-UI case is recovered by `?reset` without losing localStorage config |
| Seed-if-missing only, no hash upgrade | Stale defaults after a new build = `?reset`; PoC doesn't need dotfile-manager semantics |
| No cross-plugin imports in the dialect | Module identity + HMR ordering between runtime modules is a tar pit; services/contrib registry is the sanctioned coupling |
| fs + compile pipeline stay bundled forever | fs: chicken-and-egg; compile: a bootloader can't recover from a compiler that can't compile the recovery |

## Risks / open points

1. **HMR of loop.js mid-run**: watcher fires while `running.value` → remount kills the run's wiring. Recommend manager defers reload while loop runs (watch `running`, queue). Decide during step 3.
2. **Manager self-HMR** (agent edits manager.js): should work (unmount stops watchers, new instance re-attaches from `fs.list()`) — needs an explicit test.
3. Kernel grows ~230 → ~400 lines (contrib/modules/boot). Soft budget; accept.
4. **Commit first**: tree holds Phase 1 + compaction + state, green, nothing committed since `2c195a5`. Start this refactor from a committed baseline.

## Blockers

- (none) Plan settled with the user this session (simplification explicitly chosen by the user).

## Suggested next step

Commit the current tree, then implement steps 1–2 (pure-move + compiler) — both fully testable without touching boot — then 3–6.
