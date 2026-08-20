# Handoff Note — 201359 · claude · drafted-impl-plan

## Inherited context

Same session as `201340-claude-researched-opfs-plugins.md` (read it first — it holds the investigation, the four dialect violations, the settled scope, and the deferred two-stage-bootloader design). This note is the **executable implementation plan** for: every plugin except the kernel lives in OPFS `.plugins/`, seeded on first boot from sources embedded in the bundle, loaded through the dynamic-plugin compile path — so the agent can edit builtin tools/loop/UI with the same file-editor + HMR flow it already has for its own plugins.

Settled scope (user decisions): dumb boot, always load from OPFS, `?reset` as the only escape hatch. NO watchdog/safe-mode/hash-upgrade (deferred, see prior note). Kernel keeps: `kernel/*`, Vue, pi-ai, fs plugin, boot, entry frame.

## Step 0 — baseline commit

Working tree holds Phase 1 + pi-auth + compaction + state plugin, all green, nothing committed since `2c195a5`. Commit it as-is before touching anything (user has signaled agreement; confirm if in doubt). Then `npm test` (expect 36+/36) and `npm run build` green before starting.

## Step 1 — kernel-owned contribution ABI (pure move; tests stay green)

**`src/kernel/collector.js`**: add a keyed singleton registry so a collector survives reload of the plugin file that uses it:

```js
const registry = new Map();
export function getCollector(kind) {
  let c = registry.get(kind);
  if (!c) { c = createCollector(kind); registry.set(kind, c); }
  return c;
}
```

**New `src/kernel/contrib.js`**: move here, verbatim where possible:
- `useTool`, `AgentTool` (from tools.js) — now `getCollector('tool')`
- `usePromptSection`, `PromptSection` (from prompt.js) — now `getCollector('prompt section')`
- `useLayoutTarget` (from ui/layout.js; delete that file — it contains nothing else)

**Update importers**: tools.js/prompt.js use `getCollector(...)` (drop their module-scope `createCollector` — this is the fix for the orphaned-collector trap); loop.js imports `usePromptSection` from `../kernel/contrib.js`; ui/{chat,files,preview,settings,syslog}.js import `useLayoutTarget` from `../../kernel/contrib.js`; main.js registers `AgentTool`/`PromptSection` from kernel/contrib and puts the composables on `__harness` from there. Do NOT add re-exports in tools.js/prompt.js (the fallback `translateESM` can't handle `export { x }` lists; update the tests' imports instead).

**Verify**: `npm test`, `npm run build`, quick manual boot. No behavior change expected.

## Step 2 — import-rewriting compiler (dialect v2)

**New `src/kernel/modules.js`** — the shared-instance registry (statically imported once → bundled once):

```js
import * as Vue from 'vue';
import * as pi from '@earendil-works/pi-ai';
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions.lazy';
import * as services from './services.js';   // …bus, log, collector, host, contrib
export const modules = Object.freeze({
  'vue': Vue,
  '@earendil-works/pi-ai': pi,
  '@earendil-works/pi-ai/api/openai-completions.lazy': openaiCompletions,
  'kernel/services': services, 'kernel/bus': bus, 'kernel/log': log,
  'kernel/collector': collector, 'kernel/host': host, 'kernel/contrib': contrib,
});
```

main.js adds `modules` to `__harness` (before the freeze).

**`src/kernel/compile.js`** — `rewriteImports(source)`, applied before BOTH the blob path and the `new Function` fallback (bare specifiers can't resolve in blob imports anyway). Pinned, single-line import forms only, processed only in the leading block (imports/comments/blank lines before the first other statement — keeps template-literal `import` text immune):

| Form | Rewrite |
|---|---|
| `import { a, b as c } from 'x';` | `const { a, b: c } = __harness.modules['x'];` |
| `import * as ns from 'x';` | `const ns = __harness.modules['x'];` |
| `import d from 'x';` | `const d = __harness.modules['x'].default ?? __harness.modules['x'];` |

Specifier normalization: anything matching `/(?:^|\/)kernel\/(\w+)\.js$/` → `kernel/$1`; npm ids verbatim. Unknown specifier → throw listing the allowed keys (this is the loud-fail for cross-plugin imports, which stay banned — services/contrib registry is the sanctioned coupling). Append `\n//# sourceURL=harness-plugin://<name>` in `compilePlugin` (plugins lose esbuild sourcemaps; this keeps DevTools frames named).

**Verify**: new unit tests (see step 6); existing dynamic-plugin tests unaffected (no-import sources pass through the rewriter untouched).

## Step 3 — dumb boot in kernel; manager slims; llm on-demand

**Plugin renames first** (OPFS filename = plugin name + `.js`; drop the `:` prefixes rather than inventing a slug scheme — agent-created names already can't contain `:` per manager's regex, so no collision class exists): `tool:file-editor`→`file-editor`, `tool:run-js`→`run-js`, `tool:create-plugin`→`create-plugin`, `tool:remove-plugin`→`remove-plugin`, `ui:settings`→`settings`, `ui:chat`→`chat`, `ui:files`→`files`, `ui:preview`→`preview`, `ui:syslog`→`syslog`. Grep tests/docs/smoke scripts for the old names.

**New `src/kernel/boot.js`** (~40 lines):

```js
export const PLUGIN_DIR = '.plugins/';
export const PLUGIN_FORMAT_VERSION = '2';   // moves here from manager.js; bumped for dialect v2
export async function boot(defaults /* { name: { source, autoMount } } */) { ... }
```

1. `?reset` handling FIRST: if `new URLSearchParams(location.search).has('reset')` → after `fs.ready`, remove every `.plugins/*` file, then `history.replaceState` to strip the param (or a refresh re-wipes). localStorage untouched (API key/config survives — the whole point vs DevTools clear-site-data).
2. Seed: for each default, `if (fs.read(PLUGIN_DIR + name + '.js') == null) await fs.write(...)`. Write `.format` = `'2'` if missing.
3. Format check: mismatch → log loudly and **compile the embedded defaults instead of OPFS contents** (old behavior "skip restore, keep files" would now mean an empty app), tell the user to `?reset`.
4. Mount: compile + mount every `.plugins/*.js` — seeded and agent-created alike — EXCEPT names with `autoMount: false` in the manifest (llm). Compile failure → log + skip, rest of the app comes up (today's restore semantics). Mount order irrelevant (readiness-driven services), iterate manifest order then extras for determinism.

**`src/plugins/manager.js`** slims to policy: delete the boot-restore IIFE and format constants (moved to boot). On mount, rebuild its state from reality: for each `.plugins/*.js` in `fs.list()` → `loaded.set(name, { source: fs.read(path) })` + `attachWatcher(name)` (including watching **itself** — self-HMR is expected to work: unmount stops watchers, the new instance re-attaches; test it). Add to the service:

- `mount(name, config)` — read `.plugins/<name>.js`, compile, `mountPlugin(name, def, { config })`, attach watcher. Used by settings for llm.
- `unmount(name)` — unmount the component, **keep the file**, stop the watcher and drop the `loaded` entry (edge case found in design: if the watcher stayed attached while llm is disconnected, an agent edit to llm.js would HMR-mount it configless).
- `remove(name)` stays as-is (unmount + delete file).

**HMR-while-running guard** (risk #1 from prior note, ~6 lines): in `reload()`, if `services.get('loop')?.value?.running?.value`, queue the reload and flush it on a one-shot `watch` of `running` → false. Applies to ALL plugins, not just loop — remounting chat/tools mid-run is equally disruptive now that they're editable.

**`src/plugins/llm.js`**: default export becomes a component taking config via props (PluginHost already passes `plugin.config` as props, `host.js:47`; manager's entry-reuse in `loadAndMount` preserves `config` across HMR):

```js
function setupLlm(cfg) { /* current makeLlmPlugin body */ }
export default { name: 'llm', props: { cfg: Object }, setup: p => setupLlm(p.cfg ?? {}) };
export const makeLlmPlugin = cfg => ({ name: 'llm', setup: () => setupLlm(cfg) });  // kept for tests
```

**`src/plugins/ui/settings.js`**: connect → `services.get('manager')?.value?.mount('llm', { cfg: { ...cfg } })`; disconnect → `manager.unmount('llm')`. Drop the `makeLlmPlugin`/`mountPlugin` imports.

**`src/entries/standalone/main.js`**: drops all 15+ static plugin imports; keeps fs (bundled bootstrap); mounts fs, awaits nothing else, calls `boot(defaults)` (deferred past first render like today's auto-reconnect — mountPlugin mutates the array the frame iterates, `nextTick`). Badge semantics: `core` (name in defaults manifest) / `user` (agent-created) instead of `built-in`/`dynamic`.

## Step 4 — build embedding

**`build.mjs`**: esbuild plugin resolving `virtual:plugin-defaults` — at build time, read every `src/plugins/**/*.js` (excluding `fs.js`, which stays bundled-only), emit `export default { "<basename>": { source: <JSON string>, autoMount: <bool> } }`. Name = filename minus `.js` (renames in step 3 made this hold). `const ON_DEMAND = new Set(['llm'])`. Register the files via `onLoad`'s `watchFiles` so `--watch` rebuilds on plugin edits.

**Dev-workflow note (important, document in README)**: seeding is write-if-missing, so after editing a builtin source in the repo, the running app keeps the OPFS copy — reload with `?reset` to adopt the new default. This is the accepted PoC cost of dropping hash-upgrade.

## Step 5 — migrate the plugin sources

Mostly done by steps 1–3; sweep the rest:
- Every `.plugins/`-bound file: imports must be single-line, pinned forms, registry specifiers only (`vue`, pi-ai ids, `kernel/*`). `state.js` (new since the survey; reads `exposedStates` from kernel/host — registry has it) migrates like the rest.
- `create-plugin.js` RECIPE: dialect v2 — pinned imports now allowed (show the three forms + allowed specifiers), and add "read the sources in `.plugins/` (e.g. `.plugins/run-js.js`) as working examples — you can also EDIT them; edits hot-reload."
- `file-editor.js` description: mention builtin plugin sources are editable and hot-reload.
- Frame `<h1>`/sub copy in main.js if it still says "built-in".

## Step 6 — tests, smoke, docs

**Unit (node, `npm test`)**:
- rewriteImports: all 3 forms, aliased named imports, kernel-path normalization from both `../kernel/` and `../../kernel/` depths, unknown specifier throws listing keys, `import` inside a template literal untouched, no-import source passes through byte-identical.
- `getCollector` returns the same instance across calls; contributions survive a simulated plugin-module reload.
- `boot()` with a fake fs object: seeds missing files, never overwrites existing, skips `autoMount:false`, format-mismatch path compiles defaults, compile-failure skips and continues.
- manager: `mount('llm', {cfg})` config survives HMR reload; `unmount` keeps file + stops watcher (edit after unmount does NOT remount); self-HMR of manager.js; reload deferred while `loop.running`.
- Existing tests: update imports of `useTool`/`usePromptSection` to `kernel/contrib`, plugin-name renames, llm default-export shape.

**Browser smoke (playwright, scratchpad script like prior sessions)**: boot from empty OPFS → all panels up and `.plugins/` populated in the files panel; refresh → still up (loads from OPFS, no reseed); file-editor edits `.plugins/run-js.js` (e.g. change the timeout message) → HMR badge-free reload → behavior change observable; break `chat.js` syntax via editor → HMR rollback keeps old version running; corrupt it in OPFS + refresh → boot skips it, rest of app up; `?reset` → factory state, localStorage config intact; mock-agent round still green; create/remove dynamic plugin still green.

**Docs**: TESTING.md new scenarios (seed, edit-builtin HMR, boot-skip, `?reset`); README (architecture: what's kernel vs OPFS, dev-workflow `?reset` note); cordis-to-vue.md "what the rewrite added".

## Key decisions (carried from 201340, do not relitigate)

| Decision | Rationale |
|---|---|
| Import-rewrite dialect, not no-import rewrite | Sources stay valid ESM: node tests import them unchanged; repo == seed verbatim; agent reads real sources as examples |
| Collectors/glue to kernel BEFORE anything loads from OPFS | Module-scope collectors would orphan all registrations on reload |
| Dumb boot; two-stage bootloader deferred | User: too complicated for PoC; retrofittable (swap boot's mount phase for "run `.boot/loader.js`") |
| `?reset` only escape hatch; seed-if-missing only | Compiles-but-broken UI recovered without losing localStorage; stale defaults handled the same way |
| fs + compile pipeline bundled forever | fs: chicken-and-egg; compile: can't recover from a compiler that can't compile the recovery |
| Flat plugin names (drop `tool:`/`ui:`) | OPFS filename = name; agent name-regex already bans `:` so no collision class |

## Open tasks for the next agent

1. Step 0: commit baseline, verify green.
2. Steps 1–2 (order matters; each independently verifiable with `npm test` + build).
3. Steps 3–4 together (boot + embedding are coupled: boot consumes the virtual module).
4. Steps 5–6, then full smoke; update TESTING.md ✅ marks.
5. Commit per step or at least per pair — this refactor rewires the entry point; bisectability matters.

## Blockers

- (none)

## Suggested next step

Step 0 (baseline commit), then step 1 — the collector/contrib move is pure and de-risks everything after it.
