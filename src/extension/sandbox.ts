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
import { useBusOn, useToolGuard } from '@/kernel/bus';
import { usePromptSection } from '@/kernel/contrib';
import { UiContributionsHost } from '@/kernel/ui';
import { modules } from '@/kernel/modules';
import { startHarnessRuntime } from '@/kernel/runtime-supervisor';
import { cordisContextKey, runtime } from '@/kernel/cordis';
import { brokerFsPlugin } from './broker-fs';
import { brokerLlmPlugin } from './broker-llm';
import { modelProfilesPlugin } from './model-profiles';
import { guardPageAgentTool, PAGE_AGENT_BOUNDARY_PROMPT } from './agent-policy';
import { canSubmitPageMessage, takeAnnotationSubmission } from './annotation-context';
import { SandboxComposer } from './sandbox-composer';
import { createSandboxBroker } from './sandbox-broker';
import { useSandboxInspector } from './sandbox-inspector';
import appTemplate from './sandbox-app.html?raw';
import defaults from 'virtual:plugin-defaults';
import {
  type Annotation,
  type PageEvent,
  type PageSnapshot,
} from '@/shared/page-protocol';
import { MAX_MESSAGE_ANNOTATIONS, type TaskRuntimeService, type ToolCall } from '@/shared/runtime';
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
const broker = sandboxBroker.request;

const runtimeReady = ref(false);
const runtimeFailure = ref('');
const annotations = ref<Annotation[]>([]);
const REQUIRED_RUNTIME_SERVICES = ['fs', 'llm', 'modelProfiles', 'tools', 'prompt', 'loop', 'task'] as const;
let siteAuthorizedHandler: ((origin: string) => void) | null = null;
let workspaceChangedHandler: (() => void) | null = null;
let lastSnapshotSignature = '';
let lastSnapshotAt = 0;

window.addEventListener('message', event => {
  if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
  if (sandboxBroker.handleMessage(event.data)) return;
  const shellMessage = event.data as { channel?: unknown; type?: unknown; origin?: unknown };
  if (shellMessage.channel === 'harness-shell-v1' && shellMessage.type === 'workspace-changed') {
    workspaceChangedHandler?.();
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
    const fsService = useService('fs');
    const managerService = useService('manager');
    let workspaceRefreshTimer: number | null = null;
    const unsavedPagePatch = ref(false);
    const timelineView = useTimelineView(
      () => taskService.value?.messages ?? [],
      () => taskService.value?.activeTaskId.value,
    );
    const running = computed(() => loopService.value?.running.value === true);
    const busy = computed(() => actionBusy.value || running.value);
    const runtimeLabel = computed(() => runtimeFailure.value ? '异常' : runtimeReady.value ? '就绪' : '启动中');
    const inspectorState = useSandboxInspector(
      taskService, loopService, fsService, managerService, broker, pushError,
      () => parent.postMessage({ channel: 'harness-shell-v1', type: 'open-options' }, '*'),
    );
    usePromptSection({ name: 'extension-page-boundary', order: -100, text: PAGE_AGENT_BOUNDARY_PROMPT });
    usePromptSection({
      name: 'extension-page-persistence',
      order: -90,
      text: () => unsavedPagePatch.value
        ? 'The current host-page customization is still temporary. Let the user inspect and refine it across turns. End each refinement with one short question: continue adjusting, or if satisfied, install it as a page plugin? Call page_recipe_save only after explicit approval to persist.'
        : '',
    });
    useToolGuard(guardPageAgentTool);
    useBusOn('tools/post-execute', async (
      event: { name: string; result: string; args?: Record<string, unknown> },
      next: (value: { name: string; result: string; args?: Record<string, unknown> }) => unknown,
    ) => {
      const succeeded = !String(event.result).startsWith('Error:');
      if (event.name === 'page_patch_apply' && succeeded) unsavedPagePatch.value = true;
      if ((event.name === 'page_recipe_save' || event.name === 'page_patch_revert') && succeeded) unsavedPagePatch.value = false;
      return next(event);
    });
    useBusOn('page/event', (event: PageEvent) => { void inspectorState.recordPageArtifact(event); });

    async function snapshot(): Promise<void> {
      await run(async () => {
        const result = await broker({ provider: 'page', action: 'command', input: { command: { type: 'page/snapshot', options: { maxNodes: 400, maxDepth: 8 } } } });
        const pageResult = result as { ok?: boolean; value?: PageSnapshot; error?: string };
        if (!pageResult.ok || !pageResult.value) throw new Error(pageResult.error ?? 'Snapshot failed.');
        inspectorState.currentPageUrl.value = pageResult.value.scope.url;
        const nodeCount = countNodes(pageResult.value.nodes);
        const task = taskService.value;
        if (task) {
          await task.addContext({
            kind: 'page', title: pageResult.value.title || new URL(pageResult.value.scope.url).host,
            locator: pageResult.value.scope.url,
            metadata: { tabId: pageResult.value.scope.tabId, frameId: pageResult.value.scope.frameId, nodeCount, truncated: pageResult.value.truncated },
          });
          await task.appendEvent('context/read', { kind: 'page', url: pageResult.value.scope.url, nodeCount });
        }
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
        await broker({ provider: 'page', action: 'command', input: { command: { type: 'page/picker-start' } } });
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
      const task = taskService.value;
      const taskId = task?.activeTask()?.id;
      actionBusy.value = true;
      try {
        if (task && taskId) {
          if (task.activeTask()?.title === 'New task') await task.renameTask(task.activeTask()!.id, text.slice(0, 48));
          await task.setStatus(taskId, 'running');
          await task.appendEvent('task/run-started', { prompt: text });
        }
        await loop.run(text, { annotations: submittedAnnotations });
        if (task && taskId) settleTaskRun(task, taskId, 'idle', 'task/run-finished');
      } catch (error) {
        if (task && taskId) settleTaskRun(task, taskId, 'failed', 'task/run-failed');
        pushError(`发送失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        actionBusy.value = false;
      }
    }

    function settleTaskRun(task: TaskRuntimeService, taskId: string, status: 'idle' | 'failed', event: string): void {
      void task.setStatus(taskId, status)
        .then(() => task.activeTask()?.id === taskId ? task.appendEvent(event) : undefined)
        .catch(error => console.warn(`[harness] ${event} was not persisted`, error));
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

    const handleSiteAuthorized = (_origin: string): void => {
      void snapshot();
    };
    const handleWorkspaceChanged = (): void => {
      if (workspaceRefreshTimer != null) window.clearTimeout(workspaceRefreshTimer);
      workspaceRefreshTimer = window.setTimeout(() => {
        workspaceRefreshTimer = null;
        // `useService()` resolves through this component's trusted shell
        // Context. Reading the raw global service map here would call the
        // broker as Cordis <root> and correctly fail principal validation.
        void (async () => {
          await fsService.value?.refresh?.();
          if (loopService.value?.running.value) return;
          await taskService.value?.refresh();
        })().catch(error => pushError(`Workspace 刷新失败：${error instanceof Error ? error.message : String(error)}`));
      }, 100);
    };
    siteAuthorizedHandler = handleSiteAuthorized;
    workspaceChangedHandler = handleWorkspaceChanged;
    onUnmounted(() => {
      if (siteAuthorizedHandler === handleSiteAuthorized) siteAuthorizedHandler = null;
      if (workspaceChangedHandler === handleWorkspaceChanged) workspaceChangedHandler = null;
      if (workspaceRefreshTimer != null) window.clearTimeout(workspaceRefreshTimer);
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

const runtimeDefaults = Object.fromEntries(Object.entries(defaults)
  .filter(([name]) => !['chat', 'files', 'preview', 'settings', 'syslog'].includes(name)));

globalThis.__harness = Object.freeze({
  modules,
});

async function initializeRuntime(): Promise<void> {
  const taskScopeHost = await sandboxBroker.session;
  const runtime = startHarnessRuntime({
    defaults: runtimeDefaults,
    taskScope: taskScopeHost,
    infrastructure: [
      { name: 'broker', plugin: sandboxBroker.plugin },
      { name: 'workspace', plugin: brokerFsPlugin },
      { name: 'model-profiles', plugin: modelProfilesPlugin },
      { name: 'llm', plugin: brokerLlmPlugin },
    ],
    requiredServices: [...REQUIRED_RUNTIME_SERVICES],
  });
  const shellContext = await runtime.shellContext;
  await runtime.ready;
  if (missingRuntimeServices().length) throw new Error(describeMissingRuntimeServices());
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

function describeMissingRuntimeServices(): string {
  return `核心服务未挂载：${missingRuntimeServices().join('、')}`;
}

function missingRuntimeServices(): string[] {
  return REQUIRED_RUNTIME_SERVICES.filter(name => !runtime.reflect.get(name));
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

function countNodes(nodes: PageSnapshot['nodes']): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children ?? []), 0);
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
