import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const examplesRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: examplesRoot,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 0,
  },
  resolve: {
    alias: {
      '@': resolve(examplesRoot, '../src'),
    },
  },
  build: {
    outDir: resolve(examplesRoot, '../dist/fixtures'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        legacy: resolve(examplesRoot, 'legacy-host/index.html'),
        react: resolve(examplesRoot, 'react-host/index.html'),
      },
    },
  },
});
