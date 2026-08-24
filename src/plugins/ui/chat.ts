// chat UI plugin: streaming conversation panel — text blocks, collapsible
// thinking, tool cards forming during the stream, stop button.
import { ref, computed, watch, nextTick } from 'vue';
import { useService } from '../../kernel/services';
import { useLayoutTarget } from '../../kernel/contrib';
import type { JsonObject } from '../../shared/runtime';

function tryParse(source: string): JsonObject { try { return JSON.parse(source) as JsonObject; } catch { return {}; } }

export const chatPlugin = {
  name: 'chat',
  template: `
  <Teleport v-if="target" :to="target">
    <div class="panel">
      <h2>Chat <span v-if="engineName" class="badge">{{ engineName }}</span><span v-if="ctxInfo" class="badge">{{ ctxInfo }}</span></h2>
      <div id="chat" ref="chatEl">
        <p v-if="!visible.length" class="empty-state">What would you like to build?</p>
        <template v-for="(m, i) in visible" :key="i">
          <div v-if="m.role === 'user'" class="msg user"><span class="who">You</span>{{ m.text }}</div>
          <div v-else-if="m.role === 'assistant'" class="msg assistant">
            <span class="who">Agent<span v-if="m.status==='streaming'"> · Working</span></span>
            <details v-if="m.thinking" class="thinking" :open="m.status==='streaming'">
              <summary>Thinking</summary>
              <div class="body">{{ m.thinking }}</div>
            </details>
            <span :class="{ cursor: m.status==='streaming' && !m.toolCalls.length }">{{ m.text || (m.toolCalls.length ? '' : '…') }}</span>
            <div v-for="(tc, j) in m.toolCalls" :key="j" class="toolcall">
              <span class="status" :class="tc.status">{{ tc.status === 'done' ? 'Done' : tc.status === 'running' ? 'Working' : 'Waiting' }}</span>
              {{ tc.name }}<span v-if="summarizeArgs(tc.args)"> · {{ summarizeArgs(tc.args) }}</span>
              <div v-if="tc.result != null" class="result">{{ truncate(tc.result) }}</div>
            </div>
          </div>
          <details v-else-if="m.role === 'summary'" class="msg summary">
            <summary>Earlier conversation summary</summary>
            <div class="body">{{ m.text }}</div>
          </details>
          <div v-else class="msg note">{{ m.text }}</div>
        </template>
      </div>
      <textarea v-model="goal" :disabled="!connected || running" @keydown.ctrl.enter="run"
        placeholder="Describe what you want to build…"></textarea>
      <button class="primary" @click="run" :disabled="!connected || running || !goal.trim()">Send</button>
      <button class="danger" @click="stop" :disabled="!running">Stop</button>
      <button @click="resetSession" :disabled="running">Reset</button>
      <button v-if="compaction" @click="compactNow" :disabled="running || compacting || !visible.length"
        title="Summarize older messages">{{ compacting ? 'Compacting…' : 'Compact' }}</button>
    </div>
  </Teleport>`,
  setup() {
    const target = useLayoutTarget('main');
    const loopSvc = useService('loop');
    const llmSvc = useService('llm');
    const fsSvc = useService('fs');
    const compactionSvc = useService('compaction');
    const goal = ref('');
    const chatEl = ref<HTMLElement | null>(null);

    const visible = computed(() => loopSvc.value?.messages ?? []);
    const running = computed(() => loopSvc.value?.running?.value ?? false);
    const connected = computed(() => !!llmSvc.value);
    const engineName = computed(() => llmSvc.value?.engineName?.value ?? '');
    const compaction = computed(() => compactionSvc.value ?? null);
    const compacting = computed(() => compaction.value?.compacting?.value ?? false);
    // reads the reactive messages array inside computed -> tracks streaming updates
    const ctxInfo = computed(() => {
      const c = compaction.value;
      if (!c || !connected.value || !visible.value.length) return '';
      // binary k, so 131072 reads as the familiar "128k"
      return `~${Math.round(c.contextTokens(visible.value) / 1024)}k / ${Math.round(c.contextWindow() / 1024)}k ctx`;
    });
    const compactNow = () => compaction.value?.compact();

    const run = async () => {
      if (!goal.value.trim() || !loopSvc.value) return;
      const g = goal.value; goal.value = '';
      await loopSvc.value.run(g);
    };
    const stop = () => loopSvc.value?.stop();
    const resetSession = () => {
      loopSvc.value?.reset();
      const fs = fsSvc.value;
      // keep .plugins/: dynamic plugin sources stay, mounted plugins keep running, restore still works after refresh
      if (fs) for (const p of fs.list().filter(p => !p.startsWith('.plugins/'))) fs.remove(p);
    };

    const summarizeArgs = (s: string | JsonObject): string => {
      const o = typeof s === 'string' ? tryParse(s) : (s ?? {});
      const parts: string[] = [];
      if (o.command) parts.push(String(o.command));
      if (o.path) parts.push(String(o.path));
      if (o.code) parts.push(String(o.code).slice(0, 40) + '…');
      if (o.name) parts.push(String(o.name));
      if (o.content) parts.push(`content ${String(o.content).length} chars`);
      if (o.source) parts.push(`source ${String(o.source).length} chars`);
      return parts.join(', ') || JSON.stringify(o).slice(0, 60);
    };
    const truncate = (s: string): string => (s.length > 500 ? s.slice(0, 500) + `\n…(${s.length} chars total)` : s);

    // auto-scroll on stream progress (DOM touched only via refs, only in UI plugins)
    watch(() => {
      const last = visible.value.at(-1);
      const assistant = last?.role === 'assistant' ? last : null;
      return [visible.value.length, last?.text.length, assistant?.thinking.length,
              assistant?.toolCalls.map(tool => (tool.status || '') + (tool.result?.length || 0)).join('|')];
    }, () => nextTick(() => { if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight; }));

    return { target, goal, chatEl, visible, running, connected, engineName, run, stop, resetSession, summarizeArgs, truncate,
             compaction, compacting, ctxInfo, compactNow };
  },
};

export default chatPlugin;
