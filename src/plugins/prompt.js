// prompt: system-prompt fragments as contributions. Mirrors the harness's
// PromptSection { text: string | ((ctx) => string) }. The loop assembles the
// prompt from collected sections at request time (the PoC hardcoded the
// prompt inside the loop; this is the fix).
import { onUnmounted } from 'vue';
import { createCollector } from '../kernel/collector.js';
import { provideService } from '../kernel/services.js';
import { log } from '../kernel/log.js';

const sections = createCollector('prompt section');

export function usePromptSection(def) {
  const { name, order = 50, text } = def;
  return sections.add(name, { order, text });
}

export const PromptSection = {
  name: 'PromptSection',
  props: {
    name: { type: String, required: true },
    order: { type: Number, default: 50 },
    text: { type: [String, Function], required: true }, // prose in props, never slot text
  },
  setup(props) {
    usePromptSection(props);
    return () => null;
  },
};

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
