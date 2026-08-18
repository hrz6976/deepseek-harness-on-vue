/**
 * PluginSourceStore：插件源码与启用状态的持久化（OPFS）。
 * 布局：`.plugins/<id>.js` 存源码，`.plugins/manifest.json` 存 enabled 等元数据。
 */

export interface StoredPlugin {
  id: string
  source: string
  enabled: boolean
}

export interface SourceStore {
  readonly ready: Promise<void>
  list(): Promise<StoredPlugin[]>
  /** 只有新插件验证通过后才调用（stage → verify → commit） */
  commit(id: string, source: string, enabled: boolean): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
  remove(id: string): Promise<void>
}

/** OPFS 直存实现：不依赖 fs service，独立可用 */
export class OpfsSourceStore implements SourceStore {
  readonly ready: Promise<void>
  private dir: FileSystemDirectoryHandle | null = null

  constructor(private prefix = '.plugins') {
    this.ready = (async () => {
      const root = await navigator.storage.getDirectory()
      this.dir = await root.getDirectoryHandle(this.prefix, { create: true })
    })()
  }

  private async readManifest(): Promise<Record<string, { enabled: boolean }>> {
    if (!this.dir) return {}
    try {
      const fh = await this.dir.getFileHandle('manifest.json')
      return JSON.parse(await (await fh.getFile()).text())
    } catch {
      return {}
    }
  }

  private async writeManifest(m: Record<string, { enabled: boolean }>): Promise<void> {
    if (!this.dir) return
    const fh = await this.dir.getFileHandle('manifest.json', { create: true })
    const w = await fh.createWritable()
    await w.write(JSON.stringify(m, null, 2))
    await w.close()
  }

  async list(): Promise<StoredPlugin[]> {
    await this.ready
    if (!this.dir) return []
    const manifest = await this.readManifest()
    const out: StoredPlugin[] = []
    for await (const [name, handle] of this.dir.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.js')) continue
      const id = name.slice(0, -3)
      const source = await (await (handle as FileSystemFileHandle).getFile()).text()
      out.push({ id, source, enabled: manifest[id]?.enabled ?? true })
    }
    return out
  }

  async commit(id: string, source: string, enabled: boolean): Promise<void> {
    await this.ready
    if (!this.dir) throw new Error('OPFS 不可用')
    const fh = await this.dir.getFileHandle(`${id}.js`, { create: true })
    const w = await fh.createWritable()
    await w.write(source)
    await w.close()
    const m = await this.readManifest()
    m[id] = { enabled }
    await this.writeManifest(m)
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.ready
    const m = await this.readManifest()
    if (m[id]) {
      m[id].enabled = enabled
      await this.writeManifest(m)
    }
  }

  async remove(id: string): Promise<void> {
    await this.ready
    if (!this.dir) return
    try {
      await this.dir.removeEntry(`${id}.js`)
    } catch {}
    const m = await this.readManifest()
    delete m[id]
    await this.writeManifest(m)
  }
}

/** 内存实现：OPFS 不可用时降级 + 单元测试 */
export class MemorySourceStore implements SourceStore {
  readonly ready: Promise<void> = Promise.resolve()
  private data = new Map<string, { source: string; enabled: boolean }>()

  async list(): Promise<StoredPlugin[]> {
    return [...this.data.entries()].map(([id, v]) => ({ id, source: v.source, enabled: v.enabled }))
  }

  async commit(id: string, source: string, enabled: boolean): Promise<void> {
    this.data.set(id, { source, enabled })
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const v = this.data.get(id)
    if (v) v.enabled = enabled
  }

  async remove(id: string): Promise<void> {
    this.data.delete(id)
  }
}
