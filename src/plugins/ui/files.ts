// files UI plugin: virtual filesystem browser (OPFS-persisted).
import type { Context } from '@deepseek-ai/cordis';
import { defineComponent, ref, computed } from 'vue';
import { useService } from '@/sdk';

const FilesPanel = defineComponent({
  name: 'FilesPanel',
  template: `
  <div class="panel">
      <h2>Files (OPFS, survives refresh)</h2>
      <div v-if="!fileList.length" class="dim">(empty — files the agent creates appear here)</div>
      <div v-for="f in fileList" :key="f" class="file" :class="{ active: selected === f }" @click="selected = f">📄 {{ f }}</div>
      <div v-if="selected && content !== null" class="fileview">{{ content }}</div>
  </div>`,
  setup() {
    const fsSvc = useService('fs');
    const selected = ref('');
    const fileList = computed(() => fsSvc.value?.list() ?? []);
    const content = computed(() => (selected.value ? fsSvc.value?.read(selected.value) ?? null : null));
    return { fsSvc, selected, fileList, content };
  },
});

export const filesPlugin = {
  name: 'files',
  inject: ['ui'],
  apply(ctx: Context) { ctx.ui.register({ name: 'files', region: 'side', order: 10, component: FilesPanel }); },
};

export default filesPlugin;
