import type { Plugin } from '@deepseek-ai/cordis';
import { defineComponent, reactive, computed, ref } from 'vue';
import { useService } from '@/sdk';

export default {
  name: 'settings',
  inject: ['ui'],
  apply(ctx) {
    ctx.ui.register({
      name: 'settings', region: 'side', order: 30,
      component: defineComponent({
        name: 'SettingsPanel',
        template: `
  <div class="panel">
      <h2>Model connection</h2>
      <div class="row">
        <div><label>Base URL</label><input type="text" v-model="cfg.baseURL" :disabled="connected"></div>
        <div><label>Model</label><input type="text" v-model="cfg.model" :disabled="connected"></div>
      </div>
      <label>API key (localStorage only; leave empty on /proxy to use local pi credentials)</label>
      <input type="password" v-model="cfg.apiKey" :disabled="connected" placeholder="sk-... or empty for pi auth">
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <input type="checkbox" v-model="cfg.mock" :disabled="connected" style="width:auto;margin:0"> mock engine (offline, no key needed)
      </label>
      <button class="primary" @click="connect" :disabled="busy || connected || (!cfg.apiKey && !cfg.mock && !viaProxy)">Mount LLM plugin</button>
      <button class="danger" @click="disconnect" :disabled="busy || !connected || running">Unmount LLM plugin</button>
      <span style="font-size:12px"><span class="dot" :class="connected ? 'on' : 'off'"></span>{{ connected ? engineName : 'not connected' }}</span>
      <p v-if="error" role="alert">{{ error }}</p>
  </div>`,
        setup() {
          const connection = useService('modelConnection');
          const cfg = reactive({ ...connection.value!.config });
          const busy = ref(false);
          const error = ref('');
          const act = async (operation: () => Promise<void>) => {
            busy.value = true;
            error.value = '';
            try { await operation(); }
            catch (reason) { error.value = String(reason); }
            finally { busy.value = false; }
          };
          const connect = () => act(() => connection.value!.connect({ ...cfg }));
          const disconnect = () => act(() => connection.value!.disconnect());
          const llmSvc = useService('llm');
          const loopSvc = useService('loop');
          const connected = computed(() => !!llmSvc.value);
          const running = computed(() => loopSvc.value?.running?.value ?? false);
          const engineName = computed(() => llmSvc.value?.engineName?.value ?? '');
          // same-origin proxy = serve.mjs can inject the local pi credential
          const viaProxy = computed(() => cfg.baseURL.startsWith('/'));

          return { cfg, busy, error, connected, running, engineName, viaProxy, connect, disconnect };
        },
      }),
    });

  },
} satisfies Plugin.Object;
