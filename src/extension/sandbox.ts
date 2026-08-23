import * as Vue from 'vue';
import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue';
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
  NInput,
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
  Send,
  Tool,
  Trash,
  World,
} from '@vicons/tabler';
import { services, useService } from '@/kernel/services';
import { bus, useBusOn, useRequestTransform, useToolGuard } from '@/kernel/bus';
import { usePromptSection } from '@/kernel/contrib';
import { PluginHost, plugins } from '@/kernel/host';
import { capabilities, capabilityHealth } from '@/kernel/capabilities';
import { modules } from '@/kernel/modules';
import { PLUGIN_DIR } from '@/kernel/boot';
import { createBrokerPlugin, systemPrincipal, type BrokerTransport } from '@/kernel/broker';
import { startHarnessRuntime } from '@/kernel/runtime-supervisor';
import { cordisContextKey } from '@/kernel/cordis';
import { brokerFsPlugin } from './broker-fs';
import { brokerLlmPlugin } from './broker-llm';
import { guardPageAgentTool, PAGE_AGENT_BOUNDARY_PROMPT } from './agent-policy';
import { attachAnnotationContext, canSubmitPageMessage, formatAnnotationContext, takeAnnotationSubmission } from './annotation-context';
import defaults from 'virtual:plugin-defaults';
import { createCapabilityEnvelope } from '@/shared/broker-schema';
import type {
  CapabilityEnvelope,
  CapabilityPrincipal,
  CapabilityRequest,
  CapabilityResponse,
  CapabilityStreamChunk,
} from '@/shared/capability-protocol';
import type {
  Annotation,
  PageEvent,
  PageSnapshot,
  SiteSkill,
} from '@/shared/page-protocol';
import type { FsService, HarnessMessage, JsonValue, LlmRequest, ToolCall } from '@/shared/runtime';
import type { HarnessArtifact, TaskContext, TaskStatus } from '@/shared/task-model';
import { shouldDisplayMessage } from './message-presentation';
import { isNearScrollBottom, nextScrollFollowState } from './scroll-follow';
import './sandbox.css';

interface TimelineEntry {
  id: string;
  kind: 'user' | 'agent' | 'event' | 'error';
  text: string;
}

type DisplayBlock =
  | { id: string; type: 'message'; message: HarnessMessage; annotations?: readonly Annotation[] }
  | { id: string; type: 'timeline'; item: TimelineEntry };

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

let requestSequence = 0;
const pending = new Map<string, {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: number;
}>();
const pendingStreams = new Map<string, {
  queue: CapabilityStreamChunk[];
  wake: (() => void) | null;
  acknowledgementTimer: number;
}>();
let brokerSessionToken = '';
let taskScopeHost = '';
let resolveBrokerSession!: () => void;
const brokerSessionReady = new Promise<void>(resolve => { resolveBrokerSession = resolve; });
const brokerSessionHello = () => parent.postMessage({ channel: 'harness-shell-v1', type: 'broker-session-hello' }, '*');
const brokerSessionHelloTimer = window.setInterval(brokerSessionHello, 250);

function transportRequest(principal: CapabilityPrincipal, payload: CapabilityRequest): Promise<JsonValue> {
  const requestId = `sandbox_${Date.now()}_${++requestSequence}`;
  let envelope: CapabilityEnvelope;
  try {
    envelope = createCapabilityEnvelope(brokerSessionToken, requestId, principal, payload);
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

async function* transportStream(principal: CapabilityPrincipal, payload: CapabilityRequest): AsyncIterable<JsonValue> {
  const requestId = `sandbox_stream_${Date.now()}_${++requestSequence}`;
  const envelope = createCapabilityEnvelope(brokerSessionToken, requestId, principal, payload);
  const state = {
    queue: [] as CapabilityStreamChunk[],
    wake: null as (() => void) | null,
    acknowledgementTimer: 0,
  };
  pendingStreams.set(requestId, state);
  // This timer covers only delivery to the service worker. Once it confirms
  // receipt, the provider owns the request deadline.
  state.acknowledgementTimer = window.setTimeout(() => {
    state.queue.push({
      channel: 'harness-broker-v1', requestId, stream: true, done: true,
      error: 'The extension service worker did not acknowledge the LLM request.',
    });
    state.wake?.();
  }, 10_000);
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
    }
  } finally {
    window.clearTimeout(state.acknowledgementTimer);
    pendingStreams.delete(requestId);
  }
}

const brokerTransport: BrokerTransport = {
  request: transportRequest,
  stream: transportStream,
};
const shellPrincipal = systemPrincipal();
const broker = (payload: CapabilityRequest) => transportRequest(shellPrincipal, payload);

const timeline = ref<TimelineEntry[]>([]);
const displayFeed = ref<DisplayBlock[]>([]);
const seenHarnessMessages = new WeakSet<object>();
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
  const shellMessage = event.data as { channel?: unknown; type?: unknown; origin?: unknown };
  if (shellMessage.channel === 'harness-shell-v1' && shellMessage.type === 'broker-session') {
    const token = (event.data as { token?: unknown }).token;
    if (!brokerSessionToken && typeof token === 'string' && token.length >= 32) {
      brokerSessionToken = token;
      const host = (event.data as { host?: unknown }).host;
      taskScopeHost = typeof host === 'string' ? host : '';
      window.clearInterval(brokerSessionHelloTimer);
      resolveBrokerSession();
    }
    return;
  }
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
    bus.emit('page/event', message.event);
    const text = summarizeEvent(message.event);
    if (text) appendTimeline('event', text);
    return;
  }
  const response = event.data as Partial<CapabilityResponse>;
  if (response.channel !== 'harness-broker-v1' || typeof response.requestId !== 'string') return;
  const streamChunk = event.data as Partial<CapabilityStreamChunk>;
  if (streamChunk.stream === true) {
    const stream = pendingStreams.get(response.requestId);
    if (stream) {
      window.clearTimeout(stream.acknowledgementTimer);
      stream.acknowledgementTimer = 0;
      stream.queue.push(streamChunk as CapabilityStreamChunk);
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

// The trusted side panel answers this once, before any OPFS plugin is mounted.
// Later hello messages are ignored so dynamic code cannot request the token.
brokerSessionHello();

const App = {
  name: 'HarnessSandbox',
  components: {
    NButton, NCollapse, NCollapseItem, NConfigProvider, NDrawer, NDrawerContent,
    NDropdown, NEmpty, NIcon, NInput, NPopconfirm, NSwitch, NTag, NTooltip,
    Activity, ArrowDown, Box, Dots, FileText, LayersSubtract, Paperclip, Send,
    Tool, Trash, World,
  },
  setup() {
    const input = ref('');
    const timelineEl = ref<HTMLElement | null>(null);
    const actionBusy = ref(false);
    const loopService = useService('loop');
    const taskService = useService('task');
    const fsService = useService('fs');
    let workspaceRefreshTimer: number | null = null;
    const inspector = ref<'tasks' | 'contexts' | 'artifacts' | 'capabilities' | null>(null);
    const inspectorOpen = computed({
      get: () => inspector.value !== null,
      set: (show: boolean) => { if (!show) inspector.value = null; },
    });
    const inspectorTitle = computed(() => inspector.value === 'tasks' ? '任务'
      : inspector.value === 'contexts' ? '上下文'
      : inspector.value === 'artifacts' ? '产物' : '能力');
    const unsavedPagePatch = ref(false);
    const pagePluginsOpen = ref(false);
    const pagePluginsBusy = ref(false);
    const pagePlugins = ref<SiteSkill[]>([]);
    const currentPageUrl = ref('');
    const submittedAnnotationContext = ref('');
    const pendingUserAnnotations = ref<readonly Annotation[]>([]);
    const activeTask = computed(() => taskService.value?.activeTask() ?? null);
    const taskStatusLabel = computed(() => taskStatusText(activeTask.value?.status ?? 'idle'));
    const activeContexts = computed(() => {
      const task = activeTask.value;
      return task ? (taskService.value?.contexts ?? []).filter(context => context.taskId === task.id) : [];
    });
    const activeArtifacts = computed(() => {
      const task = activeTask.value;
      return task ? (taskService.value?.artifacts ?? []).filter(artifact => artifact.taskId === task.id) : [];
    });
    const capabilityCards = computed(() => [...capabilities.values()].map(entry => ({ entry, health: capabilityHealth(entry) })));
    const workspaceFiles = computed(() => (fsService.value?.list() ?? []).filter(path => !path.startsWith('.plugins/') && !path.startsWith('.harness/')));
    let hydratedTaskId = '';
    const followTimeline = ref(true);
    let timelineFollowFrame: number | null = null;
    let timelinePointerActive = false;
    let timelineDiscreteScrollIntent = false;
    let lastTimelineScrollTop = 0;
    let timelineMutationObserver: MutationObserver | null = null;
    let timelineResizeObserver: ResizeObserver | null = null;

    function scheduleTimelineFollow(force = false): void {
      if ((!force && !followTimeline.value) || timelineFollowFrame != null) return;
      timelineFollowFrame = window.requestAnimationFrame(() => {
        timelineFollowFrame = null;
        const element = timelineEl.value;
        if (!element || (!force && !followTimeline.value)) return;
        element.scrollTop = element.scrollHeight;
        lastTimelineScrollTop = element.scrollTop;
        followTimeline.value = true;
      });
    }

    function onTimelineScroll(): void {
      const element = timelineEl.value;
      if (!element) return;
      const scrollTop = element.scrollTop;
      const userDriven = timelinePointerActive || timelineDiscreteScrollIntent;
      const nextFollowing = nextScrollFollowState({
        following: followTimeline.value,
        previousScrollTop: lastTimelineScrollTop,
        metrics: element,
        userDriven,
      });
      if (!nextFollowing) pauseTimelineFollow();
      else if (!followTimeline.value) resumeTimelineFollow();
      lastTimelineScrollTop = scrollTop;
      timelineDiscreteScrollIntent = false;
    }

    function pauseTimelineFollow(): void {
      followTimeline.value = false;
      if (timelineFollowFrame != null) {
        window.cancelAnimationFrame(timelineFollowFrame);
        timelineFollowFrame = null;
      }
    }

    function resumeTimelineFollow(): void {
      followTimeline.value = true;
      void nextTick(() => scheduleTimelineFollow(true));
    }

    function onTimelineWheel(event: WheelEvent): void {
      timelineDiscreteScrollIntent = true;
      if (event.deltaY < 0) pauseTimelineFollow();
      else if (!followTimeline.value && timelineEl.value && isNearScrollBottom(timelineEl.value)) resumeTimelineFollow();
    }

    function beginTimelinePointerScroll(): void {
      timelinePointerActive = true;
    }

    function endTimelinePointerScroll(): void {
      timelinePointerActive = false;
    }

    function onTimelineKeydown(event: KeyboardEvent): void {
      const backward = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey);
      const forward = ['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey);
      if (!backward && !forward) return;
      timelineDiscreteScrollIntent = true;
      if (backward) pauseTimelineFollow();
    }

    function resetTimelineFollow(): void {
      resumeTimelineFollow();
    }

    onMounted(() => {
      const element = timelineEl.value;
      if (!element) return;
      timelineMutationObserver = new MutationObserver(() => scheduleTimelineFollow());
      timelineMutationObserver.observe(element, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      timelineResizeObserver = new ResizeObserver(() => scheduleTimelineFollow());
      timelineResizeObserver.observe(element);
      lastTimelineScrollTop = element.scrollTop;
      window.addEventListener('pointerup', endTimelinePointerScroll);
      window.addEventListener('pointercancel', endTimelinePointerScroll);
      window.addEventListener('blur', endTimelinePointerScroll);
      resetTimelineFollow();
    });

    watch(
      () => [taskService.value, loopService.value, taskService.value?.activeTaskId.value] as const,
      async ([task, loop, taskId]) => {
        if (!task || !loop || !taskId || hydratedTaskId === taskId) return;
        await task.ready;
        if (hydratedTaskId === taskId) return;
        hydratedTaskId = taskId;
        resetTimelineFollow();
        displayFeed.value.splice(0);
        timeline.value.splice(0);
        loop.reset();
        const checkpoint = task.loadCheckpoint(taskId);
        if (checkpoint) loop.messages.push(...JSON.parse(JSON.stringify(checkpoint.messages)) as HarnessMessage[]);
      },
      { immediate: true },
    );
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
    useBusOn('page/event', (event: PageEvent) => { void recordPageArtifact(event); });

    async function snapshot(): Promise<void> {
      await run(async () => {
        const result = await broker({ provider: 'page', action: 'command', input: { command: { type: 'page/snapshot', options: { maxNodes: 400, maxDepth: 8 } } } });
        const pageResult = result as { ok?: boolean; value?: PageSnapshot; error?: string };
        if (!pageResult.ok || !pageResult.value) throw new Error(pageResult.error ?? 'Snapshot failed.');
        currentPageUrl.value = pageResult.value.scope.url;
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
      resetTimelineFollow();
      const task = taskService.value;
      try {
        if (task) {
          if (task.activeTask()?.title === 'New task') await task.renameTask(task.activeTask()!.id, text.slice(0, 48));
          await task.setStatus(task.activeTask()!.id, 'running');
          await task.appendEvent('task/run-started', { prompt: text });
        }
        await loop.run(text);
        if (task) {
          await task.saveCheckpoint(loop.messages);
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

    function openSettings(): void {
      parent.postMessage({ channel: 'harness-shell-v1', type: 'open-options' }, '*');
    }

    function clearAnnotations(): void {
      annotations.value.splice(0);
    }

    function openInspector(view: Exclude<typeof inspector.value, null>): void {
      pagePluginsOpen.value = false;
      inspector.value = inspector.value === view ? null : view;
    }

    async function createTask(): Promise<void> {
      const task = taskService.value;
      const loop = loopService.value;
      if (!task || !loop) return;
      if (task.activeTask()) await task.saveCheckpoint(loop.messages);
      const created = await task.createTask('New task');
      hydratedTaskId = '';
      await task.activateTask(created.id);
      inspector.value = null;
    }

    async function activateTask(id: string): Promise<void> {
      const task = taskService.value;
      const loop = loopService.value;
      if (!task || !loop || task.activeTaskId.value === id) return;
      if (task.activeTask()) await task.saveCheckpoint(loop.messages);
      hydratedTaskId = '';
      await task.activateTask(id);
    }

    async function deleteTask(id: string): Promise<void> {
      const task = taskService.value;
      const loop = loopService.value;
      if (!task || !loop) return;
      if (loop.running.value) {
        pushError('请先停止正在执行的任务，再删除。');
        return;
      }
      if (task.activeTaskId.value === id) hydratedTaskId = '';
      try {
        await task.deleteTask(id);
      } catch (error) {
        pushError(`任务删除失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    function handleAppMenuSelect(key: string): void {
      if (key === 'tasks') openInspector('tasks');
      if (key === 'settings') openSettings();
    }

    async function attachWorkspaceFile(path: string): Promise<void> {
      const task = taskService.value;
      const content = fsService.value?.read(path);
      if (!task || content == null) return;
      await task.addContext({ kind: 'file', title: path.split('/').at(-1) || path, locator: path, metadata: { size: content.length } });
      await task.appendEvent('context/attached', { kind: 'file', path });
    }

    async function removeContext(context: TaskContext): Promise<void> {
      await taskService.value?.removeContext(context.id);
    }

    async function saveMessageArtifact(message: HarnessMessage): Promise<void> {
      if (message.role !== 'assistant' || !message.text || !taskService.value) return;
      await taskService.value.createArtifact({
        kind: 'report', title: 'Agent report', status: 'ready', source: { type: 'agent' }, content: { text: message.text },
      });
      inspector.value = 'artifacts';
    }

    async function disableCapability(name: string): Promise<void> {
      const result = await getManager()?.unmount(name);
      if (result?.startsWith('Error:')) pushError(result);
    }

    async function removeCapability(name: string): Promise<void> {
      const manager = getManager();
      if (!manager) return pushError('Capability manager 尚未就绪。');
      const result = await manager.remove(name);
      if (result.startsWith('Error:')) pushError(result);
    }

    function getManager() {
      return services.get('manager')?.value as import('../shared/runtime').ManagerService | undefined;
    }

    async function recordPageArtifact(event: PageEvent): Promise<void> {
      const task = taskService.value;
      if (!task?.activeTask()) return;
      if (event.type === 'patch/applied') {
        const existing = task.artifacts.find(artifact => artifact.taskId === task.activeTask()!.id
          && artifact.kind === 'change-set' && artifact.content && typeof artifact.content === 'object'
          && !Array.isArray(artifact.content) && artifact.content.transactionId === event.transaction.id);
        if (!existing) await task.createArtifact({
          kind: 'change-set', title: event.transaction.label, status: 'verified', source: { type: 'provider', id: 'page' },
          content: { transactionId: event.transaction.id, url: event.transaction.scope.url, operations: JSON.parse(JSON.stringify(event.transaction.operations)) as JsonValue },
          verification: { status: 'passed', checkedAt: Date.now(), summary: `${event.transaction.verification.filter(result => result.ok).length}/${event.transaction.verification.length} operations verified` },
        });
      } else if (event.type === 'patch/reverted' || event.type === 'patch/verification-failed') {
        const artifact = task.artifacts.find(candidate => candidate.taskId === task.activeTask()!.id
          && candidate.kind === 'change-set' && candidate.content && typeof candidate.content === 'object'
          && !Array.isArray(candidate.content) && candidate.content.transactionId === event.transaction.id);
        if (artifact) await task.updateArtifact(artifact.id, event.type === 'patch/reverted'
          ? { status: 'archived', verification: { status: 'unverified', checkedAt: Date.now(), summary: 'Reverted from the page.' } }
          : { status: 'failed', verification: { status: 'failed', checkedAt: Date.now(), summary: 'Page verification failed.' } });
      } else if (event.type === 'recipe/installed') {
        const existing = task.artifacts.find(artifact => artifact.taskId === task.activeTask()!.id && artifact.kind === 'site-skill'
          && artifact.source.id === event.recipe.id);
        if (!existing) await task.createArtifact({
          kind: 'site-skill', title: event.recipe.name, status: event.recipe.enabled ? 'ready' : 'draft',
          source: { type: 'provider', id: event.recipe.id }, content: JSON.parse(JSON.stringify(event.recipe)) as JsonValue,
        });
      }
    }

    async function openPagePlugins(): Promise<void> {
      inspector.value = null;
      pagePluginsOpen.value = true;
      pagePluginsBusy.value = true;
      try {
        if (!currentPageUrl.value) {
          const result = await broker({ provider: 'page', action: 'command', input: { command: { type: 'page/snapshot', options: { maxNodes: 1, maxDepth: 0 } } } });
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
      const result = await broker({ provider: 'site-skill', action: 'list', input: {} });
      pagePlugins.value = Array.isArray(result) ? result as unknown as SiteSkill[] : [];
    }

    const currentPagePlugins = computed(() => pagePlugins.value.filter(plugin =>
      !currentPageUrl.value || plugin.matches.some(pattern => matchesPagePattern(pattern, currentPageUrl.value)),
    ));

    const currentPageHost = computed(() => {
      try { return currentPageUrl.value ? new URL(currentPageUrl.value).host : '当前页面'; }
      catch { return '当前页面'; }
    });

    async function setPagePluginEnabled(plugin: SiteSkill, enabled: boolean): Promise<void> {
      if (pagePluginsBusy.value) return;
      pagePluginsBusy.value = true;
      try {
        await broker({ provider: 'site-skill', action: 'save', input: { skill: { ...plugin, enabled } } });
        if (enabled) await broker({ provider: 'site-skill', action: 'apply', input: { id: plugin.id } });
        await refreshPagePlugins();
      } catch (error) {
        pushError(error instanceof Error ? error.message : String(error));
      } finally {
        pagePluginsBusy.value = false;
      }
    }

    async function removePagePlugin(plugin: SiteSkill): Promise<void> {
      if (pagePluginsBusy.value) return;
      pagePluginsBusy.value = true;
      try {
        await broker({ provider: 'site-skill', action: 'remove', input: { id: plugin.id } });
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
          hydratedTaskId = '';
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
      if (timelineFollowFrame != null) window.cancelAnimationFrame(timelineFollowFrame);
      window.removeEventListener('pointerup', endTimelinePointerScroll);
      window.removeEventListener('pointercancel', endTimelinePointerScroll);
      window.removeEventListener('blur', endTimelinePointerScroll);
      timelineMutationObserver?.disconnect();
      timelineResizeObserver?.disconnect();
    });

    return {
      input, timelineEl, followTimeline, onTimelineScroll, onTimelineWheel, beginTimelinePointerScroll, onTimelineKeydown, resumeTimelineFollow, displayBlocks, displayMessageText, busy, canSend, runtimeReady, runtimeFailure, runtimeLabel, plugins,
      annotations, inspector, inspectorOpen, inspectorTitle, taskService, activeTask, taskStatusLabel, activeContexts, activeArtifacts, capabilityCards, workspaceFiles,
      pagePluginsOpen, pagePluginsBusy, currentPagePlugins, currentPageHost,
      uiTheme, appMenuOptions,
      snapshot, picker, send, clearAnnotations, openSettings, openPagePlugins, setPagePluginEnabled, removePagePlugin,
      openInspector, createTask, activateTask, deleteTask, handleAppMenuSelect, attachWorkspaceFile, removeContext, saveMessageArtifact,
      disableCapability, removeCapability,
      contextKindLabel, formatToolArguments, toolStatusLabel, toolStatusType,
    };
  },
  template: `
    <n-config-provider :theme-overrides="uiTheme">
      <main class="shell">
        <header class="app-header">
          <div class="brand">
            <strong>Harness</strong>
            <button class="task-identity" type="button" @click="openInspector('tasks')">
              <span>{{ activeTask?.title || '正在恢复任务' }}</span>
              <small><i :class="activeTask?.status"></i>{{ taskStatusLabel }}</small>
            </button>
          </div>
          <nav class="actions" aria-label="任务视图">
            <n-tooltip trigger="hover"><template #trigger><n-button quaternary circle size="small" aria-label="上下文" @click="openInspector('contexts')"><template #icon><n-icon><Paperclip /></n-icon></template></n-button></template>上下文</n-tooltip>
            <n-tooltip trigger="hover"><template #trigger><n-button quaternary circle size="small" aria-label="产物" @click="openInspector('artifacts')"><template #icon><n-icon><Box /></n-icon></template></n-button></template>产物</n-tooltip>
            <n-tooltip trigger="hover"><template #trigger><n-button quaternary circle size="small" aria-label="能力" @click="openInspector('capabilities')"><template #icon><n-icon><LayersSubtract /></n-icon></template></n-button></template>能力</n-tooltip>
            <n-dropdown trigger="click" :options="appMenuOptions" @select="handleAppMenuSelect">
              <n-button quaternary circle size="small" aria-label="更多"><template #icon><n-icon><Dots /></n-icon></template></n-button>
            </n-dropdown>
          </nav>
        </header>

        <section class="context-bar" aria-label="当前上下文">
          <div class="context-chips">
            <n-tag v-for="context in activeContexts.slice(0, 2)" :key="context.id" size="small" :bordered="false" round :title="context.locator">
              <span class="context-kind">{{ contextKindLabel(context.kind) }}</span>{{ context.title }}
            </n-tag>
            <n-button v-if="activeContexts.length > 2" text size="tiny" @click="openInspector('contexts')">+{{ activeContexts.length - 2 }}</n-button>
            <span v-if="!activeContexts.length" class="context-empty">未附加上下文</span>
          </div>
          <div class="page-actions" aria-label="网页能力">
            <n-button text size="small" :disabled="busy" @click="snapshot"><template #icon><n-icon><World /></n-icon></template>读取</n-button>
            <n-button text size="small" :disabled="busy" @click="picker"><template #icon><n-icon><Activity /></n-icon></template>批注</n-button>
            <n-button text size="small" @click="openPagePlugins"><template #icon><n-icon><Tool /></n-icon></template>Skills</n-button>
          </div>
        </section>

        <div class="timeline-shell">
        <section ref="timelineEl" class="timeline" aria-live="polite" tabindex="0" @scroll.passive="onTimelineScroll" @wheel.passive="onTimelineWheel" @pointerdown="beginTimelinePointerScroll" @keydown="onTimelineKeydown">
          <n-empty v-if="displayBlocks.length === 0 && !busy" size="small" description="附加网页或文件，然后描述任务" />
          <article
            v-for="block in displayBlocks"
            :key="block.id"
            :class="[block.type === 'message' ? block.message.role : block.item.kind, { 'tool-record': block.type === 'message' && block.message.role === 'assistant' && block.message.toolCalls.length }]"
          >
            <template v-if="block.type === 'message' && block.message.role === 'assistant' && block.message.toolCalls.length">
              <div class="tool-turn-heading"><n-icon><Tool /></n-icon><strong>{{ block.message.toolCalls.length }} 个工具调用</strong></div>
              <n-collapse arrow-placement="right">
                <n-collapse-item v-for="call in block.message.toolCalls" :key="call.id" :name="call.id">
                  <template #header>
                    <div class="tool-call-title"><code>{{ call.name }}</code><n-tag size="tiny" :bordered="false" :type="toolStatusType(call)">{{ toolStatusLabel(call) }}</n-tag></div>
                  </template>
                  <div class="tool-payload">
                    <span>参数</span><pre>{{ formatToolArguments(call) }}</pre>
                    <template v-if="call.result !== undefined"><span>结果</span><pre>{{ call.result }}</pre></template>
                  </div>
                </n-collapse-item>
              </n-collapse>
            </template>
            <template v-else-if="block.type === 'message' && block.message.role === 'assistant'">
              <div class="assistant-answer">{{ displayMessageText(block.message) }}</div>
              <n-button v-if="block.message.text" text size="tiny" class="message-action" @click="saveMessageArtifact(block.message)"><template #icon><n-icon><FileText /></n-icon></template>存为报告</n-button>
            </template>
            <template v-else-if="block.type === 'message'">
              <div v-if="displayMessageText(block.message)" class="message-text">{{ displayMessageText(block.message) }}</div>
              <div v-if="block.message.role === 'user' && block.annotations?.length" class="message-annotations" aria-label="随消息发送的页面批注">
                <section v-for="annotation in block.annotations" :key="annotation.id" class="message-annotation">
                  <span class="message-annotation-label">批注</span><p>{{ annotation.text }}</p><code>{{ annotation.target.selector }}</code>
                </section>
              </div>
            </template>
            <template v-else>{{ block.item.text }}</template>
          </article>
          <div v-if="busy" class="agent-working"><n-icon><Activity /></n-icon><span>Agent 正在执行</span></div>
        </section>
        <n-button v-if="!followTimeline" class="timeline-jump" circle size="small" aria-label="回到底部" @click="resumeTimelineFollow"><template #icon><n-icon><ArrowDown /></n-icon></template></n-button>
        </div>

        <form class="composer" @submit.prevent="send">
          <div class="composer-field">
            <div v-if="annotations.length" class="annotation-context">
              <span>{{ annotations.length }} 个批注</span>
              <n-button text size="tiny" @click="clearAnnotations">清除</n-button>
            </div>
            <n-input v-model:value="input" class="composer-input" type="textarea" :bordered="false" :autosize="{ minRows: 2, maxRows: 6 }" placeholder="描述任务，或让 Harness 读取、分析和构建…" @keydown.ctrl.enter.prevent="send" />
            <div class="composer-footer">
              <span class="composer-hint">Ctrl Enter 发送</span>
              <n-button type="primary" size="small" :loading="busy" :disabled="!runtimeReady || !canSend" @click="send">
                <template #icon><n-icon><Send /></n-icon></template>{{ !runtimeReady ? '初始化中' : busy ? '处理中' : '发送' }}
              </n-button>
            </div>
          </div>
        </form>

        <n-drawer v-model:show="inspectorOpen" width="min(380px, 94vw)" placement="right">
          <n-drawer-content :title="inspectorTitle" closable :native-scrollbar="false">
            <p v-if="inspector !== 'tasks'" class="drawer-subtitle">{{ activeTask?.title }}</p>
            <div v-show="inspector === 'tasks'" class="task-list">
              <n-button type="primary" secondary block @click="createTask">新建任务</n-button>
              <div v-for="task in taskService?.tasks || []" :key="task.id" class="list-row task-row" :class="{ selected: task.id === activeTask?.id }">
                <button class="task-row-main" type="button" @click="activateTask(task.id)">
                  <span><strong>{{ task.title }}</strong><small>{{ task.contextIds.length }} 上下文 · {{ task.artifactIds.length }} 产物 · {{ task.capabilityIds.length }} 能力</small></span><i :class="task.status"></i>
                </button>
                <n-popconfirm positive-text="删除" negative-text="取消" @positive-click="deleteTask(task.id)">
                  <template #trigger><n-button quaternary circle size="tiny" type="error" aria-label="删除任务"><template #icon><n-icon><Trash /></n-icon></template></n-button></template>
                  删除“{{ task.title }}”？相关对话和产物记录会一起删除。
                </n-popconfirm>
              </div>
            </div>

            <div v-show="inspector === 'contexts'">
              <section class="inspector-section">
                <h3>已附加</h3>
                <n-empty v-if="!activeContexts.length" size="small" description="还没有网页、文件、选区或 MCP 上下文" />
                <div v-for="context in activeContexts" :key="context.id" class="list-row">
                  <span><strong>{{ context.title }}</strong><small>{{ context.kind }} · {{ context.locator }}</small></span>
                  <n-button quaternary circle size="tiny" type="error" aria-label="移除上下文" @click="removeContext(context)"><template #icon><n-icon><Trash /></n-icon></template></n-button>
                </div>
              </section>
              <section class="inspector-section">
                <h3>Workspace 文件</h3>
                <n-empty v-if="!workspaceFiles.length" size="small" description="Workspace 里还没有可附加文件" />
                <button v-for="path in workspaceFiles" :key="path" class="list-row attach-row" type="button" @click="attachWorkspaceFile(path)"><span><strong>{{ path.split('/').at(-1) }}</strong><small>{{ path }}</small></span><b>添加</b></button>
              </section>
            </div>

            <div v-show="inspector === 'artifacts'">
              <n-empty v-if="!activeArtifacts.length" size="small" description="报告、文件和 ChangeSet 会沉淀在这里" />
              <article v-for="artifact in activeArtifacts" :key="artifact.id" class="artifact-row">
                <div><n-tag size="tiny" :bordered="false">{{ artifact.kind }}</n-tag><strong>{{ artifact.title }}</strong></div>
                <small>v{{ artifact.version }} · {{ artifact.status }} · {{ artifact.verification.status }}</small><code v-if="artifact.contentPath">{{ artifact.contentPath }}</code>
              </article>
            </div>

            <div v-show="inspector === 'capabilities'" class="capability-view">
              <div class="capability-list">
                <article v-for="card in capabilityCards" :key="card.entry.manifest.id" class="capability-row">
                  <div><strong>{{ card.entry.manifest.title }}</strong><n-tag size="tiny" :bordered="false">{{ card.health.state }}</n-tag></div>
                  <p>{{ card.entry.manifest.scope }} scope · v{{ card.entry.manifest.version }}</p>
                  <small>{{ card.entry.contributions.tools.length }} tools · {{ card.entry.contributions.services.length }} services · {{ card.entry.contributions.events.length }} events</small>
                  <div v-if="card.entry.manifest.scope === 'task'" class="capability-controls">
                    <n-button size="tiny" secondary @click="disableCapability(card.entry.name)">停用</n-button>
                    <n-popconfirm positive-text="删除" negative-text="取消" @positive-click="removeCapability(card.entry.name)">
                      <template #trigger><n-button size="tiny" quaternary type="error">删除</n-button></template>删除此任务能力及其源码？
                    </n-popconfirm>
                  </div>
                  <details v-if="card.entry.manifest.permissions.length || card.health.issues.length"><summary>声明与权限</summary><p v-for="permission in card.entry.manifest.permissions" :key="permission.id">{{ permission.id }} — {{ permission.reason || '未说明用途' }}</p><p v-for="issue in card.health.issues" :key="issue">{{ issue }}</p></details>
                </article>
              </div>
              <section class="capability-surfaces"><h3>能力界面</h3><p>Agent 生成的交互界面会在任务里直接出现。</p><div class="runtime-host"><PluginHost v-for="plugin in plugins" :key="plugin.name + ':' + plugin.version" :plugin="plugin" /></div></section>
            </div>
          </n-drawer-content>
        </n-drawer>

        <n-drawer v-model:show="pagePluginsOpen" width="min(380px, 94vw)" placement="right">
          <n-drawer-content title="Site Skills" closable :native-scrollbar="false">
            <p class="drawer-subtitle">{{ currentPageHost }}</p>
            <n-empty v-if="!pagePluginsBusy && currentPagePlugins.length === 0" size="small" description="当前页面还没有 Site Skill" />
            <article v-for="plugin in currentPagePlugins" :key="plugin.id" class="page-plugin-item">
              <div class="page-plugin-copy"><strong>{{ plugin.name }}</strong><span>{{ plugin.matches.join(', ') }}</span></div>
              <n-switch size="small" :value="plugin.enabled" :loading="pagePluginsBusy" @update:value="setPagePluginEnabled(plugin, $event)" />
              <n-popconfirm positive-text="移除" negative-text="取消" @positive-click="removePagePlugin(plugin)">
                <template #trigger><n-button quaternary circle size="tiny" type="error" aria-label="移除 Site Skill"><template #icon><n-icon><Trash /></n-icon></template></n-button></template>移除此 Site Skill？
              </n-popconfirm>
            </article>
            <p class="page-plugins-hint">停用或移除后，刷新页面即可清除已应用效果。</p>
          </n-drawer-content>
        </n-drawer>
      </main>
    </n-config-provider>
  `,
};

const runtimeDefaults = Object.fromEntries(Object.entries(defaults).filter(([name]) => ![
  'chat', 'files', 'preview', 'settings', 'syslog',
].includes(name)));

globalThis.__harness = Object.freeze({
  modules,
});

async function initializeRuntime(): Promise<void> {
  await brokerSessionReady;
  const runtime = startHarnessRuntime({
    defaults: runtimeDefaults,
    taskScope: taskScopeHost,
    infrastructure: [
      { name: 'broker', plugin: createBrokerPlugin(brokerTransport) },
      { name: 'workspace', plugin: brokerFsPlugin },
      { name: 'llm', plugin: brokerLlmPlugin },
    ],
  });
  const shellContext = await runtime.shellContext;
  await runtime.ready;
  if (missingRuntimeServices().length) throw new Error(describeMissingRuntimeServices());
  const app = Vue.createApp(App);
  app.component('PluginHost', PluginHost);
  app.provide(cordisContextKey, shellContext);
  app.provide('services', services);
  app.provide('bus', bus);
  app.mount('#app');
  runtimeReady.value = true;
  parent.postMessage({ channel: 'harness-shell-v1', type: 'ready' }, '*');
}

void initializeRuntime().catch(reportBootFailure);

function pushError(text: string): void {
  appendTimeline('error', text);
}

function appendTimeline(kind: TimelineEntry['kind'], text: string): void {
  const item: TimelineEntry = { id: crypto.randomUUID(), kind, text };
  timeline.value.push(item);
  displayFeed.value.push({ id: item.id, type: 'timeline', item });
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
  parent.postMessage({
    channel: 'harness-shell-v1',
    type: 'boot-error',
    error: runtimeFailure.value,
  }, '*');
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

function contextKindLabel(kind: TaskContext['kind']): string {
  switch (kind) {
    case 'page': return '网页';
    case 'file': return '文件';
    case 'selection': return '选区';
    case 'mcp': return 'MCP';
  }
}

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

function taskStatusText(status: TaskStatus): string {
  switch (status) {
    case 'idle': return '可继续';
    case 'running': return '执行中';
    case 'waiting': return '等待确认';
    case 'failed': return '需要处理';
    case 'completed': return '已完成';
  }
}
