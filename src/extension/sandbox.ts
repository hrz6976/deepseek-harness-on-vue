import * as Vue from 'vue';
import { computed, nextTick, onUnmounted, ref, watch, watchEffect } from 'vue';
import { services, provideService, useService } from '../kernel/services';
import { bus, useBusOn, useRequestTransform, useToolGuard } from '../kernel/bus';
import { log } from '../kernel/log';
import { AgentTool, PromptSection, useLayoutTarget, usePromptSection, useTool } from '../kernel/contrib';
import { PluginHost, mountPlugin, plugins, unmountPlugin } from '../kernel/host';
import { modules } from '../kernel/modules';
import { boot, PLUGIN_DIR } from '../kernel/boot';
import { brokerFsPlugin } from './broker-fs';
import { brokerLlmPlugin } from './broker-llm';
import { guardPageAgentTool, PAGE_AGENT_BOUNDARY_PROMPT } from './agent-policy';
import { attachAnnotationContext, canSubmitPageMessage, formatAnnotationContext, takeAnnotationSubmission } from './annotation-context';
import defaults from 'virtual:plugin-defaults';
import { createBrokerEnvelope } from '../shared/broker-schema';
import type {
  BrokerEnvelope,
  BrokerRequest,
  BrokerResponse,
  BrokerStreamChunk,
  Annotation,
  PageEvent,
  PageSnapshot,
  SiteRecipe,
} from '../shared/page-protocol';
import type { FsService, HarnessMessage, JsonValue, LlmRequest } from '../shared/runtime';
import './sandbox.css';

interface TimelineEntry {
  id: string;
  kind: 'user' | 'agent' | 'event' | 'error';
  text: string;
}

type DisplayBlock =
  | { id: string; type: 'message'; message: HarnessMessage; annotations?: readonly Annotation[] }
  | { id: string; type: 'timeline'; item: TimelineEntry };

let requestSequence = 0;
const pending = new Map<string, {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: number;
}>();
const pendingStreams = new Map<string, {
  queue: BrokerStreamChunk[];
  wake: (() => void) | null;
  timer: number;
}>();

function broker(payload: BrokerRequest): Promise<JsonValue> {
  const requestId = `sandbox_${Date.now()}_${++requestSequence}`;
  let envelope: BrokerEnvelope;
  try {
    envelope = createBrokerEnvelope(requestId, payload);
  } catch (error) {
    return Promise.reject(new Error(`Invalid broker request: ${error instanceof Error ? error.message : String(error)}`));
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Broker request timed out.'));
    }, 30_000);
    pending.set(requestId, { resolve, reject, timer });
    parent.postMessage(envelope, '*');
  });
}

async function* brokerStream(payload: BrokerRequest): AsyncIterable<JsonValue> {
  const requestId = `sandbox_stream_${Date.now()}_${++requestSequence}`;
  const envelope = createBrokerEnvelope(requestId, payload);
  const state = { queue: [] as BrokerStreamChunk[], wake: null as (() => void) | null, timer: 0 };
  const armTimeout = () => {
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.queue.push({ channel: 'harness-broker-v1', requestId, stream: true, done: true, error: 'Broker stream timed out.' });
      state.wake?.();
    }, 75_000);
  };
  pendingStreams.set(requestId, state);
  armTimeout();
  parent.postMessage(envelope, '*');
  try {
    while (true) {
      while (state.queue.length) {
        const chunk = state.queue.shift()!;
        if (chunk.error) throw new Error(chunk.error);
        if (chunk.value !== undefined) yield chunk.value;
        if (chunk.done) return;
      }
      await new Promise<void>(resolve => { state.wake = resolve; });
      state.wake = null;
      armTimeout();
    }
  } finally {
    window.clearTimeout(state.timer);
    pendingStreams.delete(requestId);
  }
}

const timeline = ref<TimelineEntry[]>([]);
const displayFeed = ref<DisplayBlock[]>([]);
const seenHarnessMessages = new WeakSet<object>();
const runtimeReady = ref(false);
const runtimeFailure = ref('');
const annotations = ref<Annotation[]>([]);
const REQUIRED_RUNTIME_SERVICES = ['fs', 'llm', 'tools', 'prompt', 'loop'] as const;
let siteAuthorizedHandler: ((origin: string) => void) | null = null;
let lastSnapshotSignature = '';
let lastSnapshotAt = 0;

window.addEventListener('message', event => {
  if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
  const shellMessage = event.data as { channel?: unknown; type?: unknown; origin?: unknown };
  if (shellMessage.channel === 'harness-shell-v1' && shellMessage.type === 'site-authorized-and-read' && typeof shellMessage.origin === 'string') {
    siteAuthorizedHandler?.(shellMessage.origin);
    return;
  }
  const message = event.data as { channel?: unknown; event?: PageEvent };
  if (message.channel === 'harness-page-event-v1' && message.event) {
    updateAnnotationContext(message.event);
    const text = summarizeEvent(message.event);
    if (text) appendTimeline('event', text);
    return;
  }
  const response = event.data as Partial<BrokerResponse>;
  if (response.channel !== 'harness-broker-v1' || typeof response.requestId !== 'string') return;
  const streamChunk = event.data as Partial<BrokerStreamChunk>;
  if (streamChunk.stream === true) {
    const stream = pendingStreams.get(response.requestId);
    if (stream) {
      stream.queue.push(streamChunk as BrokerStreamChunk);
      stream.wake?.();
    }
    return;
  }
  const waiter = pending.get(response.requestId);
  if (!waiter) return;
  pending.delete(response.requestId);
  window.clearTimeout(waiter.timer);
  if (response.ok) waiter.resolve(response.value ?? null);
  else waiter.reject(new Error(response.error ?? 'Broker request failed.'));
});

const App = {
  name: 'HarnessSandbox',
  setup() {
    const input = ref('');
    const actionBusy = ref(false);
    const loopService = useService('loop');
    const unsavedPagePatch = ref(false);
    const pagePluginsOpen = ref(false);
    const pagePluginsBusy = ref(false);
    const pagePlugins = ref<SiteRecipe[]>([]);
    const currentPageUrl = ref('');
    const submittedAnnotationContext = ref('');
    const pendingUserAnnotations = ref<readonly Annotation[]>([]);
    watchEffect(() => {
      for (const message of loopService.value?.messages ?? []) {
        if (seenHarnessMessages.has(message)) continue;
        seenHarnessMessages.add(message);
        const messageAnnotations = message.role === 'user' && pendingUserAnnotations.value.length
          ? pendingUserAnnotations.value
          : undefined;
        displayFeed.value.push({ id: crypto.randomUUID(), type: 'message', message, annotations: messageAnnotations });
        if (messageAnnotations) pendingUserAnnotations.value = [];
      }
    }, { flush: 'sync' });
    const displayBlocks = computed(() => displayFeed.value.filter(block =>
      block.type === 'timeline' || shouldDisplayMessage(block.message),
    ));
    const busy = computed(() => actionBusy.value || loopService.value?.running.value === true);
    const canSend = computed(() => canSubmitPageMessage(input.value, annotations.value));
    const runtimeLabel = computed(() => runtimeFailure.value ? '异常' : runtimeReady.value ? '就绪' : '启动中');
    provideService('broker', { request: broker, stream: brokerStream });
    usePromptSection({ name: 'extension-page-boundary', order: -100, text: PAGE_AGENT_BOUNDARY_PROMPT });
    useRequestTransform<LlmRequest>(request => attachAnnotationContext(request, submittedAnnotationContext.value));
    usePromptSection({
      name: 'extension-page-persistence',
      order: -90,
      text: () => unsavedPagePatch.value
        ? 'The current host-page customization is still temporary. Let the user inspect and refine it across turns. End each refinement with one short question: continue adjusting, or if satisfied, install it as a page plugin? Call page_recipe_save only after explicit approval to persist.'
        : '',
    });
    useToolGuard(guardPageAgentTool);
    useBusOn('tools/post-execute', async (
      event: { name: string; result: string },
      next: (value: { name: string; result: string }) => unknown,
    ) => {
      const succeeded = !String(event.result).startsWith('Error:');
      if (event.name === 'page_patch_apply' && succeeded) unsavedPagePatch.value = true;
      if ((event.name === 'page_recipe_save' || event.name === 'page_patch_revert') && succeeded) unsavedPagePatch.value = false;
      return next(event);
    });

    async function snapshot(): Promise<void> {
      await run(async () => {
        const result = await broker({ kind: 'page', command: { type: 'page/snapshot', options: { maxNodes: 400, maxDepth: 8 } } });
        const pageResult = result as { ok?: boolean; value?: PageSnapshot; error?: string };
        if (!pageResult.ok || !pageResult.value) throw new Error(pageResult.error ?? 'Snapshot failed.');
        currentPageUrl.value = pageResult.value.scope.url;
        const nodeCount = countNodes(pageResult.value.nodes);
        const signature = `${pageResult.value.scope.url}\n${pageResult.value.title}\n${nodeCount}`;
        const now = Date.now();
        if (signature === lastSnapshotSignature && now - lastSnapshotAt < 2_000) return null;
        lastSnapshotSignature = signature;
        lastSnapshotAt = now;
        return `已读取「${pageResult.value.title}」：${nodeCount} 个节点${pageResult.value.truncated ? '（已截断）' : ''}。`;
      });
    }

    async function picker(): Promise<void> {
      await run(async () => {
        await broker({ kind: 'page', command: { type: 'page/picker-start' } });
        return '元素选择器已开启；点击页面元素即可添加批注。';
      });
    }

    async function send(): Promise<void> {
      const text = input.value.trim();
      if (!canSubmitPageMessage(text, annotations.value) || busy.value) return;
      if (!runtimeReady.value) {
        pushError(runtimeFailure.value || 'Agent runtime 尚未就绪，请稍后重试。');
        return;
      }
      if (text === '/snapshot') return snapshot();
      if (text === '/picker') return picker();
      const loop = loopService.value;
      if (!loop) {
        const message = 'Agent loop 服务未挂载。请重新加载扩展；如果问题持续，请重置插件运行时。';
        runtimeReady.value = false;
        runtimeFailure.value = message;
        pushError(message);
        return;
      }
      input.value = '';
      const submittedAnnotations = takeAnnotationSubmission(annotations.value);
      pendingUserAnnotations.value = submittedAnnotations;
      submittedAnnotationContext.value = formatAnnotationContext(submittedAnnotations);
      try {
        await loop.run(text);
      } catch (error) {
        pushError(`发送失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        pendingUserAnnotations.value = [];
        submittedAnnotationContext.value = '';
      }
    }

    function openSettings(): void {
      parent.postMessage({ channel: 'harness-shell-v1', type: 'open-options' }, '*');
    }

    function clearAnnotations(): void {
      annotations.value.splice(0);
    }

    async function openPagePlugins(): Promise<void> {
      pagePluginsOpen.value = true;
      pagePluginsBusy.value = true;
      try {
        if (!currentPageUrl.value) {
          const result = await broker({ kind: 'page', command: { type: 'page/snapshot', options: { maxNodes: 1, maxDepth: 0 } } });
          const pageResult = result as { ok?: boolean; value?: PageSnapshot };
          if (pageResult.ok && pageResult.value) currentPageUrl.value = pageResult.value.scope.url;
        }
        await refreshPagePlugins();
      } catch (error) {
        pushError(error instanceof Error ? error.message : String(error));
      } finally {
        pagePluginsBusy.value = false;
      }
    }

    async function refreshPagePlugins(): Promise<void> {
      const result = await broker({ kind: 'recipe/list' });
      pagePlugins.value = Array.isArray(result) ? result as unknown as SiteRecipe[] : [];
    }

    const currentPagePlugins = computed(() => pagePlugins.value.filter(plugin =>
      !currentPageUrl.value || plugin.matches.some(pattern => matchesPagePattern(pattern, currentPageUrl.value)),
    ));

    const currentPageHost = computed(() => {
      try { return currentPageUrl.value ? new URL(currentPageUrl.value).host : '当前页面'; }
      catch { return '当前页面'; }
    });

    async function setPagePluginEnabled(plugin: SiteRecipe, enabled: boolean): Promise<void> {
      if (pagePluginsBusy.value) return;
      pagePluginsBusy.value = true;
      try {
        await broker({ kind: 'recipe/save', recipe: { ...plugin, enabled } });
        if (enabled) await broker({ kind: 'recipe/apply', id: plugin.id });
        await refreshPagePlugins();
      } catch (error) {
        pushError(error instanceof Error ? error.message : String(error));
      } finally {
        pagePluginsBusy.value = false;
      }
    }

    async function removePagePlugin(plugin: SiteRecipe): Promise<void> {
      if (pagePluginsBusy.value) return;
      pagePluginsBusy.value = true;
      try {
        await broker({ kind: 'recipe/remove', id: plugin.id });
        await refreshPagePlugins();
      } catch (error) {
        pushError(error instanceof Error ? error.message : String(error));
      } finally {
        pagePluginsBusy.value = false;
      }
    }

    async function run(action: () => Promise<string | null>): Promise<void> {
      if (actionBusy.value) return;
      actionBusy.value = true;
      try {
        const text = await action();
        if (text) appendTimeline('agent', text);
      } catch (error) {
        pushError(error instanceof Error ? error.message : String(error));
      } finally {
        actionBusy.value = false;
      }
    }

    const handleSiteAuthorized = (_origin: string): void => {
      void snapshot();
    };
    siteAuthorizedHandler = handleSiteAuthorized;
    onUnmounted(() => {
      if (siteAuthorizedHandler === handleSiteAuthorized) siteAuthorizedHandler = null;
    });

    return {
      input, displayBlocks, displayMessageText, busy, canSend, runtimeReady, runtimeFailure, runtimeLabel, plugins,
      annotations,
      pagePluginsOpen, pagePluginsBusy, currentPagePlugins, currentPageHost,
      snapshot, picker, send, clearAnnotations, openSettings, openPagePlugins, setPagePluginEnabled, removePagePlugin,
    };
  },
  template: `
    <main class="shell">
      <header class="app-header">
        <div class="brand">
          <strong>Harness</strong>
          <span class="runtime-status" :class="{ loading: !runtimeReady && !runtimeFailure, failed: runtimeFailure }" :title="runtimeFailure || '运行正常'"><i></i>{{ runtimeLabel }}</span>
        </div>
        <nav class="actions" aria-label="页面操作">
          <button class="action-button" @click="snapshot" :disabled="busy">读取</button>
          <button class="action-button" @click="picker" :disabled="busy">批注</button>
          <button class="action-button" @click="openPagePlugins">插件</button>
          <button class="action-button" @click="openSettings">设置</button>
        </nav>
      </header>
      <section class="timeline" aria-live="polite">
        <div v-if="displayBlocks.length === 0" class="empty">
          输入要求，或先读取当前页面。
        </div>
        <article v-for="block in displayBlocks" :key="block.id" :class="block.type === 'message' ? block.message.role : block.item.kind">
          <template v-if="block.type === 'message' && block.message.role === 'assistant'">
            {{ displayMessageText(block.message) }}
          </template>
          <template v-else-if="block.type === 'message'">
            <div v-if="displayMessageText(block.message)" class="message-text">{{ displayMessageText(block.message) }}</div>
            <div v-if="block.message.role === 'user' && block.annotations?.length" class="message-annotations" aria-label="随消息发送的页面批注">
              <section v-for="annotation in block.annotations" :key="annotation.id" class="message-annotation">
                <span class="message-annotation-label">批注</span>
                <p>{{ annotation.text }}</p>
                <code>{{ annotation.target.selector }}</code>
              </section>
            </div>
          </template>
          <template v-else>{{ block.item.text }}</template>
        </article>
      </section>
      <form class="composer" @submit.prevent="send">
        <div class="composer-field">
          <div v-if="annotations.length" class="annotation-context">
            <span>{{ annotations.length }} 个批注</span>
            <button type="button" @click="clearAnnotations">清除</button>
          </div>
          <textarea v-model="input" rows="3" placeholder="询问或修改当前页面" @keydown.ctrl.enter.prevent="send"></textarea>
          <div class="composer-footer">
            <button class="send-button" type="button" :disabled="busy || !runtimeReady || !canSend" @click="send">{{ !runtimeReady ? '初始化中' : busy ? '处理中' : '发送' }}</button>
          </div>
        </div>
      </form>
      <aside v-if="pagePluginsOpen" class="page-plugins" aria-label="页面插件">
        <header>
          <div><h2>页面插件</h2><p>{{ currentPageHost }}</p></div>
          <button type="button" @click="pagePluginsOpen = false">完成</button>
        </header>
        <div class="page-plugins-list">
          <p v-if="pagePluginsBusy && currentPagePlugins.length === 0" class="page-plugins-empty">正在读取…</p>
          <p v-else-if="currentPagePlugins.length === 0" class="page-plugins-empty">当前页面还没有插件。</p>
          <article v-for="plugin in currentPagePlugins" :key="plugin.id" class="page-plugin-item">
            <div class="page-plugin-copy">
              <strong>{{ plugin.name }}</strong>
              <span>{{ plugin.enabled ? '已启用' : '已停用' }} · {{ plugin.matches.join(', ') }}</span>
            </div>
            <label class="page-plugin-toggle">
              <input type="checkbox" :checked="plugin.enabled" :disabled="pagePluginsBusy" @change="setPagePluginEnabled(plugin, $event.target.checked)" />
              <span>启用</span>
            </label>
            <button class="page-plugin-remove" type="button" :disabled="pagePluginsBusy" @click="removePagePlugin(plugin)">移除</button>
          </article>
        </div>
        <p class="page-plugins-hint">停用或移除后，刷新页面即可清除当前已应用的效果。</p>
      </aside>
      <div class="runtime-host" aria-hidden="true">
        <PluginHost v-for="plugin in plugins" :key="plugin.name + ':' + plugin.version" :plugin="plugin" />
      </div>
    </main>
  `,
};

const runtimeDefaults = Object.fromEntries(Object.entries(defaults).filter(([name]) => ![
  'chat', 'files', 'preview', 'settings', 'syslog',
].includes(name)));

globalThis.__harness = Object.freeze({
  Vue,
  services,
  bus,
  log,
  modules,
  useService,
  useBusOn,
  useToolGuard,
  useRequestTransform,
  useTool,
  usePromptSection,
  useLayoutTarget,
  mountPlugin,
  unmountPlugin,
});

mountPlugin('fs', brokerFsPlugin, { builtin: true });
mountPlugin('llm', brokerLlmPlugin, { builtin: true });
const app = Vue.createApp(App);
app.component('PluginHost', PluginHost);
app.component('AgentTool', AgentTool);
app.component('PromptSection', PromptSection);
app.provide('services', services);
app.provide('bus', bus);
app.provide('log', log);
app.mount('#app');
parent.postMessage({ channel: 'harness-shell-v1', type: 'ready' }, '*');
void boot(runtimeDefaults).then(
  async () => {
    await waitForRuntimeServices();
    runtimeReady.value = true;
  },
  error => {
    reportBootFailure(error);
  },
).catch(reportBootFailure);

function pushError(text: string): void {
  appendTimeline('error', text);
}

function appendTimeline(kind: TimelineEntry['kind'], text: string): void {
  const item: TimelineEntry = { id: crypto.randomUUID(), kind, text };
  timeline.value.push(item);
  displayFeed.value.push({ id: item.id, type: 'timeline', item });
}

function shouldDisplayMessage(message: HarnessMessage): boolean {
  if (message.role !== 'assistant') return true;
  if (message.toolCalls.length) return false;
  return Boolean(message.text) || message.status === 'streaming';
}

function displayMessageText(message: HarnessMessage): string {
  if (message.role === 'assistant') return message.text || (message.status === 'streaming' ? '…' : '');
  if (message.role === 'note' && message.text.startsWith('LLM call failed:')) {
    return `请求失败：${message.text.slice('LLM call failed:'.length).trim()}`;
  }
  return message.text;
}

function reportBootFailure(error: unknown): void {
  runtimeReady.value = false;
  runtimeFailure.value = error instanceof Error ? error.message : String(error);
  pushError(`Agent runtime 初始化失败：${runtimeFailure.value}`);
}

async function waitForRuntimeServices(timeoutMs = 5_000): Promise<void> {
  await nextTick();
  if (missingRuntimeServices().length === 0) return;

  await new Promise<void>((resolve, reject) => {
    const stop = watch(runtimeServiceSignature, () => {
      if (missingRuntimeServices().length !== 0) return;
      window.clearTimeout(timer);
      stop();
      resolve();
    });
    const timer = window.setTimeout(() => {
      stop();
      reject(new Error(describeMissingRuntimeServices()));
    }, timeoutMs);
  });
}

function describeMissingRuntimeServices(): string {
  const fs = services.get('fs')?.value as FsService | undefined;
  const details = missingRuntimeServices().map(name => {
    const plugin = plugins.find(entry => entry.name === name);
    const stored = fs?.read(`${PLUGIN_DIR}${name}.js`);
    const shipped = runtimeDefaults[name]?.source;
    const sourceState = stored == null || shipped == null
      ? '无可比对源码'
      : stored === shipped ? '源码与当前构建一致' : 'OPFS 源码不同于当前构建';
    const error = plugin?.error ? `，挂载错误：${plugin.error}` : plugin ? `，插件状态：${plugin.status}` : '，插件条目不存在';
    return `${name}（${sourceState}${error}）`;
  });
  return `核心服务未挂载：${details.join('；')}`;
}

function runtimeServiceSignature(): string {
  return REQUIRED_RUNTIME_SERVICES
    .map(name => `${name}:${services.get(name)?.value ? '1' : '0'}`)
    .join('|');
}

function missingRuntimeServices(): string[] {
  return REQUIRED_RUNTIME_SERVICES.filter(name => !services.get(name)?.value);
}

function summarizeEvent(event: PageEvent): string | null {
  switch (event.type) {
    case 'page/connected':
    case 'page/ready':
    case 'page/mutation': return null;
    case 'page/route-changed': return `页面路由变化：${event.scope.url}`;
    case 'page/element-selected': return null;
    case 'annotation/created': return `批注：${event.annotation.text}`;
    case 'patch/applied': return `补丁「${event.transaction.label}」已应用。`;
    case 'patch/reverted': return `补丁「${event.transaction.label}」已撤销。`;
    case 'patch/verification-failed': return `补丁「${event.transaction.label}」验证失败。`;
    case 'recipe/installed': return `页面插件「${event.recipe.name}」已${event.recipe.enabled ? '启用' : '停用'}。`;
    case 'recipe/disposed': return '页面插件已移除。';
  }
}

function updateAnnotationContext(event: PageEvent): void {
  if (event.type === 'page/connected' || event.type === 'page/route-changed') {
    annotations.value.splice(0);
    return;
  }
  if (event.type !== 'annotation/created') return;
  const index = annotations.value.findIndex(annotation => annotation.id === event.annotation.id);
  if (index >= 0) annotations.value.splice(index, 1, event.annotation);
  else annotations.value.push(event.annotation);
}

function countNodes(nodes: PageSnapshot['nodes']): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children ?? []), 0);
}

function matchesPagePattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return /^https?:/u.test(url);
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  try { return new RegExp(`^${expression}$`, 'u').test(url); }
  catch { return false; }
}
