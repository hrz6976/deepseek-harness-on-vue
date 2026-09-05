import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as schema from '@/shared/broker-schema';
import * as policy from '@/shared/capability-policy';
import * as pluginPolicy from '@/kernel/plugin-policy';
import { RequestLifecycle } from '@/shared/request-lifecycle';
import { CapabilityGrants } from '@/extension/capability-grants';
import { TrustedCapabilityHost } from '@/extension/capability-host';
import { approvalForRequest } from '@/extension/approval-policy';

test('trusted sidepanel never forwards a request approved after cancellation', async () => {
  // Execute the real entry with browser/UI boundaries stubbed; the production
  // schema, authority resolution, approval dispatch and cancellation remain intact.
  const listeners = new Map<string, Function>();
  const replies: any[] = [];
  const forwarded: any[] = [];
  const frame = { postMessage: (value: unknown) => replies.push(value) };
  let approve!: (value: boolean) => void;
  let receive!: (value: unknown) => void;
  let asked = 0;
  const view = {
    frame: { contentWindow: frame }, setBinding() {}, setSiteAccess() {}, setFailure() {}, setReady() {},
    requestApproval: () => { asked++; return new Promise<boolean>(resolve => { approve = resolve; }); },
  };
  const port = { postMessage: (value: unknown) => forwarded.push(value),
    onMessage: { addListener(fn: typeof receive) { receive = fn; } }, onDisconnect: { addListener() {} } };
  const modules: Record<string, unknown> = {
    '@/kernel/runtime-lease': { acquireRuntimeLease: async () => () => {} },
    '@/shared/request-lifecycle': { RequestLifecycle },
    './capability-grants': { CapabilityGrants },
    '@/shared/broker-schema': schema, '@/shared/capability-policy': policy,
    './approval-policy': { approvalForRequest }, './capability-host': { TrustedCapabilityHost },
    '@/kernel/plugin-policy': pluginPolicy,
    '@/kernel/opfs-store': { OpfsStore: class { onChange() {} } },
    './tab-scope': { isInspectableUrl: () => true, parseSidePanelTabId: () => 1, sidePanelPortName: () => 'panel:1' },
    './sidepanel-ui': { mountSidePanelUi: () => view }, './sidepanel.css': {},
  };
  const source = await readFile(new URL('../src/extension/sidepanel.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = {
    require: (id: string) => { assert.ok(id in modules, id); return modules[id]; }, exports: {},
    console, crypto, URL, setTimeout, clearTimeout, AbortController,
    window: { addEventListener: (type: string, fn: Function) => listeners.set(type, fn), location: { reload() {} } },
    location: { href: 'chrome-extension://test/sidepanel.html?tabId=1' },
    chrome: {
      tabs: { get: async () => ({ id: 1, url: 'https://example.test/' }), onUpdated: { addListener() {} } },
      permissions: { contains: async () => false },
      runtime: { connect: () => port },
      storage: { local: { get: async () => ({}) } },
    },
  };
  await vm.runInNewContext(`(async () => { ${code} })()`, context);
  const send = (data: unknown) => listeners.get('message')!({ source: frame, data });
  send({ channel: 'harness-shell-v1', type: 'broker-session-hello' });
  const session = replies.find(value => value.type === 'broker-session').token;
  const principal = { kind: 'capability' as const, id: 'page', fiberId: 'page:1', scope: 'global' as const, providers: ['page' as const], permissions: ['page.interact'] };
  const payload = { provider: 'page' as const, action: 'command' as const, input: { command: { type: 'page/click' as const, target: {
    nodeRef: 'node', selector: '#button', fingerprint: { tag: 'button', classes: [], attributes: {} },
  } } } };
  send(schema.createCapabilityEnvelope(session, 'cancelled', principal, payload));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(asked, 1);
  send({ channel: 'harness-broker-v1', session, requestId: 'cancelled', cancel: true });
  approve(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(forwarded.some(value => value.requestId === 'cancelled' && value.payload), false);
  send(schema.createCapabilityEnvelope(session, 'allowed', principal, payload));
  await new Promise(resolve => setTimeout(resolve, 0));
  approve(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(forwarded.some(value => value.requestId === 'allowed' && value.payload), true);
  receive({ channel: 'harness-broker-v1', requestId: 'allowed', ok: true, value: null });
});
