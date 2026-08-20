# deepseek-harness-on-vue

A modular, self-modifying agent harness whose kernel demonstrates how cordis / deepseek-harness core concepts translate to Vue primitives. The agent (DeepSeek via pi-ai) can build itself new plugins at runtime — tools, UI panels, prompt sections — which persist to OPFS, hot-reload on edit, and roll back on broken source.

```bash
npm install
npm run build        # esbuild → dist/
node serve.mjs 7100  # static dist/ + /proxy → api.deepseek.com (CORS)
npm test             # kernel logic tests (node:test, no browser)
npm run dev          # watch + serve in one process
```

Open http://localhost:7100 — connect with an API key (Base URL `/proxy`), or tick **mock engine** for a keyless offline demo. If `pi` is installed locally, serve.mjs picks up `~/.pi/agent/auth.json` automatically: leave the key field empty and the proxy injects the credential server-side (it never enters the page).

- Concept map: [docs/cordis-to-vue.md](docs/cordis-to-vue.md)
- Manual test document: [docs/TESTING.md](docs/TESTING.md)
- Everything is a plugin except `src/kernel/`. UI panels included. A contribution is not something you register in `setup()` — it's something you render: `<AgentTool>` / `<PromptSection>`; mount = register, unmount = dispose.
- **Every plugin lives in OPFS `.plugins/` — including the core ones.** The bundle ships the kernel + Vue + pi-ai + the `fs` plugin + all other plugin *sources*; first boot seeds them into `.plugins/` (write-if-missing) and every boot compiles them from there, through the same pipeline as agent-created plugins. So the agent can open `.plugins/loop.js` or `.plugins/chat.js` with file_editor and change its own core behavior — hot-reloaded, rolled back if broken, deferred while a run is in flight. `?reset` in the URL = factory reset (wipes `.plugins/`, keeps localStorage). Dev note: because seeding never overwrites, repo-side plugin edits reach a browser with existing OPFS state only after `?reset`.
- Plugin dialect v2: one `export default {…}` component object; optional single-line imports from `vue`, `@earendil-works/pi-ai`, and `kernel/*` (rewritten at compile time to the shared `__harness.modules` registry — one Vue instance, always); cross-plugin imports are rejected — plugins share through services.
- Component state is agent-readable, on Vue's own primitive: a plugin calls `ctx.expose({ board, score })` in setup and the model reads it live with the `read_state` tool — build a snake game, play it, then ask the agent for your score. Opt-in, pull-based, keyed by the exposed proxy PluginHost captures ([state.js](src/plugins/state.js)).
- Long sessions self-compact (pi/opencode style): when context nears the window (reserve 16k), the compaction plugin summarizes older messages into a checkpoint via one tool-less LLM call, keeping the recent ~20k tokens; provider "context too long" errors trigger compact-and-retry. The loop has no turn cap beyond a 500-turn runaway failsafe — Stop is the control.
- `app/` is the frozen single-file PoC this rewrite grew out of; `conversations/` holds the research and decision trail.
