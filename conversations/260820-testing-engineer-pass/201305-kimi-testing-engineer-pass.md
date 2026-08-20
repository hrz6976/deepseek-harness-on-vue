# Handoff Note — 201305 · kimi · testing-engineer-pass

## Inherited context

User asked for a software-testing-engineer pass over `docs/TESTING.md`: run the
tests, add my own, hand off in a fresh thread. Read `docs/TESTING.md` first,
then the latest prior note `../260820-streamlined-poc/201300-claude-verify-pi-auth.md`
for the live-gateway state. This session was Node-only — no browser, no proxy,
no API key spent.

## Work done this session

- [x] Ran the existing suite: `npm test` → 9/9 kernel tests green (baseline).
- [x] Added `tests/invariants.test.js` — **16 new tests, 25/25 total green** —
      driving the REAL `loopPlugin` + `toPiMessages` in Node with a scripted
      async-generator engine swapped in via `provideService('llm', …)` and real
      `toolsPlugin` / `bus` seams. No browser, no network, no mocks of the
      units under test.
- [x] Invariants from TESTING.md "Ported invariants" now under automated test
      that were previously manual-only:
  - request filter: `note` + `streaming`/`error` partials never reach the model
    (asserted against the captured `llm/request` payload);
  - tool results truncate at exactly 8000 chars (10 000-char tool output);
  - every `toolCall` gets a matching `toolResult`, aborted ones get the
    `(aborted, not executed)` stub, `argsObj` wins over re-parsing `args`,
    `stopReason` is `toolUse`/`stop` correctly, thinking precedes text;
  - `tools/pre-execute` veto blocks the call and the tool body never runs
    (scenario 8 "Waterfall veto" logic, Node-level);
  - mid-turn tool removal race (scenario 14 logic): in-flight turn executes
    the tool from the per-request snapshot, the NEXT request's `tools` array
    no longer contains it;
  - max-turns ceiling: a model that always calls tools is cut at 20 turns with
    the `reached max turns (20), stopping` note;
  - stop mid-stream (scenario 2 logic): real `AbortController` abort →
    `stopped` note, `running` false, no message left in `streaming` status;
  - LLM error → `LLM call failed:` note WITH the network/CORS hint on fetch
    failures, failed assistant turn closed as `error`;
  - re-entry guard: second `run()` while running is refused;
  - compile-probe: broken source rejected with `SyntaxError` before any
    persist/mount (scenario 6 / create_plugin invariant); pinned-dialect
    source compiles — in Node the Blob-import path is unsupported, so the
    `new Function` fallback is exercised on every run (scenario 13's path);
  - `translateESM` covers the full pinned dialect (const/let/var/async
    function exports);
  - `bus.emit` listener isolation (a throwing listener is logged, others
    still run) and empty-waterfall pass-through.
- [x] `npm run build` still green after the change.

## Key decisions

| Decision | Rationale |
|---|---|
| Drive the real loop with a scripted engine, not extracted pure functions | Tests the actual wiring (filter, truncation, veto, snapshot, abort) instead of a reimplementation; the llm service seam (`provideService`) makes the swap one line |
| Capture frozen copies of each `llm/request` | The request holds reactive message objects that mutate after the fact; assertions must run on what the model actually saw |
| Keep tests in a separate `tests/invariants.test.js` | `kernel.test.js` is pure-kernel; the new file needs service/plugin globals — separation keeps both readable; `node --test tests/*.test.js` picks it up with no config change |

## Observations for the next agent

- In Node, `import('blob:…')` always fails, so `compilePlugin` in CI exercises
  ONLY the `new Function` fallback. The Blob path stays browser-only — scenario
  13's inverse (Blob path healthy) is NOT covered by `npm test`.
- Vue prints `onUnmounted … no active component instance` warnings when plugin
  `setup()` runs outside a component. Harmless in tests; don't "fix" it by
  removing the calls — they're load-bearing in the browser.
- The 45 s idle watchdog (`withIdleGuard` in `llm.js`) is not exported and not
  covered; testing it needs either an export or a fake timer + engine stream
  that never yields. Left as a manual/live item.
- One pre-existing test-log line `[harness] waterfall "wf/dbl": next() called
  twice` is the double-next test working as intended, not a failure.

## Open tasks for the next agent

1. TESTING.md manual scenarios still unchecked: 2, 8–10, 13, 15 against the
   live gateway (see the previous note's open tasks — unchanged).
2. Consider exporting `withIdleGuard` (or injecting `IDLE_MS`) so the watchdog
   gets an automated test.
3. Manager-level test (`create` name validation, format-version boot skip) is
   possible in Node with a fake `fs` service if desired; not done here.

## Blockers

- (none)

## Suggested next step

`npm test` to confirm 25/25, then the live-gateway manual runs from the
previous note's open task #1 (stop mid-stream + veto against zen, keyless).
