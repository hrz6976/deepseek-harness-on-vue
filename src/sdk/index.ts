/**
 * Public surface available to sandbox plugins.
 *
 * This module is deliberately a membrane rather than a re-export barrel for
 * kernel internals. Dynamic source may use these Vue-facing adapters and
 * validated contracts, while runtime ownership, mounting, compilation and
 * persistence remain private to the bundled kernel.
 */
import { useBusOn as useBusOnInternal } from '@/kernel/bus';
import type { PageEvent } from '@/shared/page-protocol';

export { isSiteUserScript } from '@/shared/page-protocol';

export function usePageEvent(listener: (event: PageEvent) => unknown): () => void {
  return useBusOnInternal('page/event', listener);
}

export { useService } from '@/kernel/services';
export {
  useBusOn,
  useRequestTransform,
  useToolGuard,
} from '@/kernel/bus';
export {
  usePromptSection,
  useTool,
} from '@/kernel/contrib';
export { entries as logEntries, log } from '@/kernel/log';
export { errorMessage, parseJsonObject } from '@/shared/runtime';
export { renderMarkdown } from '@/shared/markdown';
export { normalizeSessionLlmConfig } from '@/shared/task-model';
export { lockedPluginNameFromPath, pluginPolicy } from '@/kernel/plugin-policy';
export { systemPluginNameFromPath } from '@/kernel/system-plugin-names';
export {
  CapabilityManifestSchema,
  CapabilityPermissionSchema,
  CapabilityProviderSchema,
  CapabilityScopeSchema,
} from '@/shared/capability-protocol';
export {
  ElementFingerprintSchema,
  ElementRefSchema,
  JsonValueSchema,
  LiveRuleActionSchema,
  LiveRuleSchema,
  PatchOperationSchema,
  SiteRecipeSchema,
  SiteSkillSchema,
  SiteUserScriptSchema,
} from '@/shared/broker-schema';
export type { LiveRule, LiveRuleAction, LiveRulePredicate, PageEvent, SiteRecipe, SiteSkill, SiteUserScript } from '@/shared/page-protocol';
