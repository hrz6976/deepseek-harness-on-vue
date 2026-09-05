import * as Vue from 'vue';
import { computed, onUnmounted, ref } from 'vue';
import {
  NButton,
  NCollapse,
  NCollapseItem,
  NConfigProvider,
  NDrawer,
  NDrawerContent,
  NDropdown,
  NEmpty,
  NIcon,
  NPopconfirm,
  NSwitch,
  NTag,
  NTooltip,
  type GlobalThemeOverrides,
} from 'naive-ui';
import {
  Activity,
  ArrowDown,
  Box,
  Dots,
  FileText,
  LayersSubtract,
  Paperclip,
  Tool,
  Trash,
  World,
} from '@vicons/tabler';
import { useService } from '@/kernel/services';
import { UiContributionsHost } from '@/kernel/ui';
import { modules } from '@/kernel/modules';
import { startHarnessRuntime } from '@/kernel/runtime-supervisor';
import { cordisContextKey, runtime } from '@/kernel/cordis';
import brokerFsPlugin from './broker-fs';
import brokerLlmPlugin from './broker-llm';
import modelProfilesPlugin from './model-profiles';
import pagePolicyPlugin from './page-policy';
import { canSubmitPageMessage, takeAnnotationSubmission } from './annotation-context';
import { SandboxComposer } from './sandbox-composer';
import { createSandboxBroker } from './sandbox-broker';
import { useSandboxInspector } from './sandbox-inspector';
import appTemplate from './sandbox-app.html?raw';
import defaults from 'virtual:plugin-defaults';
import {
  type Annotation,
  type PageEvent,
} from '@/shared/page-protocol';
import { MAX_MESSAGE_ANNOTATIONS, type ToolCall } from '@/shared/runtime';
import type { TaskContext } from '@/shared/task-model';
import { appendTimeline, displayMessageText, useTimelineView } from './sandbox-timeline';
import { renderMarkdown } from '@/shared/markdown';
import './sandbox.css';

const uiTheme: GlobalThemeOverrides = {
  common: {
    primaryColor: '#315ee7',
    primaryColorHover: '#244fd4',
    primaryColorPressed: '#1d43bb',
    primaryColorSuppl: '#315ee7',
    borderRadius: '10px',
    fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
  },
};

const appMenuOptions = [
  { label: '任务管理', key: 'tasks' },
  { label: '扩展设置', key: 'settings' },
];

const sandboxBroker = createSandboxBroker(parent);

const runtimeReady = ref(false);
const runtimeFailure = ref('');
const annotations = ref<Annotation[]>([]);
let siteAuthorizedHandler: ((origin: string) => void) | null = null;
let lastSnapshotSignature = '';
let lastSnapshotAt = 0;

window.addEventListener('message', event => {
  if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
  if (sandboxBroker.handleMessage(event.data)) return;
  const shellMessage = event.data as { channel?: unknown; type?: unknown; origin?: unknown };
  if (shellMessage.channel === 'harness-shell-v1' && shellMessage.type === 'workspace-changed') {
    runtime.emit('workspace/invalidated');
    return;
  }
  if (shellMessage.channel === 'harness-shell-v1' && shellMessage.type === 'site-authorized-and-read' && typeof shellMessage.origin === 'string') {
    siteAuthorizedHandler?.(shellMessage.origin);
    return;
  }
  const message = event.data as { channel?: unknown; event?: PageEvent };
  if (message.channel === 'harness-page-event-v1' && message.event) {
    if (!updateAnnotationContext(message.event)) return;
    runtime.emit('page/event', message.event);
    const text = summarizeEvent(message.event);
    if (text) appendTimeline('event', text);
    return;
  }
});

const App = {
  name: 'HarnessSandbox',
  components: {
    NButton, NCollapse, NCollapseItem, NConfigProvider, NDrawer, NDrawerContent,
    NDropdown, NEmpty, NIcon, NPopconfirm, NSwitch, NTag, NTooltip, SandboxComposer,
    Activity, ArrowDown, Box, Dots, FileText, LayersSubtract, Paperclip,
    Tool, Trash, World,
  },
  setup() {
    const actionBusy = ref(false);
    const loopService = useService('loop');
    const taskService = useService('task');
    const pageSession = useService('pageSession');
    const timelineView = useTimelineView(
      () => taskService.value?.messages ?? [],
      () => taskService.value?.activeTaskId.value,
    );
    const running = computed(() => loopService.value?.running.value === true);
    const busy = computed(() => actionBusy.value || running.value);
    const runtimeLabel = computed(() => runtimeFailure.value ? '异常' : runtimeReady.value ? '就绪' : '启动中');
    const inspectorState = useSandboxInspector(
      pushError,
      () => parent.postMessage({ channel: 'harness-shell-v1', type: 'open-options' }, '*'),
    );
    async function snapshot(): Promise<void> {
      await run(async () => {
        const { page, nodeCount } = await pageSession.value!.snapshot();
        inspectorState.currentPageUrl.value = page.scope.url;
        const signature = `${page.scope.url}\n${page.title}\n${nodeCount}`;
        const now = Date.now();
        if (signature === lastSnapshotSignature && now - lastSnapshotAt < 2_000) return null;
        lastSnapshotSignature = signature;
        lastSnapshotAt = now;
        return `已读取「${page.title}」：${nodeCount} 个节点${page.truncated ? '（已截断）' : ''}。`;
      });
    }

    async function picker(): Promise<void> {
      await run(async () => {
        await pageSession.value!.startPicker();
        return '元素选择器已开启；点击页面元素即可添加批注。';
      });
    }

    async function send(submittedText: string): Promise<void> {
      const text = submittedText.trim();
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
      const submittedAnnotations = takeAnnotationSubmission(annotations.value);
      timelineView.resumeTimelineFollow();
      actionBusy.value = true;
      try {
        await loop.run(text, { annotations: submittedAnnotations });
      } catch (error) {
        pushError(`发送失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        actionBusy.value = false;
      }
    }

    function stop(): void {
      loopService.value?.stop();
    }

    function clearAnnotations(): void {
      annotations.value.splice(0);
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

    const handleSiteAuthorized = () => { void snapshot(); };
    siteAuthorizedHandler = handleSiteAuthorized;
    onUnmounted(() => {
      if (siteAuthorizedHandler === handleSiteAuthorized) siteAuthorizedHandler = null;
    });

    return {
      ...timelineView, ...inspectorState,
      displayMessageText, renderMarkdown, busy, running, runtimeReady, runtimeFailure, runtimeLabel,
      annotations, taskService,
      uiTheme, appMenuOptions,
      snapshot, picker, send, stop, clearAnnotations,
      contextKindLabel, formatToolArguments, toolStatusLabel, toolStatusType,
    };
  },
  template: appTemplate,
};

globalThis.__harness = Object.freeze({
  modules,
});

async function initializeRuntime(): Promise<void> {
  const taskScopeHost = await sandboxBroker.session;
  const runtime = startHarnessRuntime({
    defaults,
    taskScope: taskScopeHost,
    infrastructure: [
      sandboxBroker.plugin,
      brokerFsPlugin,
      modelProfilesPlugin,
      brokerLlmPlugin,
      pagePolicyPlugin,
    ],
    requiredServices: ['llm', 'modelProfiles'],
  });
  const shellContext = await runtime.shellContext;
  await runtime.ready;
  const app = Vue.createApp(App);
  app.component('UiContributionsHost', UiContributionsHost);
  app.provide(cordisContextKey, shellContext);
  app.mount('#app');
  runtimeReady.value = true;
  parent.postMessage({ channel: 'harness-shell-v1', type: 'ready' }, '*');
}

void initializeRuntime().catch(reportBootFailure);

function pushError(text: string): void {
  appendTimeline('error', text);
}

function reportBootFailure(error: unknown): void {
  runtimeReady.value = false;
  runtimeFailure.value = error instanceof Error ? error.message : String(error);
  console.error('[harness] sandbox startup failed', error);
  pushError(`Agent runtime 初始化失败：${runtimeFailure.value}`);
  parent.postMessage({
    channel: 'harness-shell-v1',
    type: 'boot-error',
    error: runtimeFailure.value,
  }, '*');
}

function summarizeEvent(event: PageEvent): string | null {
  switch (event.type) {
    case 'page/connected':
    case 'page/ready':
    case 'page/mutation': return null;
    case 'page/route-changed': return `页面路由变化：${event.scope.url}`;
    case 'page/element-selected': return null;
    case 'annotation/created': return event.annotation.text ? `批注：${event.annotation.text}` : '已添加批注目标。';
    case 'patch/applied': return `补丁「${event.transaction.label}」已应用。`;
    case 'patch/reverted': return `补丁「${event.transaction.label}」已撤销。`;
    case 'patch/verification-failed': return `补丁「${event.transaction.label}」验证失败。`;
    case 'recipe/installed': return `页面插件「${event.recipe.name}」已${event.recipe.enabled ? '启用' : '停用'}。`;
    case 'recipe/disposed': return '页面插件已移除。';
  }
}

function updateAnnotationContext(event: PageEvent): boolean {
  if (event.type === 'page/connected' || event.type === 'page/route-changed') {
    annotations.value.splice(0);
    return true;
  }
  if (event.type !== 'annotation/created') return true;
  const index = annotations.value.findIndex(annotation => annotation.id === event.annotation.id);
  if (index >= 0) annotations.value.splice(index, 1, event.annotation);
  else if (annotations.value.length < MAX_MESSAGE_ANNOTATIONS) annotations.value.push(event.annotation);
  else {
    pushError(`每条消息最多附带 ${MAX_MESSAGE_ANNOTATIONS} 个批注；请先发送或清除现有批注。`);
    return false;
  }
  return true;
}

const CONTEXT_KIND_LABELS: Record<TaskContext['kind'], string> = {
  page: '网页', file: '文件', selection: '选区', mcp: 'MCP',
};
const contextKindLabel = (kind: TaskContext['kind']): string => CONTEXT_KIND_LABELS[kind];

function formatToolArguments(call: ToolCall): string {
  const source = call.args || JSON.stringify(call.argsObj ?? {});
  try { return JSON.stringify(JSON.parse(source), null, 2); }
  catch { return source || '{}'; }
}

function toolStatusLabel(call: ToolCall): string {
  if (call.status === 'running') return '执行中';
  if (call.status === 'done') return call.result?.startsWith('Error:') ? '失败' : '完成';
  return '等待';
}

function toolStatusType(call: ToolCall): 'default' | 'info' | 'success' | 'warning' | 'error' {
  if (call.status === 'running') return 'info';
  if (call.status === 'done') return call.result?.startsWith('Error:') ? 'error' : 'success';
  return 'default';
}
