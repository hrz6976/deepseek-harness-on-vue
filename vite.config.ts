import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crx } from '@crxjs/vite-plugin';
import { defineConfig, transformWithOxc, type Plugin } from 'vite';
import manifest from './src/extension/manifest.ts';

const projectRoot = dirname(fileURLToPath(import.meta.url));
// This manifest is declared as a static object. CRXJS exposes a wider return
// union because defineManifest also accepts async factories.
const extensionManifest = manifest as Extract<typeof manifest, { manifest_version: number }>;
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
            .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && entry.name !== 'fs.ts')
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

/**
 * Vite 8 generates a random HMR websocket token on every server start. Chrome
 * caches the CRXJS client-worker, so each restart served a token the running
 * extension didn't know → WS handshake 400 until a manual extension reload.
 * configResolved runs before the WS server validates tokens and before client
 * transforms, so pinning here makes the token stable across restarts.
 */
function pinWebSocketToken(): Plugin {
  return {
    name: 'harness-pin-ws-token',
    apply: 'serve',
    configResolved(config) {
      (config as { webSocketToken: string }).webSocketToken = 'harness-dev-ws-token';
    },
  };
}

/**
 * CRXJS 2.7.1 bug: its worker HMR client contains __LIVE_RELOAD__ twice, but
 * the token replacement uses String.replace (string pattern → first occurrence
 * only), so the socket-close handler keeps the literal and throws
 * ReferenceError whenever the HMR socket closes (server restart, sleep).
 * Serve-time fixup until upstream fixes it.
 */
function crxLiveReloadFixup(): Plugin {
  return {
    name: 'harness-crx-live-reload-fixup',
    apply: 'serve',
    transform(code, id) {
      if (id.includes('@crx/client-worker') && code.includes('__LIVE_RELOAD__')) {
        return code.replaceAll('__LIVE_RELOAD__', 'true');
      }
    },
  };
}

export default defineConfig(({ mode, command }) => {
  // The extension is the default target. Standalone mode must be requested
  // explicitly by the web dev/build scripts.
  const extensionBuild = mode !== 'standalone';
  // CRXJS never patches manifest CSPs, and our production sandbox CSP
  // (script-src 'self'; connect-src 'none') forbids everything dev mode
  // needs: fetching the real page + modules from the dev server and the
  // HMR websocket. Relax BOTH CSPs to include the dev origin — serve only;
  // production builds keep the hardened CSP below unchanged.
  // NOTE: Chrome rejects ws:// sources inside script-src ("insecure CSP value");
  // websockets are governed by connect-src, which already carries them.
  const devCspOrigin = 'http://localhost:5173';
  const devCspConnect = 'http://localhost:5173 ws://localhost:5173';
  const activeManifest = extensionBuild && command === 'serve'
    ? {
        ...extensionManifest,
        content_security_policy: {
          extension_pages: extensionManifest.content_security_policy!.extension_pages!.replace(
            "script-src 'self'", `script-src 'self' ${devCspOrigin}`),
          sandbox: extensionManifest.content_security_policy!.sandbox!
            .replace("script-src 'self'", `script-src 'self' ${devCspOrigin}`)
            .replace("connect-src 'none'", `connect-src ${devCspConnect}`),
        },
      }
    : extensionManifest;
  return {
    // Bind ALL interfaces: Vite's default "localhost" can land on ::1 only,
    // and Chrome resolving localhost via 127.0.0.1 then gets intermittent
    // connection failures / proxy-style 504s on extension script fetches.
    server: {
      host: true,
      port: extensionBuild ? 5173 : 4000,
      // The extension CSP names its dev origin, so silently choosing another
      // port would produce a server that Chrome cannot load.
      strictPort: true,
    },
    plugins: [
      pluginDefaults(),
      crxLiveReloadFixup(),
      pinWebSocketToken(),
      ...(extensionBuild ? [crx({ manifest: activeManifest })] : []),
    ],
    resolve: {
      alias: {
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
      ...(!extensionBuild ? {
        rollupOptions: {
          input: {
            standalone: resolve(projectRoot, 'index.html'),
          },
        },
      } : {}),
    },
  };
});
