import { Service, type Context } from '@deepseek-ai/cordis';
import { shallowReactive } from 'vue';
import { assertPrincipalAuthorized } from '@/shared/capability-policy';
import type { CapabilityPrincipal } from '@/shared/capability-protocol';
import type { FsService } from '@/shared/runtime';
import { principalForContext } from './broker';

interface WorkspaceFile { content: string; revision?: string }

export abstract class WorkspaceRuntime extends Service implements FsService {
  protected readonly files = shallowReactive(new Map<string, WorkspaceFile>());
  abstract readonly ready: Promise<void>;

  constructor(ctx: Context) { super(ctx, 'fs'); }

  protected authorize(action: 'read' | 'write'): CapabilityPrincipal {
    const principal = principalForContext(this.ctx);
    assertPrincipalAuthorized(principal, action === 'read'
      ? { provider: 'workspace', action: 'list', input: {} }
      : { provider: 'workspace', action: 'write', input: { path: '.policy-probe', content: '' } });
    return principal;
  }

  read(path: string): string | null {
    this.authorize('read');
    return this.files.get(path)?.content ?? null;
  }

  list(): string[] {
    this.authorize('read');
    return [...this.files.keys()].sort();
  }

  protected setFile(path: string, file: WorkspaceFile): void {
    if (this.files.get(path)?.content === file.content) return;
    this.files.set(path, file);
    this.ctx.emit('workspace/changed', path, file.content);
  }

  protected removeFile(path: string): void {
    if (this.files.delete(path)) this.ctx.emit('workspace/changed', path, null);
  }

  abstract write(path: string, content: string): Promise<void>;
  abstract remove(path: string): Promise<void>;
}
