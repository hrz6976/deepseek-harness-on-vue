// preview UI plugin: sandboxed iframe live preview of index.html.
import { ref, computed } from 'vue';
import { useService } from '../../kernel/services';
import { useLayoutTarget } from '../../kernel/contrib';

export const previewPlugin = {
  name: 'preview',
  template: `
  <Teleport v-if="target && html" :to="target">
    <div class="panel">
      <h2>Preview (iframe sandbox)</h2>
      <button class="primary" @click="show = !show">{{ show ? 'Close preview' : 'Preview index.html' }}</button>
      <iframe v-if="show" sandbox="allow-scripts" :srcdoc="html"></iframe>
    </div>
  </Teleport>`,
  setup() {
    const target = useLayoutTarget('side');
    const fsSvc = useService('fs');
    const show = ref(false);
    const html = computed(() => fsSvc.value?.read('index.html') || '');
    return { target, show, html };
  },
};

export default previewPlugin;
