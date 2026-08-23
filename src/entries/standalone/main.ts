// Standalone entry. The root app and framework services are bundled. Shipped
// UI/task capabilities are source defaults seeded into OPFS and use the same
// compile/HMR path as agent-created capabilities. ?reset is the capability
// factory reset (wipes .plugins/ and capability packages, keeps localStorage).
import * as Vue from 'vue';
import { capabilities } from '@/kernel/capabilities';
import { modules } from '@/kernel/modules';
import { startHarnessRuntime } from '@/kernel/runtime-supervisor';
import { cordisContextKey } from '@/kernel/cordis';
import { UiContributionsHost } from '@/kernel/ui';
import { fsPlugin } from '@/plugins/fs';
import defaults from 'virtual:plugin-defaults';

const { createApp } = Vue;
const plugins = Vue.computed(() => [...capabilities.values()]);

const App = Vue.defineComponent({
  name: 'HarnessFrame',
  template: `
    <h1>DeepSeek Harness on Vue</h1>
    <div class="sub">Cordis kernel + sandbox capabilities — framework services are bundled system Fibers; editable task/UI capabilities load from OPFS with transactional HMR</div>
    <div class="layout">
      <div><UiContributionsHost region="main" /></div>
      <div>
        <div><UiContributionsHost region="side" /></div>
        <div class="panel">
          <h2>Plugins ({{ plugins.length }} mounted; plugin UI renders here)</h2>
          <div v-for="p in plugins" :key="p.manifest.id + ':' + p.version" class="plugin-box">
            <div class="pname">🔌 {{ p.manifest.id }}
              <span class="badge">{{ isCore(p.manifest.id) ? 'core' : 'user' }}</span>
              <span v-if="p.hmrError" class="badge hmr">HMR failed, old version running</span>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  setup() {
    // Shipped capabilities are reseeded by ?reset; kernel services do not
    // appear here because they are system Fibers, not editable source.
    const isCore = (name: string) => name in defaults;
    return { plugins, isCore };
  },
});

globalThis.__harness = Object.freeze({ modules });

const runtime = startHarnessRuntime({
  defaults,
  infrastructure: [
    { name: 'workspace', plugin: fsPlugin },
  ],
});
const app = createApp(App);
// Contribution components are global so runtime-compiled plugin templates use
// them with zero imports.
app.component('UiContributionsHost', UiContributionsHost);
const shellContext = await runtime.shellContext;
app.provide(cordisContextKey, shellContext);

app.mount('#app');
void runtime.ready;
