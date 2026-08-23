// Vue-facing convenience adapters. New plugins should register directly in
// apply(ctx); these helpers exist for host UI code that already runs in a Vue
// setup scope. There are intentionally no contribution components: templates
// describe real UI, never a plugin manifest.
import { getCurrentInstance, onUnmounted } from 'vue';
import type { ZodType } from 'zod';
import { currentCordisContext } from './cordis';
import type { NamedToolDefinition, PromptSectionDefinition, ServiceTypes } from '@/shared/runtime';

type ContributionService = 'tools' | 'prompt';

function useContribution<K extends ContributionService>(name: K, register: (service: ServiceTypes[K]) => () => Promise<void>) {
  const ctx = currentCordisContext();
  const service = ctx.reflect.get(name) as ServiceTypes[K] | undefined;
  const dispose = service ? register(service) : ctx.inject([name], injected => {
    register(injected.reflect.get(name) as ServiceTypes[K]);
  }).dispose;
  if (getCurrentInstance()) onUnmounted(() => { void dispose(); });
  return dispose;
}

export const useTool = <Parameters extends ZodType>(def: NamedToolDefinition<Parameters>) =>
  useContribution('tools', tools => tools.register(def as NamedToolDefinition));

export const usePromptSection = (def: PromptSectionDefinition) =>
  useContribution('prompt', prompt => prompt.register(def));
