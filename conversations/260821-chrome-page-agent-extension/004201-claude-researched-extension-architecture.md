# Research Note — 004201 · claude · extension-architecture

## Question

Phase 2 of `conversations/260820-streamlined-poc/implementation-plan.md` called for injecting the harness into arbitrary pages ("userscript, later possibly a Chrome extension"). Before writing any code: which execution domains can a Manifest V3 extension actually offer, where do the trust boundaries fall, and what is the right ABI between the agent and a host page it doesn't control?

## Findings

### Three execution domains, not two

1. **Trusted extension contexts** (service worker, side panel, options page): hold `chrome.*`, the LLM key, MCP transports, and persistent storage. Everything here is assumed compromised-proof but must stay small and auditable.
2. **Sandboxed agent runtime**: the Phase 1 Vue harness itself. It must keep self-modification ability (dynamic plugins, `run_js`) while losing all direct capabilities. MV3 `sandbox.pages` gives an opaque-origin frame whose CSP we control — `connect-src 'none'` kills fetch/WebSocket/beacon, so *all* I/O is structurally forced through a validated parent-message broker.
3. **Host page**: reachable only through an isolated-world content script exposing a narrow command protocol, plus `chrome.userScripts.execute` (Chrome 135+) for MAIN/USER_SCRIPT evaluation, gated behind explicit user approval.

### DOM is the primary ABI, framework adapters are diagnostics only

- DOM covers static/server-rendered pages, Vue, React, Web Components, unknown frameworks alike.
- `ElementRef` therefore carries three layers of identity: short-lived `nodeRef` (fast path), relocatable CSS `selector`, and a tag/id/class fingerprint checked on every reuse — so patches survive re-renders without ever trusting a stale node blindly.
- React production builds expose no stable component tree; even where a framework exposes internals (Vue), private runtime fields are not a long-term contract. Adapters may annotate (component name, props summary), never implement modifications. React reconciliation will overwrite out-of-band DOM edits — this is a documented boundary, not a bug to fix.

### Tab scoping is a first-class concern

A single global runtime guessing the "active tab" would leak conversations, annotations, and undo state across tabs. `sidePanel.setOptions({ tabId, path: '...?tabId=N' })` makes Chrome instantiate one side panel per http(s) tab; the broker port name (`harness-sidepanel-v2:<tabId>`) pins routing so a sandbox request cannot impersonate another tab. Restricted pages (`chrome://`) get `enabled: false`.

### Persistence split

Extension-level (shared): OPFS plugin sources, LLM config under `secrets.*` in `chrome.storage.local`, site recipes under `public.recipes`. Tab-session-level: conversation, annotations, live transaction undo stacks. The sandbox's storage capability rejects the `secrets.*` namespace outright.

### Recipes are data, never code

`SiteRecipe.source` (executable) was considered and rejected: the service worker refuses saves carrying `source`; only audited `PatchOperation[]` persist, replayed on load-complete / SPA route-change after an origin permission check.

Full design text landed as `docs/extension-architecture.md` in the same commit.

## Feeds into

`004210-claude-drafted-extension-plan.md`.
