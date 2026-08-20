// Contribution collector — the one shared helper behind <AgentTool> and
// <PromptSection>. Keyed by contribution NAME, not instance: instance-keying
// hides duplicates, and two same-name tools in one request is a gateway 400
// (the exact bug the PoC burned a day on).
//
// Duplicate policy ("misconfiguration fails loud", harness-style):
//   - same plugin re-adding the name  -> replace. This is what an HMR remount
//     looks like, and it is robust to either mount/unmount order because
//     removal is token-guarded (an unmount only deletes its own token).
//   - a DIFFERENT plugin adding the name -> throw. The error surfaces in that
//     plugin's PluginHost error card.
import { shallowReactive, getCurrentInstance, onUnmounted, inject } from 'vue';

export function createCollector(kind) {
  const entries = shallowReactive(new Map()); // name -> { def, plugin }

  function add(name, def, owner) {
    if (!name || typeof name !== 'string') throw new Error(`a ${kind} contribution needs a string name`);
    const plugin = owner ?? (getCurrentInstance() ? inject('pluginName', null) : null);
    const prev = entries.get(name);
    if (prev && prev.plugin !== plugin)
      throw new Error(`duplicate ${kind} "${name}": already contributed by plugin [${prev.plugin}]`);
    const token = { def, plugin };
    entries.set(name, token);
    const dispose = () => { if (entries.get(name) === token) entries.delete(name); };
    if (getCurrentInstance()) onUnmounted(dispose);
    return dispose;
  }

  return {
    entries, // reactive: computeds over it re-run when contributions mount/unmount
    add,
    get: name => entries.get(name)?.def,
    names: () => [...entries.keys()],
    // Frozen copy for per-request snapshots (see loop.js).
    snapshot: () => new Map([...entries].map(([name, t]) => [name, t.def])),
  };
}

// Kind-keyed singletons: a collector must outlive the plugin modules that use
// it. Plugins load (and RELOAD) from OPFS source — a collector held at plugin-
// module scope would be re-created on reload as an empty map, orphaning every
// other plugin's registrations. createCollector stays exported for tests that
// want a private instance.
const registry = new Map();
export function getCollector(kind) {
  let c = registry.get(kind);
  if (!c) { c = createCollector(kind); registry.set(kind, c); }
  return c;
}
