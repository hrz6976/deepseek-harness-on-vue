# Browser Cordis kernel

The Harness now runs `@deepseek-ai/cordis` in the sandbox frame. Vue is the UI renderer, not the plugin kernel. OPFS remains the dynamic source transport and the trusted extension shell remains the only authority for Chrome, LLM credentials, MCP, host-page actions, and workspace persistence.

## Runtime layers

| Layer | Owns | Does not own |
|---|---|---|
| Trusted Capability Host | Chrome APIs, approval, LLM key, MCP/network, page/workspace providers | Sandbox plugin lifecycle or UI |
| Cordis sandbox kernel | Plugin/Fiber lifecycle, DI, events, effects, failure state, async disposal | Trusted authority |
| OPFS module transport | Editable source, factory seeding, import rewrite, compile probe, HMR signal | Permissions or runtime ownership |
| Vue renderer | Real panels registered with `ctx.ui.register()` | Tool/prompt/service/event manifests |
| Capability metadata | Identity, scope, declared contributions, provider/permission requests, health | Permission grants |

The central rule is: a capability manifest describes and audits authority, but only the trusted host can grant or execute it.

## Plugin authoring

The preferred dialect is a normal Cordis module with explicit metadata and contributions:

```ts
import { defineComponent, ref } from 'vue'
import { z } from 'zod'

export const name = 'dice'
export const inject = ['tools', 'prompt', 'ui']

export function apply(ctx) {
  const last = ref(0)

  ctx.tools.register({
    name: 'roll_dice',
    description: 'Roll an N-sided die.',
    parameters: z.object({ sides: z.number().int().positive().default(6) }),
    run: ({ sides }) => String(last.value = 1 + Math.floor(Math.random() * sides)),
  })

  ctx.prompt.register({
    name: 'dice-guidance',
    order: 60,
    text: 'Use roll_dice when a random result is useful.',
  })

  ctx.ui.register({
    name: 'dice-panel',
    component: defineComponent({
      template: '<div>Last roll: {{ last }}</div>',
      setup(_, { expose }) {
        expose({ last })
        return { last }
      },
    }),
  })
}
```

Templates exist only inside the `dice-panel` Vue component. Tools and prompts do not hide as null-rendering template nodes. `definePlugin()` is unnecessary because Cordis already has the correct function/class/object plugin union.

The compiler accepts a default Cordis function, class, or `{ apply }` object. UI follows the same ownership model: plugins explicitly call `ctx.ui.register()` from `apply(ctx)`.

## Lifecycle mapping

| Concern | Implementation |
|---|---|
| Plugin instance | One Cordis `Fiber` per `ctx.plugin()`; nested Fibers inherit the nearest capability identity |
| Missing dependencies | Fiber stays `PENDING` until every declared injection exists |
| Service replacement | Consumers unload and reactivate through Cordis dependency epochs |
| Resources | `ctx.effect()` owns sync/async disposers and releases them in reverse order |
| Events/middleware | Cordis `ctx.on`, `ctx.emit`, and `ctx.waterfall` |
| Failure | Fiber enters `FAILED`; the host records its error without taking down siblings |
| Unmount | `await fiber.dispose()` before capability metadata and source are detached |
| UI failure | Per-contribution Vue error boundary; it does not redefine Fiber ownership |

`src/kernel/services.ts`, `bus.ts`, and `contrib.ts` are Vue-facing adapters over Cordis. They keep host UI reactive while Cordis remains the source of truth. The old singleton collector and template contribution components were removed.

## Contribution services

- `ToolsRuntime` owns explicit tool registrations and per-request snapshots. Names collide loudly across Fibers; disposal is token-guarded.
- `PromptRuntime` owns ordered prompt sections and assembles them at request time.
- `UiService` owns named Vue panels. Contributions declare `region` and `order`; the shell renders `UiContributionsHost` per region, so panel code does not need Teleport or shell DOM knowledge. Its `Service` call tracing binds `register()` to the calling Fiber, so removing a plugin removes its panels automatically.
- Custom services use `ctx.provide()`. Custom resources, watchers, workers, and timers use `ctx.effect()`.

Cordis `Service` tracing is important here: inside `ctx.tools.register()`, the service sees the caller's context rather than the service provider's context. The tool therefore belongs to the capability that registered it.

## Dynamic loading and HMR

Dynamic source supports named `name` / `inject` / `Config` / `apply` exports and default Cordis plugins. There is deliberately no persisted format version while the project is pre-release. Static imports are restricted to `vue`, `zod`, Cordis, the model SDK, and `@harness/sdk` (`@/sdk` in repository source). Kernel modules, the root Context, mounting, compilation, and repositories are not present in the blob import registry.

Source policy is trusted runtime metadata, never capability-manifest data. `kernel` names are framework/authority owners, `protected` names are shipped control-plane or privileged capabilities, and every other name is `editable`. Capability callers cannot write or remove `.plugins/<locked>.js`, and all `.harness/...` active packages/task metadata are manager-owned; the workspace provider enforces both rules below individual editor tools. A protected on-demand capability such as standalone `llm` is mounted from its embedded source, not from its OPFS draft. The catalog exposes `source`, `editable`, and `reloadBoundary` so callers do not have to infer policy from names.

Editable-capability HMR follows this sequence:

1. Receive the workspace provider's Cordis `workspace/changed` event.
2. Compile/import the new source before touching the running Fiber.
3. If compilation or activation fails, keep the old Fiber active and record `hmrError`; the edited file remains a working draft.
4. If compilation succeeds, await old-Fiber disposal and mount a new Fiber with the prior config and capability manifest.
5. While an agent run is active, keep one generation fixed through the current LLM request, tool dispatch snapshot, and every pre/post-execute hook. Commit pending source at the following `loop/safe-point`; the next internal request sees the new generation without replacing the task, broker, or loop session. `loop/idle` is the fallback for terminal and aborted runs.
6. At a safe point, consume even a not-yet-mature 300-ms editor debounce so a tool that just edited a capability can use the new version on the next internal turn.
7. Publish `.harness/capabilities/<id>/index.js` only after activation succeeds. On refresh, a rejected working draft falls back to this last active revision without overwriting the draft.

The project is still pre-release, so there is no persisted plugin-format version gate. Source-dialect changes happen in place; `?reset` remains the explicit way to reseed shipped plugins during development.

## Why Cordis is in the browser

The Harness needs more than a conversational DOM editor: it needs dependency-aware capabilities, long-running task services, artifacts, provider bridges, UI projections, and recoverable dynamic code. Vue effect scopes handled component cleanup well, but they made non-UI capabilities masquerade as components and did not provide a real service/plugin state machine. Running Cordis directly restores those semantics without weakening the sandbox boundary.
