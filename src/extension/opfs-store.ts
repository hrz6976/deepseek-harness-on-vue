import { workspaceRevision, type WorkspaceCapabilityRequest } from '@/shared/capability-protocol';
import type { JsonValue } from '@/shared/runtime';

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
};

export class OpfsStore {
  #rootPromise: Promise<IterableDirectoryHandle> | null = null;
  #channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('harness-workspace-v1');
  #listeners = new Set<() => void>();

  constructor() {
    if (this.#channel) this.#channel.onmessage = () => {
      for (const listener of this.#listeners) listener();
    };
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async handle(request: WorkspaceCapabilityRequest): Promise<JsonValue> {
    switch (request.action) {
      case 'list': return await this.list();
      case 'write': await this.write(request.input.path, request.input.content, request.input.expectedRevision); return null;
      case 'remove': await this.remove(request.input.path, request.input.expectedRevision); return null;
      case 'clear': await this.clear(); return null;
    }
  }

  async list(): Promise<Record<string, string>> {
    return await this.withLock('shared', async () => {
      const files: Record<string, string> = {};
      await this.walk(await this.root(), '', files);
      return files;
    });
  }

  async write(path: string, content: string, expectedRevision?: string | null): Promise<void> {
    await this.withLock('exclusive', async () => {
      const current = await this.read(path);
      this.assertRevision(path, current, expectedRevision);
      const { directory, name } = await this.resolve(path, true);
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
    });
    this.#channel?.postMessage({ type: 'write', path });
  }

  async remove(path: string, expectedRevision?: string | null): Promise<void> {
    await this.withLock('exclusive', async () => {
      const current = await this.read(path);
      this.assertRevision(path, current, expectedRevision);
      const { directory, name } = await this.resolve(path, false);
      await directory.removeEntry(name, { recursive: true });
    });
    this.#channel?.postMessage({ type: 'remove', path });
  }

  async clear(): Promise<void> {
    await this.withLock('exclusive', async () => {
      const root = await this.root();
      for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
    });
    this.#channel?.postMessage({ type: 'clear' });
  }

  private async root(): Promise<IterableDirectoryHandle> {
    this.#rootPromise ??= (async () => {
      const opfsRoot = await navigator.storage.getDirectory();
      return await opfsRoot.getDirectoryHandle('harness-page-agent', { create: true }) as IterableDirectoryHandle;
    })();
    return this.#rootPromise;
  }

  private async walk(directory: IterableDirectoryHandle, prefix: string, files: Record<string, string>): Promise<void> {
    for await (const [name, handle] of directory.entries()) {
      const path = `${prefix}${name}`;
      if (handle.kind === 'directory') await this.walk(handle as IterableDirectoryHandle, `${path}/`, files);
      else files[path] = await (await handle.getFile()).text();
    }
  }

  private async resolve(path: string, create: boolean): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
    const segments = safeSegments(path);
    let directory: FileSystemDirectoryHandle = await this.root();
    for (const segment of segments.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(segment, { create });
    }
    return { directory, name: segments.at(-1)! };
  }

  private async read(path: string): Promise<string | null> {
    try {
      const { directory, name } = await this.resolve(path, false);
      return await (await directory.getFileHandle(name)).getFile().then(file => file.text());
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  private assertRevision(path: string, current: string | null, expected: string | null | undefined): void {
    if (expected === undefined) return;
    const actual = workspaceRevision(current);
    const normalizedExpected = expected ?? 'absent';
    if (actual !== normalizedExpected) {
      throw new Error(`Workspace conflict for "${path}": expected revision ${normalizedExpected}, found ${actual}. Refresh and retry.`);
    }
  }

  private async withLock<T>(mode: 'shared' | 'exclusive', operation: () => Promise<T>): Promise<T> {
    if (!navigator.locks) return await operation();
    return await navigator.locks.request('harness-workspace-opfs', { mode }, operation);
  }
}

function safeSegments(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  if (!segments.length || segments.some(segment => segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new Error('Invalid virtual filesystem path.');
  }
  return segments;
}
