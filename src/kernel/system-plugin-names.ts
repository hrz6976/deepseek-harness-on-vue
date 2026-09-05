import { BUILTIN_CAPABILITIES, SYSTEM_PLUGINS, RETIRED_SYSTEM_NAMES } from './builtin-plugins';
/** Names that can never be restored as dynamic capability packages. */
export const SYSTEM_PLUGIN_NAMES = [...Object.keys(SYSTEM_PLUGINS).filter(id => !BUILTIN_CAPABILITIES[id]), ...RETIRED_SYSTEM_NAMES];
export const systemPluginNames = new Set<string>(SYSTEM_PLUGIN_NAMES);
export function systemPluginNameFromPath(path: string): string | null {
  const match = /^\.plugins\/([^/]+)\.js$/u.exec(path);
  return match && systemPluginNames.has(match[1]!) ? match[1]! : null;
}
