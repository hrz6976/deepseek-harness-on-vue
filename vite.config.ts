import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crx } from '@crxjs/vite-plugin';
import { defineConfig, transformWithOxc, type Plugin } from 'vite';
import manifest from './src/extension/manifest.ts';
import { systemPluginNames } from './src/kernel/system-plugin-names.ts';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const pluginRoots = ['src/plugins', 'src/plugins/tools', 'src/plugins/ui'];
const onDemand = new Set(['llm']);
const virtualId = 'virtual:plugin-defaults';
const resolvedVirtualId = `\0${virtualId}`;

/**
 * Builtins are authored as TypeScript but remain user-editable JavaScript in
 * the virtual filesystem. Vite strips their types and embeds the resulting
 * ESM source strings as the write-if-missing factory state.
 */
function pluginDefaults(): Plugin {
  let watchedFiles: string[] = [];
  return {
    name: 'harness-plugin-defaults',
    resolveId(id) {
      return id === virtualId ? resolvedVirtualId : null;
    },
    async load(id) {
      if (id !== resolvedVirtualId) return null;
      const files = (
        await Promise.all(pluginRoots.map(async root => {
          const absoluteRoot = resolve(projectRoot, root);
          const entries = await readdir(absoluteRoot, { withFileTypes: true });
          return entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !systemPluginNames.has(basename(entry.name, '.ts')))
            .map(entry => join(absoluteRoot, entry.name));
        }))
      ).flat();

      watchedFiles = files;
      for (const file of watchedFiles) this.addWatchFile(file);

      const defaults: Record<string, { source: string; autoMount?: boolean }> = {};
      for (const file of files) {
        const name = basename(file, '.ts');
        if (defaults[name]) throw new Error(`duplicate plugin name "${name}" (${file})`);
        const result = await transformWithOxc(await readFile(file, 'utf8'), file, {
          lang: 'ts',
          sourceType: 'module',
          target: 'es2022',
          sourcemap: false,
        });
        defaults[name] = {
          source: result.code,
          ...(onDemand.has(name) ? { autoMount: false } : {}),
        };
      }
      return `export default ${JSON.stringify(defaults)};`;
    },
    handleHotUpdate(context) {
      if (watchedFiles.includes(context.file)) {
        const module = context.server.moduleGraph.getModuleById(resolvedVirtualId);
        if (module) context.server.moduleGraph.invalidateModule(module);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const extensionBuild = mode === 'extension';
  const htmlInput: Record<string, string> = extensionBuild
    // The manifest owns the fallback entry. The real agent panel is selected
    // dynamically, so keep it as an explicit HTML entry as well.
    ? { sidepanel: resolve(projectRoot, 'src/extension/sidepanel.html') }
    : { standalone: resolve(projectRoot, 'index.html') };
  return {
    plugins: [
      pluginDefaults(),
      ...(extensionBuild ? [crx({ manifest })] : []),
    ],
    resolve: {
      alias: {
        '@': resolve(projectRoot, 'src'),
        vue: 'vue/dist/vue.esm-bundler.js',
      },
    },
    define: {
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    build: {
      outDir: extensionBuild ? 'dist/extension' : 'dist/standalone',
      emptyOutDir: true,
      sourcemap: true,
      target: 'es2022',
      rollupOptions: { input: htmlInput },
    },
  };
});
