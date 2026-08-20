// Build: esbuild, ESM output (the runtime hinges on import(blobURL); IIFE is
// only relevant to the Phase-2 single-file userscript). Usage:
//   node build.mjs            one-shot build to dist/
//   node build.mjs --watch    rebuild on change
//   node build.mjs --watch --serve   + dev server with /proxy
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');

// virtual:plugin-defaults — every plugin SOURCE embedded as a string:
//   { [name]: { source, autoMount? } }
// The kernel seeds these into OPFS .plugins/ (write-if-missing) and loads
// plugins from there through the runtime compiler; the bundle carries no
// static plugin imports (fs.js excepted — the bootstrap dependency cannot
// load itself from the filesystem it provides). Name = filename minus .js.
// NOTE: because seeding is write-if-missing, repo-side edits to these files
// reach a browser with existing OPFS state only via ?reset.
const ON_DEMAND = new Set(['llm']); // mounted by settings with config, not at boot
const PLUGIN_ROOTS = ['src/plugins', 'src/plugins/tools', 'src/plugins/ui'];
const pluginDefaults = {
  name: 'plugin-defaults',
  setup(build) {
    build.onResolve({ filter: /^virtual:plugin-defaults$/ }, args => ({ path: args.path, namespace: 'plugin-defaults' }));
    build.onLoad({ filter: /.*/, namespace: 'plugin-defaults' }, () => {
      const files = PLUGIN_ROOTS.flatMap(dir =>
        readdirSync(dir, { withFileTypes: true })
          .filter(e => e.isFile() && e.name.endsWith('.js') && e.name !== 'fs.js')
          .map(e => join(dir, e.name)));
      const map = {};
      for (const f of files) {
        const name = basename(f, '.js');
        if (map[name]) throw new Error(`duplicate plugin name "${name}" (${f})`);
        map[name] = { source: readFileSync(f, 'utf8'), ...(ON_DEMAND.has(name) ? { autoMount: false } : {}) };
      }
      return { contents: `export default ${JSON.stringify(map)};`, loader: 'js', watchFiles: files, watchDirs: PLUGIN_ROOTS };
    });
  },
};

const copyHtml = {
  name: 'copy-html',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length) return;
      mkdirSync('dist', { recursive: true });
      copyFileSync('src/entries/standalone/index.html', 'dist/index.html');
      console.log(`[build] dist/ updated (${new Date().toLocaleTimeString()})`);
    });
  },
};

const options = {
  entryPoints: ['src/entries/standalone/main.js'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  sourcemap: true,
  // Runtime template compiler required: plugin `template` strings (both
  // built-in and agent-written) compile in the browser. Bare 'vue' resolves
  // to the runtime-only build, which cannot do that.
  alias: { vue: 'vue/dist/vue.esm-bundler.js' },
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  plugins: [pluginDefaults, copyHtml],
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  if (serve) await import('./serve.mjs');
} else {
  await esbuild.build(options);
}
