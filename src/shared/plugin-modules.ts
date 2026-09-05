/** Runtime imports available to both authored and bundled capability source. */
export const PUBLIC_PLUGIN_MODULES = [
  'vue', '@deepseek-ai/cordis', 'zod', '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/api/openai-completions.lazy', '@harness/sdk',
] as const;
export type PublicPluginModule = typeof PUBLIC_PLUGIN_MODULES[number];

export function normalizePluginSpecifier(id: string): string {
  return ['@/sdk', '@/sdk/index', '@/sdk/index.js'].includes(id) ? '@harness/sdk' : id;
}
