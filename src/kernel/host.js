// Plugin host: the reactive plugin list + mount/unmount + the PluginHost
// error boundary. Component instance = plugin instance; removing a plugin
// from the array unmounts its component, and Vue reclaims every effect it
// registered (services, bus listeners, contributions, watchers, timers).
import { reactive, markRaw, h, provide, onErrorCaptured } from 'vue';
import { bus } from './bus.js';
import { log } from './log.js';

export const plugins = reactive([]);

// Agent-readable state, via Vue's own primitive: a plugin that calls
// ctx.expose({...}) in setup() gets its exposed proxy captured here (keyed by
// plugin name — the host already guarantees uniqueness). Plain Map, NOT
// reactive: every reader is pull-based (read_state tool, request-time prompt
// assembly), and the values are instance proxies that must not be re-proxied.
export const exposedStates = new Map();

// Vnode-ref callback for one PluginHost. `val.$.exposed` distinguishes an
// exposed proxy (expose() was called) from the default public instance —
// only explicit expose() opts a plugin's state in. Deletion is token-guarded
// like every other registry here: an HMR remount may mount the replacement
// before the old instance's ref(null) fires, and the late cleanup must not
// take out the fresh capture.
export function makeExposeCapture(name) {
  let captured = null;
  return val => {
    if (val && val.$ && val.$.exposed) { captured = val; exposedStates.set(name, val); }
    else if (captured && exposedStates.get(name) === captured) { exposedStates.delete(name); captured = null; }
  };
}

export function mountPlugin(name, def, { builtin = false, config = null } = {}) {
  const i = plugins.findIndex(p => p.name === name);
  if (i >= 0) plugins.splice(i, 1);
  plugins.push({ name, def: markRaw(def), version: 0, status: 'active', error: '', hmrError: '', builtin, config });
  log(`plugin [${name}] mounted`, 'ok');
  bus.emit('plugin/mounted', name);
}

export function unmountPlugin(name) {
  const i = plugins.findIndex(p => p.name === name);
  if (i < 0) return false;
  plugins.splice(i, 1);
  log(`plugin [${name}] unmounted, all effects reclaimed`, 'warn');
  bus.emit('plugin/unmounted', name);
  return true;
}

// Error boundary per plugin instance (cordis fault isolation). Also provides
// 'pluginName' so contributions and bus listeners can attribute themselves.
export const PluginHost = {
  name: 'PluginHost',
  props: { plugin: { type: Object, required: true } },
  setup(props) {
    provide('pluginName', props.plugin.name);
    onErrorCaptured(err => {
      props.plugin.status = 'failed';
      props.plugin.error = err?.message || String(err);
      log(`plugin [${props.plugin.name}] runtime error: ${props.plugin.error}`, 'err');
      return false; // stop propagation: one bad plugin must not take down the app
    });
    const retry = () => { props.plugin.status = 'active'; props.plugin.error = ''; props.plugin.version++; };
    const capture = makeExposeCapture(props.plugin.name);
    return () => props.plugin.status === 'failed'
      ? h('div', { class: 'plugin-error' }, [
          h('div', `plugin ${props.plugin.name} crashed: ${props.plugin.error}`),
          h('button', { onClick: retry }, 'retry (remount)'),
        ])
      : h(props.plugin.def, { ...(props.plugin.config || {}), ref: capture });
  },
};
