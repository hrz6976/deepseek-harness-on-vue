import type { Context } from '@deepseek-ai/cordis';
import { log } from '@/kernel/log';
import { WorkspaceRuntime } from '@/kernel/workspace-runtime';
import { workspaceRevision, type WorkspaceCapabilityRequest } from '@/shared/capability-protocol';

class BrokerFsRuntime extends WorkspaceRuntime {
  readonly ready: Promise<void>;

  constructor(ctx: Context) {
    super(ctx);
    this.ready = this.restore();
  }

  private async restore(): Promise<void> {
    const files = await this.ctx.broker.request({ provider: 'workspace', action: 'list', input: {} }) as Record<string, string>;
    for (const path of [...this.files.keys()]) if (!(path in files)) this.removeFile(path);
    for (const [path, content] of Object.entries(files)) this.setFile(path, { content, revision: workspaceRevision(content) });
    if (this.files.size) log(`restored ${this.files.size} file(s) from extension OPFS`, 'ok');
  }

  async refresh(): Promise<void> {
    await this.restore();
  }

  private async mutate(request: Extract<WorkspaceCapabilityRequest, { action: 'write' | 'remove' }>): Promise<void> {
    try { await this.ctx.broker.request(request); }
    catch (error) {
      if (error instanceof Error && error.message.includes('Workspace conflict')) {
        try { await this.restore(); } catch { /* retain the original conflict */ }
      }
      throw error;
    }
  }

  async write(path: string, content: string): Promise<void> {
    const value = String(content ?? '');
    const expectedRevision = this.files.get(path)?.revision ?? null;
    await this.mutate({ provider: 'workspace', action: 'write', input: { path, content: value, expectedRevision } });
    this.setFile(path, { content: value, revision: workspaceRevision(value) });
  }

  async remove(path: string): Promise<void> {
    const expectedRevision = this.files.get(path)?.revision ?? null;
    await this.mutate({ provider: 'workspace', action: 'remove', input: { path, expectedRevision } });
    this.removeFile(path);
  }

}

export const brokerFsPlugin = {
  name: 'broker-fs',
  inject: ['broker'],
  apply(ctx: Context) {
    new BrokerFsRuntime(ctx);
    ctx.effect(() => () => log('broker fs plugin unmounted', 'warn'), 'broker-fs.log-dispose');
  },
};
