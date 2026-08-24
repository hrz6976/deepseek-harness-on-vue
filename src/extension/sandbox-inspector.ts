import { computed, ref, type ComputedRef } from 'vue';
import { capabilities, capabilityHealth } from '@/kernel/capabilities';
import { pluginPolicy } from '@/kernel/plugin-policy';
import { matchesPagePattern, type PageEvent, type PageSnapshot, type SiteSkill } from '@/shared/page-protocol';
import type { CapabilityRequest } from '@/shared/capability-protocol';
import {
  errorMessage,
  toJsonValue,
  type FsService,
  type HarnessMessage,
  type JsonValue,
  type LoopService,
  type ManagerService,
  type TaskRuntimeService,
} from '@/shared/runtime';
import type { HarnessArtifact, TaskContext, TaskStatus } from '@/shared/task-model';

type InspectorView = 'tasks' | 'contexts' | 'artifacts' | 'capabilities';
type BrokerRequest = (request: CapabilityRequest) => Promise<JsonValue>;

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  idle: '可继续', running: '执行中', waiting: '等待确认', failed: '需要处理', completed: '已完成',
};

function changeSetMatches(artifact: HarnessArtifact, taskId: string, transactionId: string): boolean {
  return artifact.taskId === taskId && artifact.kind === 'change-set' && !!artifact.content
    && typeof artifact.content === 'object' && !Array.isArray(artifact.content)
    && artifact.content.transactionId === transactionId;
}

export function useSandboxInspector(
  taskService: ComputedRef<TaskRuntimeService | null>,
  loopService: ComputedRef<LoopService | null>,
  fsService: ComputedRef<FsService | null>,
  managerService: ComputedRef<ManagerService | null>,
  request: BrokerRequest,
  reportError: (message: string) => void,
  openSettings: () => void,
) {
  const inspector = ref<InspectorView | null>(null);
  const inspectorOpen = computed({
    get: () => inspector.value !== null,
    set: (show: boolean) => { if (!show) inspector.value = null; },
  });
  const inspectorTitle = computed(() => inspector.value === 'tasks' ? '任务'
    : inspector.value === 'contexts' ? '上下文'
    : inspector.value === 'artifacts' ? '产物' : '能力');
  const pagePluginsOpen = ref(false);
  const pagePluginsBusy = ref(false);
  const pagePlugins = ref<SiteSkill[]>([]);
  const currentPageUrl = ref('');
  const activeTask = computed(() => taskService.value?.activeTask() ?? null);
  const taskStatusLabel = computed(() => TASK_STATUS_LABELS[activeTask.value?.status ?? 'idle']);
  const activeContexts = computed(() => activeTask.value
    ? (taskService.value?.contexts ?? []).filter(context => context.taskId === activeTask.value!.id) : []);
  const activeArtifacts = computed(() => activeTask.value
    ? (taskService.value?.artifacts ?? []).filter(artifact => artifact.taskId === activeTask.value!.id) : []);
  const taskRows = computed(() => {
    const service = taskService.value;
    return (service?.tasks ?? []).map(task => ({ task,
      contextCount: service!.contexts.filter(context => context.taskId === task.id).length,
      artifactCount: service!.artifacts.filter(artifact => artifact.taskId === task.id).length,
    }));
  });
  const capabilityCards = computed(() => [...capabilities.values()].map(entry => ({
    entry, health: capabilityHealth(entry), policy: pluginPolicy(entry.manifest.id),
  })));
  const workspaceFiles = computed(() => (fsService.value?.list() ?? [])
    .filter(path => !path.startsWith('.plugins/') && !path.startsWith('.harness/')));
  const currentPagePlugins = computed(() => pagePlugins.value.filter(plugin =>
    !currentPageUrl.value || plugin.matches.some(pattern => matchesPagePattern(pattern, currentPageUrl.value))));
  const currentPageHost = computed(() => {
    try { return currentPageUrl.value ? new URL(currentPageUrl.value).host : '当前页面'; }
    catch { return '当前页面'; }
  });

  function openInspector(view: InspectorView): void {
    pagePluginsOpen.value = false;
    inspector.value = inspector.value === view ? null : view;
  }
  async function createTask(): Promise<void> {
    if (!taskService.value) return;
    if (loopService.value?.running.value) return reportError('请先停止正在执行的任务，再新建。');
    await taskService.value.createTask('New task');
    inspector.value = null;
  }
  async function activateTask(id: string): Promise<void> {
    const task = taskService.value;
    if (loopService.value?.running.value) return reportError('请先停止正在执行的任务，再切换。');
    if (task && task.activeTaskId.value !== id) await task.activateTask(id);
  }
  async function deleteTask(id: string): Promise<void> {
    const task = taskService.value;
    if (!task || !loopService.value) return;
    if (loopService.value.running.value) return reportError('请先停止正在执行的任务，再删除。');
    try { await task.deleteTask(id); }
    catch (error) { reportError(`任务删除失败：${errorMessage(error)}`); }
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
    const result = await managerService.value?.unmount(name);
    if (result?.startsWith('Error:')) reportError(result);
  }
  async function removeCapability(name: string): Promise<void> {
    if (!managerService.value) return reportError('Capability manager 尚未就绪。');
    const result = await managerService.value.remove(name);
    if (result.startsWith('Error:')) reportError(result);
  }
  async function recordPageArtifact(event: PageEvent): Promise<void> {
    const task = taskService.value;
    const active = task?.activeTask();
    if (!task || !active) return;
    if (event.type === 'patch/applied') {
      if (!task.artifacts.some(artifact => changeSetMatches(artifact, active.id, event.transaction.id))) {
        await task.createArtifact({
          kind: 'change-set', title: event.transaction.label, status: 'verified', source: { type: 'provider', id: 'page' },
          content: { transactionId: event.transaction.id, url: event.transaction.scope.url, operations: toJsonValue(event.transaction.operations) },
          verification: { status: 'passed', checkedAt: Date.now(), summary: `${event.transaction.verification.filter(result => result.ok).length}/${event.transaction.verification.length} operations verified` },
        });
      }
    } else if (event.type === 'patch/reverted' || event.type === 'patch/verification-failed') {
      const artifact = task.artifacts.find(candidate => changeSetMatches(candidate, active.id, event.transaction.id));
      if (artifact) await task.updateArtifact(artifact.id, event.type === 'patch/reverted'
        ? { status: 'archived', verification: { status: 'unverified', checkedAt: Date.now(), summary: 'Reverted from the page.' } }
        : { status: 'failed', verification: { status: 'failed', checkedAt: Date.now(), summary: 'Page verification failed.' } });
    } else if (event.type === 'recipe/installed' && !task.artifacts.some(artifact =>
      artifact.taskId === active.id && artifact.kind === 'site-skill' && artifact.source.id === event.recipe.id)) {
      await task.createArtifact({
        kind: 'site-skill', title: event.recipe.name, status: event.recipe.enabled ? 'ready' : 'draft',
        source: { type: 'provider', id: event.recipe.id }, content: toJsonValue(event.recipe),
      });
    }
  }
  async function refreshPagePlugins(): Promise<void> {
    const result = await request({ provider: 'site-skill', action: 'list', input: {} });
    pagePlugins.value = Array.isArray(result) ? result as unknown as SiteSkill[] : [];
  }

  async function withPagePluginsBusy(action: () => Promise<void>): Promise<void> {
    if (pagePluginsBusy.value) return;
    pagePluginsBusy.value = true;
    try { await action(); }
    catch (error) { reportError(errorMessage(error)); }
    finally { pagePluginsBusy.value = false; }
  }

  async function openPagePlugins(): Promise<void> {
    inspector.value = null;
    pagePluginsOpen.value = true;
    await withPagePluginsBusy(async () => {
      if (!currentPageUrl.value) {
        const result = await request({ provider: 'page', action: 'command', input: { command: { type: 'page/snapshot', options: { maxNodes: 1, maxDepth: 0 } } } });
        const pageResult = result as { ok?: boolean; value?: PageSnapshot };
        if (pageResult.ok && pageResult.value) currentPageUrl.value = pageResult.value.scope.url;
      }
      await refreshPagePlugins();
    });
  }

  async function setPagePluginEnabled(plugin: SiteSkill, enabled: boolean): Promise<void> {
    await withPagePluginsBusy(async () => {
      await request({ provider: 'site-skill', action: 'save', input: { skill: { ...plugin, enabled } } });
      if (enabled) await request({ provider: 'site-skill', action: 'apply', input: { id: plugin.id } });
      await refreshPagePlugins();
    });
  }

  async function removePagePlugin(plugin: SiteSkill): Promise<void> {
    await withPagePluginsBusy(async () => {
      await request({ provider: 'site-skill', action: 'remove', input: { id: plugin.id } });
      await refreshPagePlugins();
    });
  }

  return {
    inspector, inspectorOpen, inspectorTitle, pagePluginsOpen, pagePluginsBusy,
    currentPageUrl, currentPagePlugins, currentPageHost, activeTask, taskStatusLabel,
    activeContexts, activeArtifacts, taskRows, capabilityCards, workspaceFiles,
    openInspector, createTask, activateTask, deleteTask, handleAppMenuSelect,
    attachWorkspaceFile, removeContext, saveMessageArtifact, disableCapability,
    removeCapability, recordPageArtifact, openPagePlugins, setPagePluginEnabled, removePagePlugin,
  };
}
