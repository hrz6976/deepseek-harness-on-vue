# Handoff Note — 241126 · gpt · complete-web-modes

## Inherited context

No existing handoff thread matched the requested npm/Vite mode split and standalone UI refresh. This thread was created for the task.

## Work done this session

- [x] Made the Chrome extension the default Vite development target.
- [x] Added `npm run dev:web` for standalone development on port 4000.
- [x] Added `npm run web:ext` and made `npm run dev` delegate to it.
- [x] Gave each target a strict, explicit development port in `vite.config.ts`.
- [x] Reworked the standalone page from a dark developer dashboard into the extension's light visual system.
- [x] Removed the visible internal-plugin inventory while preserving plugin mounting.
- [x] Simplified headings, empty states, placeholders, status copy, and action labels across standalone UI plugins.
- [x] Updated README and development documentation.
- [x] Ran the complete repository check successfully.

## Current state

| File | Change |
| --- | --- |
| `package.json` | Added `dev:web` and `web:ext`; extension remains the default `dev` target. |
| `vite.config.ts` | Defaults to extension mode; uses strict ports 5173 (extension) and 4000 (standalone); narrows the static CRXJS manifest type. |
| `src/entries/standalone/standalone.css` | New responsive light theme matching the extension's palette, typography, surfaces, and controls. |
| `src/entries/standalone/main.ts` | New streamlined shell and hidden runtime plugin hosts. |
| `src/plugins/ui/{chat,settings,files,preview,syslog}.ts` | Concise user-facing labels and captions. |
| `index.html` | Removed legacy inline dark-dashboard CSS and shortened the document title. |
| `README.md`, `docs/development.md` | Documented the new development commands and ports. |

Verification: `npm run check` passes (TypeScript, 69 tests, extension build/verifier, standalone build, fixture build). `npm run web:ext` started successfully on 5173. A standalone dev server started successfully in `standalone` mode on an override port; the configured port 4000 was already occupied by a pre-existing Vite process, and `strictPort` correctly rejected the collision.

The pre-existing `package-lock.json` modification was not touched by this task. Untracked `.agents/` and `.claude/` directories were also left unchanged.

## Open tasks for the next agent

1. Optionally perform a screenshot-based visual review when the in-app browser runtime is available; its bundled client could not initialize in this session because the runtime rejected its `node:process` import.

## Key decisions

| Decision | Rationale |
| --- | --- |
| Treat every mode except explicit `standalone` as extension | Keeps direct/default Vite invocation extension-first as requested. |
| Keep extension on 5173 and web on 4000 with `strictPort` | The extension CSP hard-codes its dev origin, and silent port fallback would create a broken extension session. |
| Preserve the standalone two-column workspace | It suits a full browser viewport while using the extension's visual language and responsive single-column fallback. |
| Hide plugin hosts rather than removing them | Plugin components must remain mounted for services, tools, and Teleports, but internal plugin names are not normal page content. |

## Blockers

- No implementation blockers. Screenshot automation was unavailable due to the browser plugin bootstrap issue noted above.

## Suggested next step

Run `npm run dev:web` after freeing port 4000, then visually spot-check the desktop and narrow responsive layouts.
