# Handoff Note — 201329 · claude · complete-compaction

## Inherited context

Same session as `201309-claude-researched-compaction-plan.md` (the investigation + plan; read it for the pi/opencode reference algorithms). User approved the plan with one change: **compaction must be a standalone plugin mounted alongside the loop**, not code inside loop.js. Implemented and verified this session.

## Work done this session

- [x] **`src/plugins/compaction.js` (new, ~210 lines)** — all policy lives here: chars/4 + last-provider-usage context estimation, trigger at `contextWindow − reserveTokens` (16384), keep-recent cut (~20000 tokens), transcript serialization, pi's checkpoint summarization prompts (single prompt; re-compaction merges the old checkpoint that rides along in the transcript), splice to `{ role: 'summary', text, tokensBefore }`, overflow detection via pi-ai's root-exported `isContextOverflow`. Pure helpers exported for tests; `compaction` service exposes `settings` (reactive), `compacting`, `contextTokens()`, `contextWindow()`, `compact()`.
- [x] **loop.js** — `MAX_TURNS 20` → `HARD_TURN_LIMIT 500` (failsafe kill switch only); stores `msg.usage` from `done` events; two NEW generic waterfall seams: `loop/turn-start` `{ messages, signal }` fired each turn before the streaming placeholder is pushed and the request built (compaction splices here), and `loop/llm-error` `{ message, messages, signal, retry:false }` fired after a failed stream — a listener returning `retry:true` gets **one** retry per run. Loop knows nothing about compaction.
- [x] **llm.js** — `done` events now carry `usage` (pi-ai's `p.usage`); mock engine fabricates shape-correct usage so compaction works offline; service exposes `contextWindow` (cfg override or 131072); `toPiMessages` maps `role:'summary'` → user message prefixed `[Context checkpoint — the earlier conversation was compacted into this summary]`. NOTE: `summary` messages already passed the loop's request filter (`status` is undefined on them) — only the mapping was needed.
- [x] **chat.js** — green collapsed 📦 summary card, `~Nk / 128k ctx` badge (binary k), **Compact** button (idle-only, hidden if the compaction plugin isn't mounted — graceful degradation). **main.js** mounts `compaction` as built-in; summary-card CSS in index.html.
- [x] **Tests: 36/36 green** (`npm test`). New `tests/compaction.test.js` (9): estimation (usage-as-ground-truth, error/streaming skipped), cut-point, serializer (notes/thinking dropped, results truncated), summary mapping, `runCompaction` splice/no-op/failure-leaves-log-untouched, plus a real-loop + real-plugin end-to-end with a tiny fake window. Updated `tests/invariants.test.js`: turn-ceiling test → 500 + failsafe note, new tests for both loop seams (turn-start splice shapes the request; llm-error grants exactly one retry).
- [x] **Browser smoke 9/9 in real Chrome** (mock engine, `serve.mjs 7102`): usage on messages, ctx badge, forced auto-compaction (cranked `settings.reserveTokens`), compaction note, summary card render, manual Compact re-compacts to ONE leading summary, next run works on compacted log, zero console errors. Script: scratchpad `compaction-smoke.mjs` (session-temp, not committed; needs `npm i playwright` + Chrome channel).
- [x] Docs: TESTING.md scenarios 16 (compaction forced, ✅) + 17 (compaction live, not yet run) + 4 new ported-invariants lines; README bullet; cordis-to-vue.md "what the rewrite added" item 7.
- [ ] NOT done: live compaction run against a real endpoint (TESTING.md 17); the old leftovers (scenarios 2, 8–10 live, 13, 15; `--minify`).

## Current state

`npm run build` green (dist 1.1MB dev), `npm test` 36/36, smoke 9/9. Nothing committed (repo has no compaction-era commits yet — everything is working tree, as before).

| File | Change |
|---|---|
| `src/plugins/compaction.js` | NEW — the whole policy, plugin + exported pure helpers |
| `src/plugins/loop.js` | failsafe 500; `msg.usage`; `loop/turn-start` + `loop/llm-error` seams; retry-once wiring |
| `src/plugins/llm.js` | usage on done; `contextWindow` on service; mock usage; `summary`→user mapping |
| `src/plugins/ui/chat.js` | summary card, ctx badge, Compact button |
| `src/entries/standalone/{main.js,index.html}` | mount compaction; `.msg.summary` CSS |
| `tests/{compaction,invariants}.test.js` | new file + updated ceiling/seam tests |
| `README.md`, `docs/{TESTING,cordis-to-vue}.md` | compaction sections |

## Key decisions

| Decision | Rationale |
|---|---|
| Loop exposes generic seams (`loop/turn-start`, `loop/llm-error`), compaction subscribes | User's explicit ask (plugin, not in-loop); matches the existing waterfall-seam architecture; the plugin is unmountable/replaceable at runtime like everything else |
| `loop/turn-start` fires BEFORE the streaming placeholder is pushed | So the compaction splice never has to reason about an in-flight `status:'streaming'` message sitting at the tail |
| Retry budget (one per run) enforced by the LOOP, not the plugin | The loop owns turn flow; a buggy/hostile plugin returning `retry:true` forever must not create an unstoppable run. Plugin-side `compacting` flag additionally prevents re-entry |
| Summarizer failure → loud note, log untouched, run continues | Never trade real history for a failed summary; worst case the provider overflows next turn and the `loop/llm-error` path gets a second chance |
| Summarizer call bypasses the `llm/request` waterfall, `tools: []` | Plugins that rewrite agent requests must not distort the checkpoint; still rides `llm.stream()` so the Phase-2 GM-shim seam holds |
| Thinking excluded from the serialized transcript | Bulky, and reasoning content never re-enters later context anyway (matches how history is replayed) |
| `summary` splice keeps `tokensBefore` on the message | UI provenance ("was ~Xk tokens") and debugging; pi stores the same |
| Ctx badge in binary k (131072 → "128k") | Matches how model windows are marketed; smoke test caught the 131k oddity |
| Mock engine fabricates usage | Compaction demoable/testable with zero network; shape matches pi-ai's `Usage` |

## Traps for the next agent (hard-won this session)

- `findCutIndex` keeps the message that CROSSES the keep-budget — so a single huge message directly before the tail is kept, not summarized. Only its predecessors compact. This is pi's semantics too; don't "fix" it into cutting mid-budget.
- The end-to-end plugin test lives in `tests/compaction.test.js` deliberately: `node --test` runs each file in its own process, so the plugin's global bus listeners/services can't leak into `invariants.test.js` (whose `mountHarness` re-runs plugin setups).
- `pkill -f "serve.mjs <port>"` after smoke runs; an orphaned server on 7100 bit a previous session already.

## Open tasks for the next agent

1. **Live compaction run** (TESTING.md scenario 17): `npm run build && node serve.mjs 7101`, keyless `/proxy` connect, crank `__harness.services.get('compaction').value.settings.reserveTokens = 130000` and run any goal — verify the summarizer request on the wire and the checkpoint quality with a real model (zen bills tokens; one short run).
2. Leftovers: TESTING.md scenarios 2, 8–10 live; 13; 15; optional `deepseek-v4-pro` thinking run; `--minify` build target.
3. Optional polish: a settings UI row for `reserveTokens`/`keepRecentTokens` (currently console-only via the service); persist compaction settings to localStorage.
4. Consider committing — the tree now holds Phase 1 + pi-auth + compaction, all green, and nothing has been committed since `2c195a5 Refactoring`.

## Blockers

- (none)

## Suggested next step

Run the live compaction check (open task 1) — it is the only part of this feature not yet exercised against a real model.
