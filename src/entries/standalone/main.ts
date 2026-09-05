import { acquireRuntimeLease } from '@/kernel/runtime-lease';
// Standalone entry. The root app and framework services are bundled. Shipped
// UI/task capabilities are source defaults seeded into OPFS. Editable names
// use the same HMR path as agent-created capabilities; protected names remain
// readable but workspace-locked. ?reset wipes capability state, not secrets.
import * as Vue from 'vue';
import { capabilities } from '@/kernel/capabilities';
import { pluginPolicy } from '@/kernel/plugin-policy';
import { modules } from '@/kernel/modules';
import { startHarnessRuntime } from '@/kernel/runtime-supervisor';
import { cordisContextKey } from '@/kernel/cordis';
import { UiContributionsHost } from '@/kernel/ui';
import fsPlugin from '@/plugins/fs';
import defaults from 'virtual:plugin-defaults';
import { ModelConnection } from './model-connection';
import { log } from '@/kernel/log';

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
              <span class="badge">{{ policy(p.manifest.id).source }} · {{ policy(p.manifest.id).reload }}</span>
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
    return { plugins, isCore, policy: pluginPolicy };
  },
});

globalThis.__harness = Object.freeze({ modules });

const releaseRuntime = await acquireRuntimeLease('standalone').catch(error => {
  document.getElementById('app')!.textContent = error instanceof Error ? error.message : String(error);
  throw error;
});
window.addEventListener('pagehide', releaseRuntime, { once: true });
const runtime = startHarnessRuntime({
  defaults,
  infrastructure: [
    fsPlugin,
  ],
});
const app = createApp(App);
// Contribution components are global so runtime-compiled plugin templates use
// them with zero imports.
app.component('UiContributionsHost', UiContributionsHost);
const shellContext = await runtime.shellContext;
await runtime.ready;
new ModelConnection(shellContext);
await shellContext.modelConnection.restore().catch(error => log(`Model connection failed: ${String(error)}`, 'err'));
app.provide(cordisContextKey, shellContext);

app.mount('#app');
