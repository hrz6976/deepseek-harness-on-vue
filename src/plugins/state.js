// state: agent-readable component state, built on Vue's expose() primitive —
// no custom contribution channel. A plugin opts in with ctx.expose({...}) in
// setup(); PluginHost captures the exposed proxy into kernel/host.js's
// exposedStates map, and this plugin is just the read face over that map.
// Reads are live: the exposed proxy unwraps refs at access time, so the agent
// always sees state as mutated by user interaction since the last turn.
import { onUnmounted } from 'vue';
import { provideService } from '../kernel/services.js';
import { exposedStates } from '../kernel/host.js';
import { log } from '../kernel/log.js';

const STATE_LIMIT = 8000; // chars, same convention as the loop's tool-result cap

// JSON view of an exposed proxy: functions drop out (JSON semantics), refs
// unwrap (the proxy's get trap), circular/throwing state degrades to an error
// string instead of crashing the tool call.
export function serializeState(val, limit = STATE_LIMIT) {
  try {
    const json = JSON.stringify(val) ?? '{}';
    return json.length > limit ? json.slice(0, limit) + ` …(truncated, ${json.length} chars total)` : json;
  } catch (e) {
    return `Error: state is not JSON-serializable: ${e.message}`;
  }
}

export const statePlugin = {
  name: 'state',
  setup() {
    provideService('state', {
      // Key names come straight from the exposed object — they double as the
      // model-facing description in the read_state prompt index.
      list: () => [...exposedStates.entries()].map(([name, s]) => ({ name, keys: Object.keys(s) })),
      read(name) {
        const s = exposedStates.get(name);
        if (!s) return `Error: plugin ${name} exposes no state (currently exposing: ${[...exposedStates.keys()].join(', ') || 'none'})`;
        return serializeState(s);
      },
    });
    onUnmounted(() => log('state plugin unmounted', 'warn'));
    return () => null;
  },
};
