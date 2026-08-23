// preview UI plugin: sandboxed iframe live preview of index.html.
import type { Context } from '@deepseek-ai/cordis';
import { defineComponent, ref, computed } from 'vue';
import { useService } from '@/sdk';

const PreviewPanel = defineComponent({
  name: 'PreviewPanel',
  template: `
  <div v-if="html" class="panel">
      <h2>Preview (iframe sandbox)</h2>
      <button class="primary" @click="show = !show">{{ show ? 'Close preview' : 'Preview index.html' }}</button>
      <iframe v-if="show" sandbox="allow-scripts" :srcdoc="html"></iframe>
  </div>`,
  setup() {
    const fsSvc = useService('fs');
    const show = ref(false);
    const html = computed(() => fsSvc.value?.read('index.html') || '');
    return { show, html };
  },
});

export const previewPlugin = {
  name: 'preview',
  inject: ['ui'],
  apply(ctx: Context) { ctx.ui.register({ name: 'preview', region: 'side', order: 20, component: PreviewPanel }); },
};

export default previewPlugin;
