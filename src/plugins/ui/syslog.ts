// syslog UI plugin: renders the kernel log (mount/unmount/HMR events and
// every self-modification the agent performs — the human-visible audit trail).
import { ref, watch, nextTick } from 'vue';
import { entries } from '../../kernel/log';
import { useLayoutTarget } from '../../kernel/contrib';

export const syslogPlugin = {
  name: 'syslog',
  template: `
  <Teleport v-if="target" :to="target">
    <div class="panel">
      <h2>Runtime log (mount / unmount / HMR)</h2>
      <div id="syslog" ref="el"><div v-for="(l, i) in entries" :key="i" :class="l.level">· {{ l.text }}</div></div>
    </div>
  </Teleport>`,
  setup() {
    const target = useLayoutTarget('side');
    const el = ref<HTMLDivElement | null>(null);
    watch(() => entries.value.length, () => nextTick(() => { if (el.value) el.value.scrollTop = el.value.scrollHeight; }));
    return { target, entries, el };
  },
};

export default syslogPlugin;
