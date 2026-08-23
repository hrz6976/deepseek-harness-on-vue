// Standalone entry. The root app and framework services are bundled. Shipped
// UI/task capabilities are source defaults seeded into OPFS and use the same
// compile/HMR path as agent-created capabilities. ?reset is the capability
// factory reset (wipes .plugins/ and capability packages, keeps localStorage).
import * as Vue from 'vue';
import { services, provideService } from '@/kernel/services';
import { plugins } from '@/kernel/host';
import { modules } from '@/kernel/modules';
import { startHarnessRuntime } from '@/kernel/runtime-supervisor';
import { cordisContextKey } from '@/kernel/cordis';
import { UiContributionsHost } from '@/kernel/ui';
import { fsPlugin } from '@/plugins/fs';
import defaults from 'virtual:plugin-defaults';

const { createApp, shallowReactive } = Vue;

const App = Vue.defineComponent({
  name: 'HarnessFrame',
  template: `
    <h1>DeepSeek Harness on Vue</h1>
    <div class="sub">Cordis kernel + sandbox capabilities — framework services are bundled system Fibers; editable task/UI capabilities load from OPFS with transactional HMR</div>
    <div class="layout">
      <div :ref="el => setRegion('main', el)"><UiContributionsHost region="main" /></div>
      <div>
        <div :ref="el => setRegion('side', el)"><UiContributionsHost region="side" /></div>
        <div class="panel">
          <h2>Plugins ({{ plugins.length }} mounted; plugin UI renders here)</h2>
          <div v-for="p in plugins" :key="p.name + ':' + p.version" class="plugin-box">
            <div class="pname">🔌 {{ p.name }}
              <span class="badge">{{ isCore(p.name) ? 'core' : 'user' }}</span>
              <span v-if="p.hmrError" class="badge hmr">HMR failed, old version running</span>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  setup() {
    const regions = shallowReactive(new Map<string, Element>());
    // Layout-first: regions register as the frame's elements mount, before/
    // reactively-visible-to any plugin Teleport (they v-if on the target).
    provideService('layout', { regions, target: (name: string) => regions.get(name) ?? null });
    const setRegion = (name: string, element: Element | null) => { if (element) regions.set(name, element); };
    // Shipped capabilities are reseeded by ?reset; kernel services do not
    // appear here because they are system Fibers, not editable source.
    const isCore = (name: string) => name in defaults;
    return { plugins, setRegion, isCore };
  },
});

const runtime = startHarnessRuntime({
  defaults,
  infrastructure: [{ name: 'workspace', plugin: fsPlugin }],
});
const app = createApp(App);
// Contribution components are global so runtime-compiled plugin templates use
// them with zero imports.
app.component('UiContributionsHost', UiContributionsHost);
const shellContext = await runtime.shellContext;
app.provide(cordisContextKey, shellContext);
app.provide('services', services);

// The only global used by blob-loaded source is its frozen public module map.
// Root Cordis, mounting, compilation, stores and contribution registries stay
// private to the bundle.
globalThis.__harness = Object.freeze({ modules });

app.mount('#app');
void runtime.ready;
