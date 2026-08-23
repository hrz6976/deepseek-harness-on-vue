# Self-Modifying Harness — Architecture & the cordis → Vue Mapping

> Companion to `docs/cordis-to-vue.md` (the full prose mapping table). This doc is the
> picture: what the runtime looks like, and where each cordis capability landed on a
> Vue primitive.

## 1. The whole system (extension form)

```text
┌─────────────────────────── Chrome trusted context ───────────────────────────┐
│                                                                              │
│  service-worker.ts        sidepanel.ts (per tab)        options.ts           │
│  ─────────────────        ──────────────────────        ─────────            │
│  · tab-scoped panels      · chat UI                     · LLM config         │
│  · page commands via      · OPFS broker (fs/* kinds     → secrets.llm        │
│    chrome.scripting         live HERE — SW throws)                           │
│  · recipes store          · approval dialogs                                 │
│  · storage guard (secrets.* refused to sandbox)                              │
│  · LLM streaming ───────────────── createPiStream() ────────────┐          │
│                                    (shared/pi-engine.ts, pi-ai)    │          │
└──────────────────────────────────────┬───────────────────────────────│──────────┘
                                       │ chrome.runtime.Port           │ SSE
                                       │ "harness-broker-v1"           ▼
                                       │ Zod-validated envelopes   DeepSeek API
                                       ▼ (structured-clone boundary)
┌──────────────────── sandboxed iframe — NO chrome.*, CSP: no fetch ───────────┐
│                                                                              │
│                     ┌────────────────────────────────────┐                   │
│                     │        KERNEL  (src/kernel/)       │                   │
│                     │                                    │                   │
│   OPFS .plugins/ ──▶│  boot ── seed + compile + mount    │                   │
│  (agent-editable    │  compile ── dialect v2, import     │                   │
│   source of truth,  │            rewrite → __harness     │                   │
│   write-if-missing  │            .modules registry)      │                   │
│   seeded from       │  host ── reactive plugins[] +      │                   │
│   virtual:plugin-   │          PluginHost error boundary │                   │
│   defaults)         │  services ── DI registry           │                   │
│                     │  collector ── tools/prompt slots   │                   │
│                     │  contrib ── <AgentTool> etc.       │                   │
│                     │  bus ── emit/on + waterfall veto   │                   │
│                     │  modules ── the ONE Vue + pi-ai    │                   │
│                     └───────────────┬────────────────────┘                   │
│                                     │ v-for renders PluginHost per entry     │
│                                     ▼                                        │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌───────────────────────┐  │
│  │ fs      │ │ loop    │ │ llm     │ │ manager  │ │ ui/chat · tools/page  │  │
│  │ (OPFS)  │ │ (agent  │ │ (engine │ │ (HMR:    │ │ · compaction · prompt │  │
│  │         │ │  loop)  │ │  seam)  │ │  fs→remount) │ · create_plugin …     │  │
│  └─────────┘ └─────────┘ └─────────┘ └──────────┘ └───────────────────────┘  │
│      every one of these is a COMPONENT, loaded from the same OPFS pipeline,  │
│      and editable by the agent at runtime (file-editor + HMR)                │
└──────────────────────────────────────────────────────────────────────────────┘
                                       │ capability requests only
                                       ▼
┌──────────────────── host page content script (extension only) ───────────────┐
│  snapshot / query / picker · patch transactions (preview→apply→verify→revert)│
│  recipes replay · MutationObserver route events                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 2. The core trick: plugin system = component system

One reactive array drives everything. There is no plugin manager *and* a render
tree — they are the same tree.

```text
             mountPlugin('loop', def)                unmountPlugin('loop')
                       │                                       │
                       ▼                                       ▼
   plugins: reactive([ ..., { name:'loop', def, version } ]) ──splice──▶ │
                       │                                       │
                       ▼  v-for over plugins                   ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │ <PluginHost :plugin="p">          (per instance)                     │
   │   provide('pluginName')  ◀── contributions attribute themselves      │
   │   onErrorCaptured ──▶ failed card + retry (version++ = clean remount)│
   │   <component :is="p.def" :key="version" ref=expose-capture>          │
   └──────────────────────────────────────────────────────────────────────┘
                       │                                 │
        setup() runs inside Vue's effect scope           │
                       ▼                                 ▼
     provideService / collector.add / useBusOn / watch / onUnmounted
     = cordis "effects": ALL auto-reclaimed when the array splice unmounts
       the component. No disposer discipline required from plugin authors.
```

## 3. cordis capability → Vue primitive (the kernel in one picture)

```text
 cordis concept                     this harness (src/kernel/)
 ──────────────                     ─────────────────────────
 Fiber instance tree                component tree
   ctx.plugin()                       plugins.push() → v-for → <PluginHost>
   PENDING/FAILED/retry               compile-probe (never mounts) +
                                      onErrorCaptured → failed card, version++ remount
   cascading disposal                 array splice = Vue unmounts subtree,
                                      effect scope reclaims everything LIFO-free

 service DI container               services.ts
   ctx.set/get                        shallowReactive(Map<name, shallowRef>)
   provide/inject via                 siblings reach each other through the
   Context prototype chain            FLAT registry, not the tree
   inject-missing ⇒ PENDING           useService(name) = computed → null until
                                      the service appears; replacement propagates
                                      (readiness-driven "dependency management")

 registrations are effects          effect scope + onUnmounted
   ctx.effect, LIFO reclaim           provideService/collector.add/useBusOn
                                      register cleanup on unmount; token-guarded
                                      delete (an HMR replacement is never
                                      deleted by the old instance's late cleanup)

 tools / prompt registries          collector.ts + contrib.ts
   ctx.tools.register()               <AgentTool> / <PromptSection>:
   declaration = authorization        MOUNT = register, UNMOUNT = dispose.
                                      v-if = live toggle, v-for = N tools.
                                      Name-keyed, duplicates fail loud;
                                      kind-keyed singletons outlive reloads
   system prompt                      computed over collected <PromptSection>s
                                      → unmounting a plugin removes its prose

 event bus + waterfall              bus.ts — the ONE hand-rolled mechanism
   emit/on, middleware veto           (~40 lines; Vue has no equivalent)
                                      skip next() = veto, double-next detected

 config update = restart            props + :key="version"
   StandardSchema + restart           version++ forces clean remount with
                                      new config

 HMR (cordis-hmr)                   manager.ts + fs.ts
   watch → remount → rollback         the reactive fs cache IS the change
                                      signal (no chokidar layer); failure =
                                      old version keeps running

 runtime creation (Creator)         tools/create-plugin.ts
   agent writes → compile → mount     create_plugin → compile-probe →
                                      OPFS write → mount; boot restores

 agent-readable state               state.ts + host.ts
   store bridge                       ctx.expose() (Vue's own primitive) →
                                      vnode-ref capture → read_state tool

 error isolation                    onErrorCaptured boundary per PluginHost
```

## 4. Why the agent can modify its own core

The shipped plugins are not privileged code — they are the **initial filesystem
state**. `boot()` seeds `.plugins/` write-if-missing from `virtual:plugin-defaults`,
then compiles *everything* (shipped or agent-created) through the same
`compilePlugin` pipeline:

```text
 bundle (virtual:plugin-defaults)                agent (LLM tool call)
        │ source text                                   │ source text
        ▼                                               ▼
   OPFS  .plugins/loop.js  .plugins/llm.js  .plugins/my-tool.js  …
        └────────────── same pipeline ──────────────────┘
                            │
              compilePlugin: dialect-v2 rewrite
              (pinned imports → globalThis.__harness.modules;
               cross-plugin imports FAIL LOUD)
                            │
                     mountPlugin → reactive array → v-for
```

Consequences:
- `file_editor` + HMR works on the loop, the chat UI, even the page tools —
  the agent can edit its own kernel-adjacent capabilities.
- Exactly ONE Vue namespace (`__harness.modules['vue']`) crosses the
  shipped/self-modified boundary; two would silently break reactivity.
- Kernel-owned ABI (`contrib.ts`, `collector.ts` singletons) survives any
  plugin reload — a reloading module can't orphan others' registrations.
- Recovery ladder: broken file → fails soft at boot; `?reset` → reseeds
  factory state, keeps localStorage.

## 5. The extension trust boundary (what the sandbox can NOT reach)

```text
 sandbox plugin code                    reachable only via validated broker kinds
 ──────────────────                     ────────────────────────────────────────
 chrome.*                    ✗          page/*      → content script commands
 fetch / WebSocket / beacon  ✗ (CSP)    fs/*        → side-panel OPFS broker
 secrets.llm                 ✗          llm/complete→ SW → createPiStream → API
 arbitrary storage           ✗          storage/*   → public.* keys only
                                        recipe/*    → audited DOM ops, no source
```

So "self-modifying" is bounded: the agent owns everything inside the sandbox
(including its own plugins), and reaches the outside world only through
capabilities the trusted shell chooses to honor.
