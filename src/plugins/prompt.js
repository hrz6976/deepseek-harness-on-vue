// prompt: system-prompt assembly SERVICE. Sections register through the
// kernel contribution ABI (<PromptSection> / usePromptSection in
// kernel/contrib.js) into the kernel's 'prompt section' collector; this
// plugin owns only the assembly policy, so reloading it never drops the
// registered sections. The loop assembles the prompt at request time (the
// PoC hardcoded the prompt inside the loop; this is the fix).
import { onUnmounted } from 'vue';
import { getCollector } from '../kernel/collector.js';
import { provideService } from '../kernel/services.js';
import { log } from '../kernel/log.js';

const sections = getCollector('prompt section');

export const promptPlugin = {
  name: 'prompt',
  setup() {
    provideService('prompt', {
      sections: sections.entries,
      // ctx is handed to function-typed sections (e.g. { fileList }).
      assemble(ctx = {}) {
        const sorted = [...sections.entries.entries()]
          .map(([name, t]) => ({ name, ...t.def }))
          .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
        return sorted
          .map(s => (typeof s.text === 'function' ? s.text(ctx) : s.text))
          .filter(t => t && String(t).trim())
          .join('\n\n');
      },
    });
    onUnmounted(() => log('prompt plugin unmounted', 'warn'));
    return () => null;
  },
};
