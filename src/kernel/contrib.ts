// Vue-facing convenience adapters. New plugins should register directly in
// apply(ctx); these helpers exist for host UI code that already runs in a Vue
// setup scope. There are intentionally no contribution components: templates
// describe real UI, never a plugin manifest.
import { computed, getCurrentInstance, onUnmounted } from 'vue';
import type { ZodType } from 'zod';
import { useService } from './services';
import { currentCordisContext } from './cordis';
import type { LayoutService, NamedToolDefinition, PromptSectionDefinition } from '@/shared/runtime';

// ---- tools ------------------------------------------------------------------
export function useTool<Parameters extends ZodType>(def: NamedToolDefinition<Parameters>) {
  const ctx = currentCordisContext();
  const tools = ctx.reflect.get('tools') as import('../plugins/tools').ToolsRuntime | undefined;
  const dispose = tools
    ? tools.register(def as NamedToolDefinition)
    : ctx.inject(['tools'], injected => { injected.tools.register(def as NamedToolDefinition); }).dispose;
  if (getCurrentInstance()) onUnmounted(() => { void dispose(); });
  return dispose;
}

// ---- prompt sections --------------------------------------------------------
export function usePromptSection(def: PromptSectionDefinition) {
  const ctx = currentCordisContext();
  const prompt = ctx.reflect.get('prompt') as import('../plugins/prompt').PromptRuntime | undefined;
  const dispose = prompt
    ? prompt.register(def)
    : ctx.inject(['prompt'], injected => { injected.prompt.register(def); }).dispose;
  if (getCurrentInstance()) onUnmounted(() => { void dispose(); });
  return dispose;
}

// ---- layout -----------------------------------------------------------------
// No panel registry — a plugin's render output IS its panel; placement uses
// native <Teleport> into target ELEMENTS handed out by the layout service
// (never #id selectors: host-page id collisions are a Phase-2 hazard). The
// v-if on the target covers mount timing: the target element registers
// reactively when the layout frame mounts.
export function useLayoutTarget(region: string) {
  const layout = useService<LayoutService>('layout');
  return computed(() => layout.value?.regions.get(region) ?? null);
}
