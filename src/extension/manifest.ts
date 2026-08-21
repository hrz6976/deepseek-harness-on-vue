import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Harness Page Agent',
  description: 'Talk to an agent that can inspect, annotate, and transactionally modify the current page.',
  version: '0.1.0',
  minimum_chrome_version: '135',
  action: {
    default_title: 'Open Harness Page Agent',
  },
  background: {
    service_worker: 'src/extension/service-worker.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'src/extension/sidepanel.html',
  },
  options_page: 'src/extension/options.html',
  permissions: [
    'activeTab',
    'scripting',
    'sidePanel',
    'storage',
    'tabs',
    'userScripts',
  ],
  optional_host_permissions: [
    'http://*/*',
    'https://*/*',
  ],
  host_permissions: ['https://api.deepseek.com/*'],
  sandbox: {
    pages: ['src/extension/sandbox.html'],
  },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
    // Agent-authored plugins can execute in this opaque-origin frame, but all
    // I/O is forced through the validated parent broker. In particular, a
    // plugin cannot bypass it with fetch/WebSocket/sendBeacon.
    sandbox: "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'",
  },
});
