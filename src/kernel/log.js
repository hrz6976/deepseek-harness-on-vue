// Kernel log service. Kernel-level so nothing in the kernel depends on UI;
// the syslog panel is just one consumer of `entries`. Console mirror means
// the kernel stays observable even if every UI plugin is unmounted.
import { ref } from 'vue';

export const entries = ref([]);

export function log(text, level = '') {
  entries.value.push({ text, level, at: Date.now() });
  if (entries.value.length > 300) entries.value.splice(0, 100); // ring buffer: cap memory on long runs
  const mirror = level === 'err' ? console.error : level === 'warn' ? console.warn : console.log;
  mirror(`[harness] ${text}`);
}
