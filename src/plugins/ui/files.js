// files UI plugin: virtual filesystem browser (OPFS-persisted).
import { ref, computed } from 'vue';
import { useService } from '../../kernel/services.js';
import { useLayoutTarget } from '../../kernel/contrib.js';

export const filesPlugin = {
  name: 'files',
  template: `
  <Teleport v-if="target" :to="target">
    <div class="panel">
      <h2>Files (OPFS, survives refresh)</h2>
      <div v-if="!fileList.length" class="dim">(empty — files the agent creates appear here)</div>
      <div v-for="f in fileList" :key="f" class="file" :class="{ active: selected === f }" @click="selected = f">📄 {{ f }}</div>
      <div v-if="selected && content !== null" class="fileview">{{ content }}</div>
    </div>
  </Teleport>`,
  setup() {
    const target = useLayoutTarget('side');
    const fsSvc = useService('fs');
    const selected = ref('');
    const fileList = computed(() => fsSvc.value?.list() ?? []);
    const content = computed(() => (selected.value ? fsSvc.value?.read(selected.value) ?? null : null));
    return { target, fsSvc, selected, fileList, content };
  },
};

export default filesPlugin;
