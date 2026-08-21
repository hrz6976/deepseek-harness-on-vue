// prompt: system-prompt assembly SERVICE. Sections register through the
// kernel contribution ABI (<PromptSection> / usePromptSection in
// kernel/contrib.js) into the kernel's 'prompt section' collector; this
// plugin owns only the assembly policy, so reloading it never drops the
// registered sections. The loop assembles the prompt at request time (the
// PoC hardcoded the prompt inside the loop; this is the fix).
import { onUnmounted, getCurrentInstance } from 'vue';
import { getCollector } from '../kernel/collector';
import { provideService } from '../kernel/services';
import { log } from '../kernel/log';
import type { PromptSectionDefinition } from '../shared/runtime';

const sections = getCollector<Omit<PromptSectionDefinition, 'name'>>('prompt section');

export const promptPlugin = {
  name: 'prompt',
  setup() {
    provideService('prompt', {
      sections: sections.entries,
      // ctx is handed to function-typed sections (e.g. { fileList }).
      assemble() {
        const sorted = [...sections.entries.entries()]
          .map(([name, t]) => ({ name, order: t.def.order ?? 50, ...t.def }))
          .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
        return sorted
          .map(s => (typeof s.text === 'function' ? s.text() : s.text))
          .filter(t => t && String(t).trim())
          .join('\n\n');
      },
    });
    if (getCurrentInstance()) onUnmounted(() => log('prompt plugin unmounted', 'warn'));
    return () => null;
  },
};

export default promptPlugin;
