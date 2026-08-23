# Handoff Note — 211625 · ox-alpha · refactored-deps

## Inherited context

Read `conversations/260821-chrome-page-agent-extension/004230-claude-complete-chrome-page-agent-extension.md` (the commit-`6226114` handoff). That session delivered the Chrome MV3 extension + TS migration, but jumped dependencies from 3 (`@earendil-works/pi-ai`, `vue`, `esbuild`) to 14 and left the project with **two parallel LLM stacks**: pi-ai in the sandbox `llm` plugin, plus the official `openai` SDK + a hand-written `OpenAiStreamAccumulator` in the service worker — both against the same DeepSeek-compatible endpoint. User directive this session: this is a **PoC; cut whatever isn't necessary; keep fixtures; drop MCP at this stage; the agent stays minimal because it can create its own tools.**

## Work done this session

- [x] Audited every dep added by `6226114` against actual usage (grep + `npm ls`)
- [x] **Removed the `openai` SDK entirely.** Verified in `ref_repos/pi-mono/packages/ai/src/api/openai-completions.ts` that pi-ai's `openai-completions` adapter streams tool calls/thinking/usage natively and accepts `maxRetries`/`timeoutMs`/`signal`/`fetch` — everything the SDK call configured
- [x] Created `src/shared/pi-engine.ts` — pure module (no Vue, no `chrome.*`): `toPiMessages`, `createPiStream(cfg)`, idle watchdog, `DEFAULT_CONTEXT_WINDOW`. Moved verbatim out of `src/plugins/llm.ts`
- [x] `src/plugins/llm.ts` slimmed to the plugin wrapper (mock engine + `setupLlm`); re-exports `toPiMessages` so `tests/compaction.test.ts` import keeps working
- [x] Service worker `streamLlm` is now 3 lines: `yield* createPiStream(config)({...request, signal: new AbortController().signal})` (wire format carries no AbortSignal; the old OpenAI path had none either)
- [x] **Removed MCP at this stage** (~165 lines): `mcp/*` kinds from `src/shared/page-protocol.ts` + `src/shared/broker-schema.ts`, `mcp/connect` approval branch in `src/extension/approval-policy.ts`, and all client code in `src/extension/service-worker.ts` (`mcpClients` map, connect/disconnect/require/mcpKey/closeMcpClientsForTab, `tabs.onRemoved` listener). MCP had no UI wiring — clean cut
- [x] Deleted `src/extension/openai-stream.ts` + `tests/openai-stream.test.ts` (superseded by pi-engine; `toPiMessages` still covered via compaction tests)
- [x] Registered `shared/pi-engine` in the dialect-v2 module registry (`src/kernel/modules.ts`) — shipped plugins may import it
- [x] Removed `openai` + `@modelcontextprotocol/sdk` from `package.json`; `npm install` (lockfile intentionally updated this time)
- [x] Updated README.md + docs/extension-architecture.md (MCP → documented future extension point; LLM described as the single shared pi-ai engine)
- [x] `npm run check` fully green: typecheck ✅, 68 tests pass / 0 fail, extension + standalone + fixtures builds ✅
- [x] Dependency tree: **596 → 430 entries** (`npm ls --all | wc -l`)

## Current state

Uncommitted on `main` (last commit `6226114`). Env note: project `.npmrc` pins the Huawei Cloud mirror (`https://repo.huaweicloud.com/repository/npm/`); the global `~/.npmrc` points at a Microsoft feed proxy that 404s on `vite@8.2.2` — don't delete the project `.npmrc`.

| File | Change |
| ---- | ------ |
| `src/shared/pi-engine.ts` | NEW — single shared LLM engine (pi-ai DeepSeek-compatible provider) |
| `src/plugins/llm.ts` | Rewritten as thin wrapper; re-exports `toPiMessages` |
| `src/extension/service-worker.ts` | openai/MCP code removed; `streamLlm` uses `createPiStream` |
| `src/shared/page-protocol.ts` | 4 `mcp/*` BrokerRequest kinds removed |
| `src/shared/broker-schema.ts` | 4 matching Zod schemas removed |
| `src/extension/approval-policy.ts` | `mcp/connect` approval branch removed |
| `src/kernel/modules.ts` | `shared/pi-engine` added to frozen module registry |
| `src/extension/openai-stream.ts`, `tests/openai-stream.test.ts` | DELETED |
| `package.json`, `package-lock.json` | `openai`, `@modelcontextprotocol/sdk` removed |
| `README.md`, `docs/extension-architecture.md` | MCP/openai-SDK references rewritten; MCP kept as future extension point |
| `.npmrc` | (earlier this session) Huawei Cloud registry pin, untracked |

## Key decisions

| Decision | Rationale |
| -------- | --------- |
| One engine in `shared/pi-engine.ts`, not per-context copies | Sandbox plugin and service worker both target DeepSeek-compatible endpoints; two SDK stacks was the core PoC bloat. Pure module (no Vue/chrome) so both contexts bundle it |
| Kept `zod` | Single consumer (broker envelope validation) but it doubles as the structured-clone boundary; cheap |
| Kept fixtures (`react-host`, `legacy-host`), `happy-dom`, `vite`+`@crxjs`, `typescript`/`tsx` | User explicitly said keep fixtures; the rest are build/test infra that replaced hand-written scripts — net simpler |
| MCP removed, not stubbed | User: not needed at this stage; agent creates its own tools via `create_plugin`. External-tool access documented as future work (Streamable HTTP preferred; stdio needs Native Messaging) |
| Per-stream `AbortController` in SW | Wire format has no signal; preserves old OpenAI-path semantics exactly |
| `shared/pi-engine` added to dialect registry instead of inlining | Avoids re-duplicating ~70 lines inside `llm.ts`; consistent with "share through modules/services" rule |

## Traps for the next agent

- The dialect-v2 import allowlist lives in `src/kernel/modules.ts` — any new shared module a shipped plugin imports must be registered there or `tests/plugin-defaults.test.ts` fails loud (this bit us once already).
- `tests/compaction.test.ts` imports `toPiMessages` from `../src/plugins/llm` (re-export). If you move it again, update that import.
- `npm run dev` = CRXJS extension dev mode; standalone demo is `build:standalone` + `npm run serve`.
- npm blocks postinstall scripts (esbuild/fsevents/protobufjs warnings); esbuild binary works anyway — approve via `npm install-scripts approve <pkg>` only if something actually breaks.

## Open tasks for the next agent

1. Commit this simplification (suggest: `refactor: single pi-ai LLM engine, drop openai SDK and MCP for PoC`) and push.
2. Manual browser pass (still open from the previous note): `npm run build`, load `dist/extension`, authorize origin, run snapshot→patch→verify→revert on both fixtures — now also confirms the SW's pi-ai streaming path works in a real service worker (the one runtime pi-ai wasn't exercised in before; unit tests cover the engine logic but not the MV3 SW environment).
3. If live streaming misbehaves in the SW specifically, suspect `location`-relative baseURL handling in `createPiStream` (SW `location` is the extension origin, config baseURL should be absolute) and check the idle-watchdog error path.

## Blockers

- (none)

## Suggested next step

Commit, then do task 2 — the real-Chrome streaming pass is the only untested surface after this refactor.
