# Handoff Note — 201309 · claude · researched-compaction-plan

## Inherited context

Read `201234-claude-complete-phase1.md` and `201300-claude-verify-pi-auth.md`. Phase 1 is complete and live-verified (keyless via /proxy + pi credentials). This session was **investigation + planning only** — no code changed. Task: remove the `MAX_TURNS = 20` step limit (or make it a very-high failsafe) and add simple compaction like pi agent or opencode.

## Work done this session

- [x] Read the loop ([src/plugins/loop.js](../../src/plugins/loop.js)) and llm seam ([src/plugins/llm.js](../../src/plugins/llm.js)): `MAX_TURNS = 20` at loop.js:10; usage data from pi-ai is currently **discarded** (`snapOf` in llm.js keeps only text/thinking/toolCalls; `zeroUsage()` stuffed into history).
- [x] Read pi's actual compaction implementation from the local install: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/{compaction,utils}.js`. Full algorithm captured below.
- [x] Confirmed opencode 1.18.15 (binary strings) uses the same shape: config `compaction: {auto, reserved, preserve_recent_tokens (~25% of context, clamped), tail_turns, prune}`, trigger `tokens.total > context - reserved`, summarize head / keep tail, auto-continue after compaction.
- [x] Confirmed pi-ai (already bundled, v0.84.2) **exports `isContextOverflow(message, contextWindow)` from its root** (`export * from "./utils/overflow.ts"` in index.d.ts) — ~24 provider regexes for "context length exceeded" errors. `estimateContextTokens` lives in `dist/utils/estimate.js` but is NOT root-exported; we hand-roll (trivial for our flat message model).
- [x] Confirmed pi-ai's `done` stream event carries `ev.message.usage` (`{input, output, cacheRead, cacheWrite, totalTokens, cost}`) — llm.js just needs to pass it through.
- [ ] NOT done: any implementation.

## How the references actually do it (for the record)

**pi** (`compaction.js`): settings `{enabled: true, reserveTokens: 16384, keepRecentTokens: 20000}`.
- **Context size** = last valid assistant `usage.totalTokens` (skip aborted/error/zero-usage) + chars/4 estimate of messages after it.
- **Trigger**: `contextTokens > contextWindow - reserveTokens`, checked between turns; plus overflow-error recovery via `isContextOverflow` → compact and retry once.
- **Cut point**: walk backwards accumulating chars/4 until ≥ keepRecentTokens; cut only at user/assistant boundaries, never before a toolResult; if the cut lands mid-turn, the turn prefix gets its own smaller summary (merged in).
- **Summarize**: ONE standalone LLM call (`cacheRetention: "none"`, fresh sessionId, maxTokens = 0.8 × reserveTokens). The discarded prefix is **serialized to plain text** inside `<conversation>` tags (so the model can't try to continue it), with a structured checkpoint format: `## Goal / ## Constraints & Preferences / ## Progress (Done|In Progress|Blocked) / ## Key Decisions / ## Next Steps / ## Critical Context`, plus "preserve exact file paths, function names, error messages". Re-compaction passes the previous summary in `<previous-summary>` tags with an UPDATE prompt (preserve + merge rules). File read/edit lists are extracted from tool calls and appended mechanically.
- **Result**: history becomes `[compactionSummary message] + [kept recent messages]`; summary goes to the LLM as a user-role message.

**opencode**: same head/tail structure, `reserved` defaults tied to max output tokens, `preserve_recent_tokens` ≈ 25% of context window (clamped), tail also boundable by `tail_turns`; media stripped before giving up ("context exceeds model limit even after stripping media"); auto-continues the interrupted run after compaction.

## The plan (agreed scope: simple, in-loop)

### A. Steps limit → failsafe (5 min)

In loop.js: `MAX_TURNS = 20` → `HARD_TURN_LIMIT = 500`. It is no longer a control mechanism, only a runaway-loop kill switch; Stop button + abort signal remain the real control. Update the note text to say `reached failsafe turn limit (500) — likely a runaway loop`. Update the loop.js header comment ("tool rounds (max 20)").

### B. Compaction (the real work)

**B1. llm.js — surface usage (~10 lines).** In `piStream`'s `done` branch, add `usage: p.usage` to the yielded event (and `contextWindow: model.contextWindow` on the llm service object, or expose via a getter). Mock engine: yield a fake usage (e.g. input = chars/4 of the request) so compaction is testable offline. Keep `zeroUsage()` in `toPiMessages` for OUTGOING history (that field is metadata pi-ai doesn't read on input) — do not confuse the two directions.

**B2. loop.js — track context size (~15 lines).** Store `msg.usage` from the done event on each assistant message. `contextTokens()` = total of last valid assistant usage (`totalTokens || input+output+cacheRead+cacheWrite`; skip error/zero) + chars/4 over messages after it (text + thinking + toolCall args + results; user text; summary text).

**B3. loop.js — compact() (~60 lines, the core).**
- Constants: `RESERVE_TOKENS = 16384`, `KEEP_RECENT_TOKENS = 20000`, `CONTEXT_WINDOW` from llm service (currently 131072 hardcoded in llm.js model def).
- Cut point: walk the flat `messages` array backwards accumulating chars/4 until ≥ KEEP_RECENT; cut at any top-level message boundary — **our model has no split-turn problem**: toolCalls + results live INSIDE each assistant message and `toPiMessages` always emits them adjacently, so every top-level boundary is valid. Prefer the nearest user-message boundary at/after the cut when one exists; skip `note` rows entirely.
- Serialize the prefix (everything before the cut, minus notes) to a role-tagged text transcript: `[user] …`, `[assistant] … (called run_js({code:…}) → result…)`, tool results truncated to ~500 chars each.
- One summarization call through the EXISTING `llm.stream()` seam (no tools, own systemPrompt): pi's checkpoint format verbatim (Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context + "preserve exact file paths, function names, error messages"). Single prompt handles re-compaction too: if the prefix starts with an old summary message, the transcript contains it and the prompt says "a previous checkpoint summary may appear at the start — preserve its still-relevant content". (Skipping pi's separate UPDATE prompt + turn-prefix summary = the "simple" in simple compaction.)
- Splice: `messages.splice(0, cutIndex, { role: 'summary', text, tokensBefore, tokensAfter })`.
- Failure: if the summarization call errors, `note()` it and return without splicing — the loop continues uncompacted (worst case the next request overflows, which B5 catches).
- Abort: run under the loop's existing `ctrl.signal` so Stop also cancels a compaction in flight.

**B4. Wire into the loop.** Top of each turn (before the `llm/request` waterfall): `if (contextTokens() > CONTEXT_WINDOW - RESERVE_TOKENS) { note('compacting…'); await compact(); }`. Expose `compact` on the loop service for the manual button. Two filter/mapping updates:
- loop.js:59 request filter currently keeps only non-note, non-streaming/error — must ALSO pass `role === 'summary'`.
- llm.js `toPiMessages`: map `summary` → `{ role: 'user', content: '[Context checkpoint — earlier conversation was compacted to this summary]\n\n' + text }` (pi likewise sends compactionSummary as user-role).

**B5. Overflow recovery (cheap insurance, ~10 lines).** In the loop's `ev.type === 'error'` branch: `import { isContextOverflow } from '@earendil-works/pi-ai'`; build `{stopReason:'error', errorMessage: ev.message, usage: zeroUsage()}` and test it. If overflow AND not already retried this turn: compact(), `turn--`… (or a `retriedOverflow` flag), continue instead of aborting the run. One retry max.

**B6. chat.js UI (~20 lines).** Render `role === 'summary'` as a collapsed `<details>` card ("📦 context compacted — N → M tokens", body = summary text). Context meter next to the engine badge: `~{{Math.round(contextTokens/1000)}}k / 128k`. "Compact" button (enabled when idle && messages.length), calls `loop.compact()`.

**B7. Tests + docs.** `tests/kernel.test.js` style (bare Node): cut-point selection on a synthetic message array, serializer output, summary-role filter invariant, `toPiMessages` summary mapping. Loop-level: mock engine + tiny `CONTEXT_WINDOW` override to force a compaction round (mock summarization reply canned). Add TESTING.md scenario: long session compacts, agent still knows the goal after. Update README + docs/cordis-to-vue.md if it mentions max turns.

### Deliberately NOT in scope (simplicity)

- pi's split-turn prefix summary (impossible in our flat model), UPDATE-prompt merge, file-ops extraction lists (nice-to-have; our fs is small — the agent can `ls`), settings UI for reserve/keep constants, cache-retention/sessionId options (proxy path doesn't use them), z.ai/MiMo silent-overflow detection (DeepSeek + zen error loudly).

## Key decisions

| Decision | Rationale |
|---|---|
| Compaction lives in loop.js (exposed as `loop.compact()` service method), not a separate plugin | The loop owns the canonical `messages` array; a plugin would have to reach in and mutate another plugin's state. The manual-button/UI stays a plugin concern via the service method |
| Keep-recent cut at any top-level message boundary | Our flat model embeds toolCalls+results in the assistant message, so pi's "never cut before a toolResult" invariant is structural — no cut-point machinery needed |
| One summarization prompt (pi's checkpoint format), no separate UPDATE prompt | Old summary rides along in the serialized transcript; one merge instruction line covers re-compaction. Halves the prompt surface |
| Summarize through `llm.stream()` (no tools) rather than a second provider path | llm.stream is the sole transport boundary (Phase-2 GM-shim seam); a compaction that bypassed it would break the userscript port |
| `isContextOverflow` imported from pi-ai root | Already bundled + root-exported; 24 provider patterns for free |
| Turn limit kept at 500 as failsafe, not removed | User explicitly asked for a "very high failsafe kill switch"; an unbounded loop with a wedged mock/tool would spin forever |
| Constants (16384 reserve / 20000 keep) copied from pi's defaults | Battle-tested for 128k-class windows; DeepSeek models are 128k |

## Open tasks for the next agent

1. Implement B1→B7 in that order (B1–B4 are the functional core; B5/B6 independent; B7 last). Estimated ~150 lines total across loop.js, llm.js, chat.js + tests.
2. Verify with mock engine first (`npm run build && node serve.mjs 7101`, tick mock, force tiny window), then live: give a long multi-file task on `deepseek-v4-flash` via /proxy and watch a real compaction fire (zen bills tokens — one run is enough).
3. `npm test` must stay green; add the new cases.
4. Leftovers from previous notes still open: TESTING.md scenarios 2, 8–10 live; 13, 15; optional `deepseek-v4-pro` thinking run; `--minify` build target.

## Blockers

- (none)

## Suggested next step

Implement B1 (usage passthrough in llm.js) and B2 (contextTokens in loop.js) first — they're observable immediately in the console via `__harness` and everything else builds on them.
