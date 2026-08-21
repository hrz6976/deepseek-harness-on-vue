// settings UI plugin: LLM connection config. Connect = ask the manager to
// mount the llm plugin from .plugins/llm.js with the cfg as component props;
// disconnect = unmount it, file kept (service revoked, chat disables).
// Key lives in localStorage only — never OPFS (files are agent-readable).
import { reactive, computed, onMounted, nextTick } from 'vue';
import { useService } from '../../kernel/services';
import { useLayoutTarget } from '../../kernel/contrib';

const LS = { baseURL: 'harness.baseURL', model: 'harness.model', apiKey: 'harness.apiKey', mock: 'harness.mock', auto: 'harness.autoconnect' };

export const settingsPlugin = {
  name: 'settings',
  template: `
  <Teleport v-if="target" :to="target">
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
      <button class="primary" @click="connect" :disabled="connected || (!cfg.apiKey && !cfg.mock && !viaProxy)">Mount LLM plugin</button>
      <button class="danger" @click="disconnect" :disabled="!connected || running">Unmount LLM plugin</button>
      <span style="font-size:12px"><span class="dot" :class="connected ? 'on' : 'off'"></span>{{ connected ? engineName : 'not connected' }}</span>
    </div>
  </Teleport>`,
  setup() {
    const target = useLayoutTarget('side');
    const llmSvc = useService('llm');
    const loopSvc = useService('loop');
    const mgrSvc = useService('manager');
    const cfg = reactive({
      baseURL: localStorage.getItem(LS.baseURL) || '/proxy',
      model: localStorage.getItem(LS.model) || 'deepseek-v4-flash',
      apiKey: localStorage.getItem(LS.apiKey) || '',
      mock: localStorage.getItem(LS.mock) === '1',
    });
    const connected = computed(() => !!llmSvc.value);
    const running = computed(() => loopSvc.value?.running?.value ?? false);
    const engineName = computed(() => llmSvc.value?.engineName?.value ?? '');
    // same-origin proxy = serve.mjs can inject the local pi credential
    const viaProxy = computed(() => cfg.baseURL.startsWith('/'));

    const connect = () => {
      localStorage.setItem(LS.baseURL, cfg.baseURL);
      localStorage.setItem(LS.model, cfg.model);
      localStorage.setItem(LS.apiKey, cfg.apiKey);
      localStorage.setItem(LS.mock, cfg.mock ? '1' : '0');
      localStorage.setItem(LS.auto, '1');
      mgrSvc.value?.mount('llm', { cfg: { ...cfg } });
    };
    const disconnect = () => { localStorage.setItem(LS.auto, '0'); mgrSvc.value?.unmount('llm'); };

    // Auto-reconnect on boot when the user was connected last session — a
    // refresh restores plugins AND the connection. Deferred past the initial
    // render pass: mountPlugin mutates the plugin list the frame is iterating.
    onMounted(() => nextTick(() => {
      if (!connected.value && localStorage.getItem(LS.auto) === '1'
          && (cfg.apiKey || cfg.mock || cfg.baseURL.startsWith('/'))) connect();
    }));

    return { target, cfg, connected, running, engineName, viaProxy, connect, disconnect };
  },
};

export default settingsPlugin;
