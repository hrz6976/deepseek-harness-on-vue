import type { Context, Plugin } from '@deepseek-ai/cordis';
import { defineComponent, ref, watch, nextTick } from 'vue';
import { logEntries as entries } from '@/sdk';

// syslog UI plugin: renders the kernel log (mount/unmount/HMR events and
// every self-modification the agent performs — the human-visible audit trail).

const SyslogPanel = defineComponent({
  name: 'SyslogPanel',
  template: `
  <div class="panel">
      <h2>Runtime log (mount / unmount / HMR)</h2>
      <div id="syslog" ref="el"><div v-for="(l, i) in entries" :key="i" :class="l.level">· {{ l.text }}</div></div>
  </div>`,
  setup() {
    const el = ref<HTMLDivElement | null>(null);
    watch(() => entries.value.length, () => nextTick(() => { if (el.value) el.value.scrollTop = el.value.scrollHeight; }));
    return { entries, el };
  },
});

export default {
  name: 'syslog',
  inject: ['ui'],
  apply(ctx: Context) { ctx.ui.register({ name: 'syslog', region: 'side', order: 40, component: SyslogPanel }); },
} satisfies Plugin.Object;
