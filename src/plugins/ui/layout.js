// UI contribution seam: no panel registry — a plugin's render output IS its
// panel; placement uses native <Teleport> into target ELEMENTS handed out by
// the layout service (never #id selectors: host-page id collisions are a
// Phase-2 hazard). The v-if on the target covers mount timing: the target
// element registers reactively when the layout frame mounts.
import { computed } from 'vue';
import { useService } from '../../kernel/services.js';

export function useLayoutTarget(region) {
  const layout = useService('layout');
  return computed(() => layout.value?.regions.get(region) ?? null);
}
