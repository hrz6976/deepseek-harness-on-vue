// Build: esbuild, ESM output (the runtime hinges on import(blobURL); IIFE is
// only relevant to the Phase-2 single-file userscript). Usage:
//   node build.mjs            one-shot build to dist/
//   node build.mjs --watch    rebuild on change
//   node build.mjs --watch --serve   + dev server with /proxy
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');

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
  plugins: [copyHtml],
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  if (serve) await import('./serve.mjs');
} else {
  await esbuild.build(options);
}
