import { computed, ref } from 'vue';
import { useService } from '@/kernel/services';
import { capabilities, capabilityHealth } from '@/kernel/capabilities';
import { pluginPolicy } from '@/kernel/plugin-policy';
import { matchesPagePattern, type SiteSkill } from '@/shared/page-protocol';
import { errorMessage, type HarnessMessage } from '@/shared/runtime';
import type { TaskContext, TaskStatus } from '@/shared/task-model';

type InspectorView = 'tasks' | 'contexts' | 'artifacts' | 'capabilities';

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  idle: '可继续', running: '执行中', waiting: '等待确认', failed: '需要处理', completed: '已完成',
};

export function useSandboxInspector(
  reportError: (message: string) => void,
  openSettings: () => void,
) {
  const taskService = useService('task');
  const loopService = useService('loop');
  const fsService = useService('fs');
  const managerService = useService('manager');
  const pageSession = useService('pageSession');
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
    return (service?.tasks ?? []).map(task => ({
      task,
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
  async function saveMessageArtifact(message: HarnessMessage): Promise<void> {
    try {
      if (!taskService.value) throw new Error('任务尚未就绪，请稍后重试。');
      if (await taskService.value.saveMessageArtifact(message)) inspector.value = 'artifacts';
    } catch (error) {
      reportError(`保存报告失败：${errorMessage(error)}`);
    }
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
  async function refreshPagePlugins(): Promise<void> {
    const result = await pageSession.value!.plugins();
    pagePlugins.value = result.plugins;
    currentPageUrl.value = result.url;
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
    await withPagePluginsBusy(refreshPagePlugins);
  }

  async function setPagePluginEnabled(plugin: SiteSkill, enabled: boolean): Promise<void> {
    await withPagePluginsBusy(async () => {
      await pageSession.value!.setPluginEnabled(plugin, enabled);
      await refreshPagePlugins();
    });
  }

  async function removePagePlugin(plugin: SiteSkill): Promise<void> {
    await withPagePluginsBusy(async () => {
      await pageSession.value!.removePlugin(plugin.id);
      await refreshPagePlugins();
    });
  }

  return {
    inspector, inspectorOpen, inspectorTitle, pagePluginsOpen, pagePluginsBusy,
    currentPageUrl, currentPagePlugins, currentPageHost, activeTask, taskStatusLabel,
    activeContexts, activeArtifacts, taskRows, capabilityCards, workspaceFiles,
    openInspector, createTask, activateTask, deleteTask, handleAppMenuSelect,
    attachWorkspaceFile: (path: string) => taskService.value?.attachFile(path),
    removeContext: (context: TaskContext) => taskService.value?.removeContext(context.id),
    saveMessageArtifact, disableCapability,
    removeCapability, openPagePlugins, setPagePluginEnabled, removePagePlugin,
  };
}
