import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crx } from '@crxjs/vite-plugin';
import { compile } from '@vue/compiler-dom';
import { defineConfig, type Plugin } from 'vite';
import manifest from './src/extension/manifest.ts';
import { BUILTIN_CAPABILITIES, type RuntimeEnvironment } from './src/kernel/builtin-plugins';
import { bundlePlugin } from './scripts/plugin-bundle';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const virtualId = 'virtual:plugin-defaults';
const resolvedVirtualId = `\0${virtualId}`;

function vueTemplates(): Plugin {
  return {
    name: 'harness-vue-templates',
    enforce: 'pre',
    async load(id) {
      const suffix = '?vue-template';
      if (!id.endsWith(suffix)) return null;
      const file = id.slice(0, -suffix.length);
      return compile(await readFile(file, 'utf8'), { mode: 'module' }).code;
    },
  };
}

/**
 * Build each environment's capability entry with its local modules. The
 * workspace stores one JavaScript artifact; trusted metadata controls edits.
 */
function pluginDefaults(environment: RuntimeEnvironment): Plugin {
  let watchedFiles: string[] = [];
  return {
    name: 'harness-plugin-defaults',
    resolveId(id) {
      return id === virtualId ? resolvedVirtualId : null;
    },
    async load(id) {
      if (id !== resolvedVirtualId) return null;
      const defaults: Record<string, { source: string; autoMount: boolean }> = {};
      const dependencies = new Set<string>();
      for (const [name, descriptor] of Object.entries(BUILTIN_CAPABILITIES)) {
        if (!descriptor.environments.includes(environment)) continue;
        const bundled = await bundlePlugin(resolve(projectRoot, descriptor.entry));
        defaults[name] = { source: bundled.source, autoMount: descriptor.autoMount };
        for (const file of bundled.files) dependencies.add(file);
      }
      watchedFiles = [...dependencies];
      for (const file of watchedFiles) this.addWatchFile(file);
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
      vueTemplates(),
      pluginDefaults(extensionBuild ? 'extension' : 'standalone'),
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
