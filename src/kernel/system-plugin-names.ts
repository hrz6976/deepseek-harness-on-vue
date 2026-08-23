/** Bundled and retired framework names are never OPFS-editable capabilities. */
export const SYSTEM_PLUGIN_NAMES = [
  'shell',
  'fs',
  'ui',
  'tools',
  'prompt',
  'manager',
  'task-runtime',
  'state',
  'loop',
] as const;

export const systemPluginNames = new Set<string>(SYSTEM_PLUGIN_NAMES);

export function systemPluginNameFromPath(path: string): string | null {
  const match = /^\.plugins\/([^/]+)\.js$/u.exec(path);
  return match && systemPluginNames.has(match[1]!) ? match[1]! : null;
}
