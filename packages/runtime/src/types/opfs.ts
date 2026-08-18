export {}

declare global {
  /** TS DOM lib 尚未包含 OPFS 目录句柄的异步迭代器方法，这里补上 */
  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>
    keys(): AsyncIterableIterator<string>
    values(): AsyncIterableIterator<FileSystemHandle>
  }
}
