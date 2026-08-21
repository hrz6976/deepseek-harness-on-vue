import type { BrokerRequest } from '../shared/page-protocol';
import type { JsonValue } from '../shared/runtime';

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
};

export class OpfsStore {
  #rootPromise: Promise<IterableDirectoryHandle> | null = null;

  async handle(request: Extract<BrokerRequest, { kind: `fs/${string}` }>): Promise<JsonValue> {
    switch (request.kind) {
      case 'fs/list': return await this.list();
      case 'fs/write': await this.write(request.path, request.content); return null;
      case 'fs/remove': await this.remove(request.path); return null;
      case 'fs/clear': await this.clear(); return null;
    }
  }

  async list(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    await this.walk(await this.root(), '', files);
    return files;
  }

  async write(path: string, content: string): Promise<void> {
    const { directory, name } = await this.resolve(path, true);
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async remove(path: string): Promise<void> {
    const { directory, name } = await this.resolve(path, false);
    await directory.removeEntry(name, { recursive: true });
  }

  async clear(): Promise<void> {
    const root = await this.root();
    for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
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
}

function safeSegments(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  if (!segments.length || segments.some(segment => segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new Error('Invalid virtual filesystem path.');
  }
  return segments;
}
