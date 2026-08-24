// chat UI plugin: streaming conversation panel — text blocks, collapsible
// thinking, tool cards forming during the stream, stop button.
import type { Context } from '@deepseek-ai/cordis';
import { defineComponent, ref, computed, watch, nextTick } from 'vue';
import { parseJsonObject, renderMarkdown, useService } from '@/sdk';
import type { JsonObject } from '@/shared/runtime';

const ChatPanel = defineComponent({
  name: 'ChatPanel',
  template: `
  <div class="panel">
      <h2>Conversation <span v-if="engineName" class="badge">{{ engineName }}</span><span v-if="ctxInfo" class="badge">{{ ctxInfo }}</span></h2>
      <div id="chat" ref="chatEl">
        <template v-for="(m, i) in visible" :key="i">
          <div v-if="m.role === 'user'" class="msg user"><span class="who">you</span>{{ m.text }}</div>
          <div v-else-if="m.role === 'assistant'" class="msg assistant">
            <span class="who">agent<span v-if="m.status==='streaming'"> · streaming</span></span>
            <details v-if="m.thinking" class="thinking" :open="m.status==='streaming'">
              <summary>thinking ({{ m.thinking.length }} chars)</summary>
              <div class="body markdown-body" v-html="renderMarkdown(m.thinking)"></div>
            </details>
            <div v-if="m.text" class="markdown-body" :class="{ cursor: m.status==='streaming' && !m.toolCalls.length }" v-html="renderMarkdown(m.text)"></div>
            <span v-else-if="!m.toolCalls.length" :class="{ cursor: m.status==='streaming' }">…</span>
            <div v-for="(tc, j) in m.toolCalls" :key="j" class="toolcall">
              <span class="status" :class="tc.status">{{ tc.status === 'done' ? '✓ done' : tc.status === 'running' ? 'running' : 'pending' }}</span>
              🔧 {{ tc.name }}({{ summarizeArgs(tc.args) }})
              <div v-if="tc.result != null" class="result">{{ truncate(tc.result) }}</div>
            </div>
          </div>
          <div v-else class="msg note">{{ m.text }}</div>
        </template>
      </div>
      <textarea v-model="goal" :disabled="!connected || running" @keydown.ctrl.enter="run"
        placeholder="e.g. write a snake game into index.html — or: build yourself a plugin with a dice tool and a panel"></textarea>
      <button class="primary" @click="run" :disabled="!connected || running || !goal.trim()">Run (Ctrl+Enter)</button>
      <button class="danger" @click="stop" :disabled="!running">Stop</button>
      <button @click="resetSession" :disabled="running">Clear session & files</button>
      <button v-if="compaction" @click="compactNow" :disabled="running || compacting || !visible.length"
        title="Summarize older messages into a checkpoint to free context">{{ compacting ? 'Compacting…' : 'Compact' }}</button>
  </div>`,
  setup() {
    const loopSvc = useService('loop');
    const taskSvc = useService('task');
    const llmSvc = useService('llm');
    const fsSvc = useService('fs');
    const compactionSvc = useService('compaction');
    const goal = ref('');
    const chatEl = ref<HTMLElement | null>(null);

    const visible = computed(() => (taskSvc.value?.messages ?? []).filter(message => message.role !== 'summary'));
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
      taskSvc.value?.messages.splice(0);
      const fs = fsSvc.value;
      // keep .plugins/: dynamic plugin sources stay, mounted plugins keep running, restore still works after refresh
      if (fs) for (const p of fs.list().filter(p => !p.startsWith('.plugins/'))) fs.remove(p);
    };

    const summarizeArgs = (s: string | JsonObject): string => {
      const o = typeof s === 'string' ? parseJsonObject(s) : (s ?? {});
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

    return { goal, chatEl, visible, running, connected, engineName, run, stop, resetSession, summarizeArgs, truncate, renderMarkdown,
             compaction, compacting, ctxInfo, compactNow };
  },
});

export default {
  name: 'chat',
  inject: ['ui'],
  apply(ctx: Context) { ctx.ui.register({ name: 'chat', region: 'main', order: 10, component: ChatPanel }); },
};
