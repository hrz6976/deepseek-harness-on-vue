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
  NPopover,
  NPopconfirm,
  NSelect,
  NSwitch,
  NTag,
  NTooltip,
  type GlobalThemeOverrides,
} from 'naive-ui';
import {
  Activity,
  ArrowDown,
  Box,
  ChevronDown,
  Dots,
  FileText,
  LayersSubtract,
  Paperclip,
  Tool,
  Trash,
  World,
} from '@vicons/tabler';
import { useService } from '@/kernel/services';
import { useBusOn, useRequestTransform, useToolGuard } from '@/kernel/bus';
import { usePromptSection } from '@/kernel/contrib';
import { UiContributionsHost } from '@/kernel/ui';
import { capabilities } from '@/kernel/capabilities';
import { modules } from '@/kernel/modules';
import { PLUGIN_DIR } from '@/kernel/capability-package';
import { startHarnessRuntime } from '@/kernel/runtime-supervisor';
import { cordisContextKey, runtime } from '@/kernel/cordis';
import { brokerFsPlugin } from './broker-fs';
import { brokerLlmPlugin } from './broker-llm';
import { guardPageAgentTool, PAGE_AGENT_BOUNDARY_PROMPT } from './agent-policy';
import { attachAnnotationContext, canSubmitPageMessage, formatAnnotationContext, takeAnnotationSubmission } from './annotation-context';
import { SandboxComposer } from './sandbox-composer';
import { createSandboxBroker } from './sandbox-broker';
import { useSandboxInspector } from './sandbox-inspector';
import appTemplate from './sandbox-app.html?raw';
import harnessMarkUrl from './assets/harness-mark.svg';
import defaults from 'virtual:plugin-defaults';
import {
  type Annotation,
  type PageEvent,
  type PageSnapshot,
} from '@/shared/page-protocol';
import type { FsService, LlmRequest, ToolCall } from '@/shared/runtime';
import type { TaskContext } from '@/shared/task-model';
import { DEFAULT_SESSION_LLM_CONFIG, normalizeSessionLlmConfig, type ReasoningEffort } from '@/shared/task-model';
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

const sessionModelOptions = [
  { label: 'DeepSeek V4 Flash', value: 'deepseek-v4-flash' },
  { label: 'DeepSeek V4 Pro', value: 'deepseek-v4-pro' },
];
const sessionThinkingOptions = [
  { label: '关闭思考', value: 'off' },
  { label: 'Low', value: 'low' },
  { label: 'High', value: 'high' },
  { label: 'Max', value: 'max' },
];

const sandboxBroker = createSandboxBroker(parent);
const broker = sandboxBroker.request;

const runtimeReady = ref(false);
const runtimeFailure = ref('');
const annotations = ref<Annotation[]>([]);
const REQUIRED_RUNTIME_SERVICES = ['fs', 'llm', 'tools', 'prompt', 'loop', 'task'] as const;
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
    updateAnnotationContext(message.event);
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
    NDropdown, NEmpty, NIcon, NPopover, NPopconfirm, NSelect, NSwitch, NTag, NTooltip, SandboxComposer,
    Activity, ArrowDown, Box, ChevronDown, Dots, FileText, LayersSubtract, Paperclip,
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
    const submittedAnnotationContext = ref('');
    const pendingUserAnnotations = ref<readonly Annotation[]>([]);
    const timelineView = useTimelineView(
      () => taskService.value?.messages ?? [],
      () => taskService.value?.activeTaskId.value,
      pendingUserAnnotations,
    );
    const busy = computed(() => actionBusy.value || loopService.value?.running.value === true);
    const runtimeLabel = computed(() => runtimeFailure.value ? '异常' : runtimeReady.value ? '就绪' : '启动中');
    const inspectorState = useSandboxInspector(
      taskService, loopService, fsService, managerService, broker, pushError,
      () => parent.postMessage({ channel: 'harness-shell-v1', type: 'open-options' }, '*'),
    );
    const sessionLlmConfig = computed(() => normalizeSessionLlmConfig(
      inspectorState.activeTask.value?.llm ?? DEFAULT_SESSION_LLM_CONFIG,
    ));
    const sessionThinkingValue = computed(() => sessionLlmConfig.value.thinking
      ? sessionLlmConfig.value.reasoningEffort : 'off');
    const sessionModelLabel = computed(() => {
      const selected = sessionModelOptions.find(option => option.value === sessionLlmConfig.value.model);
      const model = selected?.label.replace('DeepSeek ', '') ?? sessionLlmConfig.value.model;
      const thinking = sessionThinkingOptions.find(option => option.value === sessionThinkingValue.value)?.label
        ?? sessionThinkingValue.value;
      return `${model} · ${thinking}`;
    });
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
      pendingUserAnnotations.value = submittedAnnotations;
      submittedAnnotationContext.value = formatAnnotationContext(submittedAnnotations);
      timelineView.resumeTimelineFollow();
      const task = taskService.value;
      try {
        if (task) {
          if (task.activeTask()?.title === 'New task') await task.renameTask(task.activeTask()!.id, text.slice(0, 48));
          await task.setStatus(task.activeTask()!.id, 'running');
          await task.appendEvent('task/run-started', { prompt: text });
        }
        await loop.run(text);
        if (task) {
          await task.saveCheckpoint();
          await task.setStatus(task.activeTask()!.id, 'idle');
          await task.appendEvent('task/run-finished');
        }
      } catch (error) {
        if (task?.activeTask()) await task.setStatus(task.activeTask()!.id, 'failed');
        pushError(`发送失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        pendingUserAnnotations.value = [];
        submittedAnnotationContext.value = '';
      }
    }

    function clearAnnotations(): void {
      annotations.value.splice(0);
    }

    async function setSessionModel(model: string): Promise<void> {
      const task = taskService.value;
      if (!task || busy.value || !model.trim()) return;
      try { await task.setLlmConfig({ ...sessionLlmConfig.value, model: model.trim() }); }
      catch (error) { pushError(`模型设置保存失败：${error instanceof Error ? error.message : String(error)}`); }
    }

    async function setSessionThinking(value: 'off' | ReasoningEffort): Promise<void> {
      const task = taskService.value;
      if (!task || busy.value) return;
      try {
        await task.setLlmConfig({
          ...sessionLlmConfig.value,
          thinking: value !== 'off',
          ...(value !== 'off' ? { reasoningEffort: value } : {}),
        });
      } catch (error) {
        pushError(`思考模式保存失败：${error instanceof Error ? error.message : String(error)}`);
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
      displayMessageText, renderMarkdown, busy, runtimeReady, runtimeFailure, runtimeLabel,
      annotations, taskService,
      uiTheme, appMenuOptions, harnessMarkUrl, sessionModelOptions, sessionThinkingOptions,
      sessionLlmConfig, sessionThinkingValue, sessionModelLabel,
      snapshot, picker, send, clearAnnotations, setSessionModel, setSessionThinking,
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
      { name: 'llm', plugin: brokerLlmPlugin },
    ],
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
  pushError(`Agent runtime 初始化失败：${runtimeFailure.value}`);
  parent.postMessage({
    channel: 'harness-shell-v1',
    type: 'boot-error',
    error: runtimeFailure.value,
  }, '*');
}

function describeMissingRuntimeServices(): string {
  const fs = runtime.reflect.get('fs') as FsService | undefined;
  const details = missingRuntimeServices().map(name => {
    const plugin = capabilities.get(name);
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
