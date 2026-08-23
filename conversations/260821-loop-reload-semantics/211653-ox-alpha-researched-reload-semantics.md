# Handoff Note — 211653 · ox-alpha · researched-reload-semantics

## Inherited context

Same session as `conversations/260821-poc-dependency-simplification/211625-ox-alpha-refactored-deps.md` (single pi-ai engine, MCP/openai-SDK removal — still uncommitted). After that handoff, the user drove four follow-up investigations: (1) architecture documentation, (2) plugin disable + dependency-DAG semantics, (3) how tool-schema changes reach a running agent (with a code fix), (4) Vue-reactivity internals and capability comparison vs deepseek-harness/cordis.

## Work done this session

- [x] **`docs/harness-architecture.md`** (NEW): ASCII diagrams of the full stack (trusted shell → broker → sandbox kernel → content script), the plugin-array-as-component-tree trick, the cordis→Vue mapping picture, the self-modification pipeline (bundle → OPFS seed → same compile pipeline), and the trust-boundary table.
- [x] **Investigated mid-run schema-change propagation across all three codebases**:
  - *cordis* (`ref_repos/cordis/packages/core/src/reflect.ts` `notify()`): PUSH — walks fibers injecting changed service names, `_checkImpl` + `_refresh()` re-fires dependents; `fiber.update()` restarts.
  - *deepseek-harness* (`packages/core/agent-loop/src/agent.ts` `preStep()`, `system-prompt/src/index.ts`): PULL — tool schemas are providers evaluated at each assembly; assembly runs **per step**, so every model call sees fresh schemas despite cordis offering push.
  - *ours* (`src/plugins/loop.ts`): PULL — `toolsSvc.snapshot()` inside the turn loop; freeze window is ONE LLM request.
- [x] **Fixed over-broad HMR deferral** (`src/plugins/manager.ts`): previously ANY plugin edit mid-run was deferred until run end, silently from the model. Now only `loop` defers (remount would recreate `messages` + revoke the running service); tools/prompt/manager edits hot-reload immediately and are visible NEXT turn. Guidance prompt updated in `src/plugins/tools/file-editor.ts`; test rewritten in `tests/boot.test.ts` ("only the loop plugin defers mid-run"). All green: 68 pass / 0 fail, typecheck + 3 builds ✅.
- [x] **Answered (no code change needed)**:
  - *Disable without OPFS delete*: YES at runtime (`manager.unmount`, file kept; llm connect/disconnect is built on it), but NOT persistent across reloads — `boot()` mounts every `.plugins/*.js`; only build-time `autoMount:false` is excluded. Minimal fix if wanted (~10 lines): persisted `public.disabled-plugins` list checked by boot.
  - *DAG dependencies*: deliberately absent. Reactive registry subsumes ordering for any acyclic graph (readiness via `useService` computeds); cycles can't deadlock (null-until-present). Given up vs cordis: no dependent-cascade on unmount, no declared/inspectable edges. Cheap upgrade if ever needed: `requires: string[]` field checked at mount (~15 lines). Full cascade disposal deliberately skipped.
  - *Vue semantics*: collector IS a reactive source (`shallowReactive(Map)`); chain = Proxy set trap → `trigger` → dep Links → scheduler microtask queue. The loop canNOT be notified because async event-handler code has no `activeEffect` — reads there are untracked. Push is used where consumers are views (PluginHost error cards, `serviceReady` watch, HMR flush watch, syslog autoscroll); pull at turn boundaries for orchestration. Correction recorded: `prompt.assemble()` is currently a plain per-request call, NOT a computed (docs said computed) — one-line change if a live consumer appears.
  - *Delta injection*: full re-collection AND full re-send per turn — correct, because the completions API is stateless (no tools/prompt delta op exists). Real cost lever is prefix stability → DeepSeek auto context caching; our deterministic `(order, name)` section sort + append-only messages keep the prefix cacheable. One cache-buster: each mid-run plugin edit costs ~one uncached request.
  - *Capability comparison*: our plugin surface (tools, prompt sections, services DI, UI panels, 5 waterfall points, expose/read_state, props config, OPFS self-modification) is architecturally equivalent to deepseek-harness's extension points (`extensions/tool-cordis` ≈ our manager/create_plugin/read_state); we are MORE radical there (everything hot-reloadable incl. loop/chat vs their node:vm dynamic packages). Missing: their depth (tool guard/around/post pipelines, output validation, cancellation states, scheduler) and product breadth (sessions, subagents, skills, hooks, credentials, sandboxes).

## Key decisions

| Decision | Rationale |
| -------- | --------- |
| Pull-per-turn beats push for the loop | Turn boundaries are the only safe application points; push to async control flow adds races, not freshness. deepseek-harness reached the same conclusion despite cordis offering push |
| HMR deferral narrowed to `loop` only | Snapshot already protects "tool the model selected"; only loop's remount kills the running closure (messages array + service revocation) |
| Model-facing contract put in file_editor guidance | Deferral logs go to syslog which never reaches the model; guidance PromptSection does |
| No delta/changelog mechanism for schema drift | Statelesss API forbids deltas; model usually authored the change itself. Known unknown: silent drift if a USER edits plugins mid-run — cheap future fix is a `<PromptSection>` with function text listing recent reloads |

## Open tasks for the next agent

1. **Commit everything** — two logical changesets are stacked uncommitted on `main`: (a) the dependency simplification (see prior note), (b) this session's HMR fix + docs (`src/plugins/manager.ts`, `src/plugins/tools/file-editor.ts`, `tests/boot.test.ts`, `docs/harness-architecture.md`). Suggest two commits.
2. Manual Chrome pass (carried over twice now): load `dist/extension`, verify SW pi-ai streaming + a live mid-run edit of a page-tool plugin showing new schema next turn.
3. If user wants persistence for disabled plugins: implement `public.disabled-plugins` storage list checked in `kernel/boot.ts`.
4. If self-written tool outputs ever cause confusion: add output validation to the dispatch path (the flagged structural gap vs deepseek-harness).

## Blockers

- (none)

## Suggested next step

Commit the two stacked changesets, then do the manual Chrome pass — it validates both the new SW streaming path and the mid-run reload semantics in one sitting.
