import { resolve } from 'node:path';
import { build } from 'vite';
import { PUBLIC_PLUGIN_MODULES, normalizePluginSpecifier } from '../src/shared/plugin-modules';

/** Bundle repository modules; leave only the sandbox's public imports external. */
export async function bundlePlugin(entry: string): Promise<{ source: string; files: string[] }> {
  const external = new Set<string>();
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    resolve: { alias: { '@': resolve('src') } },
    build: {
      write: false, minify: false, target: 'es2022',
      lib: { entry, name: '__harnessPlugin', formats: ['iife'] },
      rolldownOptions: {
        external(id) {
          const normalized = normalizePluginSpecifier(id);
          if (!(PUBLIC_PLUGIN_MODULES as readonly string[]).includes(normalized)) return false;
          external.add(normalized);
          return true;
        },
        output: { globals: id => `globalThis.__harness.modules[${JSON.stringify(normalizePluginSpecifier(id))}]` },
      },
    },
  });
  if (!Array.isArray(result)) throw new Error(`Expected a library bundle for ${entry}`);
  const chunks = result.flatMap(output => output.output);
  if (chunks.length !== 1 || chunks[0]?.type !== 'chunk') throw new Error(`Plugin ${entry} must produce one JavaScript file`);
  const chunk = chunks[0];
  // Import declarations also tell the runtime which lazy public modules to prepare.
  const imports = [...external].map((id, index) => `import * as __dependency${index} from ${JSON.stringify(id)};`).join('\n');
  return {
    source: `// harness-bundled-plugin\n${imports}\n${chunk.code}\nexport default __harnessPlugin.default ?? __harnessPlugin;`,
    files: Object.keys(chunk.modules).filter(file => !file.startsWith('\0')),
  };
}
