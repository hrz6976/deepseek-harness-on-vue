import { Service, type Context, type Plugin } from '@deepseek-ai/cordis';
import { guardPageAgentTool, PAGE_AGENT_BOUNDARY_PROMPT } from './agent-policy';
import { recordPageArtifact } from './page-artifacts';
import type { PageSnapshot, SiteSkill } from '@/shared/page-protocol';
import type { PageSessionService } from '@/shared/runtime';

class PageSession extends Service implements PageSessionService {
  constructor(ctx: Context) { super(ctx, 'pageSession'); }

  private async readPage(maxNodes: number, maxDepth: number): Promise<PageSnapshot> {
    const result = await this.ctx.broker.request({ provider: 'page', action: 'command', input: {
      command: { type: 'page/snapshot', options: { maxNodes, maxDepth } },
    } }) as { ok?: boolean; value?: PageSnapshot; error?: string };
    if (!result.ok || !result.value) throw new Error(result.error ?? 'Snapshot failed.');
    return result.value;
  }

  async snapshot() {
    const task = this.ctx.task;
    const taskId = task.activeTaskId.value;
    const page = await this.readPage(400, 8);
    if (task.activeTaskId.value !== taskId) throw new Error('Task changed while reading the page. Read it again in the current task.');
    const nodeCount = countNodes(page.nodes);
    await task.addContext({
      kind: 'page', title: page.title || new URL(page.scope.url).host, locator: page.scope.url,
      metadata: { tabId: page.scope.tabId, frameId: page.scope.frameId, nodeCount, truncated: page.truncated },
    }, { type: 'context/read', data: { kind: 'page', url: page.scope.url, nodeCount } });
    return { page, nodeCount };
  }

  async startPicker(): Promise<void> {
    await this.ctx.broker.request({ provider: 'page', action: 'command', input: { command: { type: 'page/picker-start' } } });
  }

  async plugins(): Promise<{ url: string; plugins: SiteSkill[] }> {
    const page = await this.readPage(1, 0);
    const plugins = await this.ctx.broker.request({ provider: 'site-skill', action: 'list', input: {} }) as unknown as SiteSkill[];
    return { url: page.scope.url, plugins };
  }

  async setPluginEnabled(plugin: SiteSkill, enabled: boolean): Promise<void> {
    await this.ctx.broker.request({ provider: 'site-skill', action: 'save', input: { skill: { ...plugin, enabled } } });
    if (enabled) await this.ctx.broker.request({ provider: 'site-skill', action: 'apply', input: { id: plugin.id } });
  }

  async removePlugin(id: string): Promise<void> {
    await this.ctx.broker.request({ provider: 'site-skill', action: 'remove', input: { id } });
  }
}

function countNodes(nodes: PageSnapshot['nodes']): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children ?? []), 0);
}

/** Page-agent policy belongs to the runtime, independently of Vue rendering. */
export default {
  name: 'page-policy',
  inject: ['prompt', 'task', 'broker'],
  apply(ctx) {
    new PageSession(ctx);
    let unsavedPagePatch = false;
    ctx.prompt.register({ name: 'extension-page-boundary', order: -100, text: PAGE_AGENT_BOUNDARY_PROMPT });
    ctx.prompt.register({
      name: 'extension-page-persistence', order: -90,
      text: () => unsavedPagePatch
        ? 'The current host-page customization is still temporary. Let the user inspect and refine it across turns. End each refinement with one short question: continue adjusting, or if satisfied, install it as a page plugin? Call page_recipe_save only after explicit approval to persist.'
        : '',
    });
    ctx.on('tools/pre-execute', (request, next) => {
      const veto = guardPageAgentTool(request);
      return veto ? { ...request, veto } : next(request);
    });
    ctx.on('tools/post-execute', (event, next) => {
      const succeeded = !String(event.result).startsWith('Error:');
      if (event.name === 'page_patch_apply' && succeeded) unsavedPagePatch = true;
      if ((event.name === 'page_recipe_save' || event.name === 'page_patch_revert') && succeeded) unsavedPagePatch = false;
      return next(event);
    });
    ctx.on('page/event', event => { void recordPageArtifact(ctx.task, event); });
  },
} satisfies Plugin.Object;
