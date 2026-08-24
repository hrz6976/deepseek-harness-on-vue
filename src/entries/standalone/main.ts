// Standalone entry. The root app is a bare layout frame — everything else,
// including every UI panel, is a plugin loaded FROM OPFS: the bundle carries
// only the kernel, Vue, pi-ai, the fs plugin (bootstrap dependency), and the
// shipped plugin SOURCES (virtual:plugin-defaults), which kernel/boot.js
// seeds into .plugins/ on first boot and compiles from there ever after.
// That is what makes the shipped plugins agent-editable: file-editor + HMR
// operate on them exactly like on agent-created ones. ?reset = factory reset
// (wipes .plugins/, keeps localStorage).
import * as Vue from 'vue';
import { services, provideService, useService } from '../../kernel/services';
import { bus, useBusOn, useToolGuard, useRequestTransform } from '../../kernel/bus';
import { log } from '../../kernel/log';
import { plugins, mountPlugin, unmountPlugin, PluginHost } from '../../kernel/host';
import { AgentTool, PromptSection, useTool, usePromptSection, useLayoutTarget } from '../../kernel/contrib';
import { modules } from '../../kernel/modules';
import { boot } from '../../kernel/boot';
import { fsPlugin } from '../../plugins/fs';
import defaults from 'virtual:plugin-defaults';
import './standalone.css';

const { createApp, shallowReactive } = Vue;

const App = Vue.defineComponent({
  name: 'HarnessFrame',
  template: `
    <main class="standalone-shell">
      <header class="app-header">
        <div class="brand">
          <strong>Harness</strong>
          <span class="runtime-status"><i></i>Web</span>
        </div>
      </header>
      <div class="layout">
        <section class="main-column" aria-label="Chat" :ref="el => setRegion('main', el)"></section>
        <aside class="side-column" aria-label="Workspace tools">
          <div :ref="el => setRegion('side', el)"></div>
        </aside>
      </div>
      <div class="runtime-host" aria-hidden="true">
        <PluginHost v-for="p in plugins" :key="p.name + ':' + p.version" :plugin="p" />
      </div>
    </main>`,
  setup() {
    const regions = shallowReactive(new Map<string, Element>());
    // Layout-first: regions register as the frame's elements mount, before/
    // reactively-visible-to any plugin Teleport (they v-if on the target).
    provideService('layout', { regions, target: (name: string) => regions.get(name) ?? null });
    const setRegion = (name: string, element: Element | null) => { if (element) regions.set(name, element); };
    return { plugins, setRegion };
  },
});

const app = createApp(App);
// Contribution components are global so runtime-compiled plugin templates use
// them with zero imports.
app.component('PluginHost', PluginHost);
app.component('AgentTool', AgentTool);
app.component('PromptSection', PromptSection);
// Injection face for dynamic plugins (PoC-compatible).
app.provide('services', services);
app.provide('bus', bus);
app.provide('log', log);

// The agent-facing runtime surface. Namespaced — NEVER window.Vue: Phase-2
// host pages may own window.Vue, and there must be exactly ONE Vue namespace
// across the shipped/self-modified boundary or reactivity silently breaks.
// `modules` is the dialect-v2 import registry (kernel/compile.js rewrites
// plugin imports into reads of it).
globalThis.__harness = Object.freeze({
  Vue, services, bus, log, modules,
  useService, useBusOn, useToolGuard, useRequestTransform, useTool, usePromptSection, useLayoutTarget,
  mountPlugin, unmountPlugin,
});

// fs is the ONE statically-imported plugin: everything else loads from the
// filesystem it provides. boot() waits for its service, seeds .plugins/ with
// the shipped sources (write-if-missing), then compiles + mounts them all —
// llm excepted (autoMount:false; settings mounts it with the saved config).
mountPlugin('fs', fsPlugin, { builtin: true });
app.mount('#app');
boot(defaults);
