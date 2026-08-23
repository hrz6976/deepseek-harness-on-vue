// Standalone workspace provider. Extension builds use broker-fs, but both
// implementations preserve the calling Cordis Context and enforce the same
// manifest-backed workspace policy.
import { Service, type Context } from '@deepseek-ai/cordis';
import { reactive } from 'vue';
import { principalForContext } from '@/kernel/broker';
import { assertPrincipalAuthorized } from '@/shared/capability-policy';
import { errorMessage, log } from '@/sdk';
import type { FsService } from '@/shared/runtime';

type OpfsDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
};

class OpfsRuntime extends Service implements FsService {
  readonly files = reactive(new Map<string, string>());
  readonly ready: Promise<void>;
  private rootDir: OpfsDirectoryHandle | null = null;

  constructor(ctx: Context) {
    super(ctx, 'fs');
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    if (!navigator.storage?.getDirectory) {
      log('OPFS unsupported in this browser, falling back to in-memory fs', 'warn');
      return;
    }
    try {
      this.rootDir = await navigator.storage.getDirectory() as OpfsDirectoryHandle;
      await this.walk(this.rootDir, '');
      if (this.files.size) log(`restored ${this.files.size} file(s) from OPFS (previous session)`, 'ok');
    } catch (error) {
      log('OPFS init failed: ' + errorMessage(error), 'err');
    }
  }

  private async walk(dir: OpfsDirectoryHandle, prefix: string): Promise<void> {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix + name;
      if (handle.kind === 'directory') await this.walk(handle as OpfsDirectoryHandle, path + '/');
      else this.files.set(path, await (await handle.getFile()).text());
    }
  }

  private async resolveDir(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const segments = path.split('/').filter(Boolean);
    if (!this.rootDir) throw new Error('OPFS root is not ready');
    let dir: FileSystemDirectoryHandle = this.rootDir;
    for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment, { create });
    const name = segments.at(-1);
    if (!name) throw new Error('file path is empty');
    return { dir, name };
  }

  private async persist(path: string, content: string): Promise<void> {
    const { dir, name } = await this.resolveDir(path, true);
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(content);
    await writable.close();
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
    this.files.set(path, value);
    if (this.rootDir) await this.persist(path, value);
  }

  async remove(path: string): Promise<void> {
    this.authorize('write');
    this.files.delete(path);
    if (!this.rootDir) return;
    try {
      const { dir, name } = await this.resolveDir(path, false);
      await dir.removeEntry(name, { recursive: true });
    } catch { /* already absent */ }
  }

  async clear(): Promise<void> {
    this.authorize('write');
    this.files.clear();
    if (!this.rootDir) return;
    for await (const [name] of this.rootDir.entries()) await this.rootDir.removeEntry(name, { recursive: true });
  }
}

export const fsPlugin = {
  name: 'fs',
  apply(ctx: Context) {
    new OpfsRuntime(ctx);
    ctx.effect(() => () => log('fs plugin unmounted', 'warn'), 'fs.log-dispose');
  },
};

export default fsPlugin;
