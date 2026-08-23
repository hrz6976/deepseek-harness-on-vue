import { Service, type Context } from '@deepseek-ai/cordis';
import { reactive } from 'vue';
import { principalForContext } from '@/kernel/broker';
import { log } from '@/kernel/log';
import { assertPrincipalAuthorized } from '@/shared/capability-policy';
import type { FsService } from '@/shared/runtime';
import { workspaceRevision } from '@/shared/capability-protocol';

class BrokerFsRuntime extends Service implements FsService {
  readonly files = reactive(new Map<string, string>());
  readonly revisions = new Map<string, string>();
  readonly ready: Promise<void>;

  constructor(ctx: Context) {
    super(ctx, 'fs');
    this.ready = this.restore();
  }

  private async restore(): Promise<void> {
    const files = await this.ctx.broker.request({ provider: 'workspace', action: 'list', input: {} }) as Record<string, string>;
    for (const path of [...this.files.keys()]) if (!(path in files)) {
      this.files.delete(path);
      this.revisions.delete(path);
    }
    for (const [path, content] of Object.entries(files)) this.files.set(path, content);
    for (const [path, content] of Object.entries(files)) this.revisions.set(path, workspaceRevision(content));
    if (this.files.size) log(`restored ${this.files.size} file(s) from extension OPFS`, 'ok');
  }

  async refresh(): Promise<void> {
    this.authorize('read');
    await this.restore();
  }

  private authorize(action: 'read' | 'write'): void {
    const principal = principalForContext(this.ctx);
    if (action === 'read') {
      assertPrincipalAuthorized(principal, { provider: 'workspace', action: 'list', input: {} });
    } else {
      assertPrincipalAuthorized(principal, { provider: 'workspace', action: 'write', input: { path: '.policy-probe', content: '' } });
    }
  }

  read(path: string): string | null {
    this.authorize('read');
    return this.files.get(path) ?? null;
  }

  list(): string[] {
    this.authorize('read');
    return [...this.files.keys()].sort();
  }

  async write(path: string, content: string): Promise<void> {
    this.authorize('write');
    const value = String(content ?? '');
    const expectedRevision = this.revisions.get(path) ?? null;
    try {
      await this.ctx.broker.request({ provider: 'workspace', action: 'write', input: { path, content: value, expectedRevision } });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Workspace conflict')) {
        try { await this.restore(); } catch { /* retain the original conflict */ }
      }
      throw error;
    }
    this.files.set(path, value);
    this.revisions.set(path, workspaceRevision(value));
  }

  async remove(path: string): Promise<void> {
    this.authorize('write');
    const expectedRevision = this.revisions.get(path) ?? null;
    try {
      await this.ctx.broker.request({ provider: 'workspace', action: 'remove', input: { path, expectedRevision } });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Workspace conflict')) {
        try { await this.restore(); } catch { /* retain the original conflict */ }
      }
      throw error;
    }
    this.files.delete(path);
    this.revisions.delete(path);
  }

  async clear(): Promise<void> {
    this.authorize('write');
    this.files.clear();
    this.revisions.clear();
    await this.ctx.broker.request({ provider: 'workspace', action: 'clear', input: {} });
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
