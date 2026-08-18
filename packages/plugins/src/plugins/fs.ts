import { reactive } from '@vue/reactivity'
import type { Context } from '@agentkit/runtime'
import type { FsChangeEvent, FsService } from '../services/types'

/**
 * fs 插件：OPFS 持久化虚拟文件系统。
 * 写穿透缓存：reactive Map 做读侧缓存（同步读 + 驱动 UI），写入同时落盘 OPFS。
 * write 与 remove 发出结构化事件（供 plugin loader 监听 .plugins 目录变更）。
 */
export function fsPlugin(ctx: Context): void {
  const cache = reactive(new Map<string, string>())
  const listeners = new Set<(e: FsChangeEvent) => void>()
  let rootDir: FileSystemDirectoryHandle | null = null

  const emit = (e: FsChangeEvent) => {
    for (const l of listeners) {
      try {
        l(e)
      } catch (err) {
        ctx.logger.error(`fs 事件监听异常：${(err as Error).message}`)
      }
    }
  }

  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    for await (const [name, handle] of dir.entries()) {
      const p = prefix + name
      if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, p + '/')
      else cache.set(p, await (await (handle as FileSystemFileHandle).getFile()).text())
    }
  }

  async function resolveDir(path: string, create: boolean) {
    const segs = path.split('/').filter(Boolean)
    let dir = rootDir!
    for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create })
    return { dir, name: segs[segs.length - 1] }
  }

  async function persist(path: string, content: string): Promise<void> {
    const { dir, name } = await resolveDir(path, true)
    const fh = await dir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(content)
    await w.close()
  }

  const supported = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
  const ready = (async () => {
    if (!supported) {
      ctx.logger.warn('当前浏览器不支持 OPFS，回退为纯内存 FS')
      return
    }
    rootDir = await navigator.storage.getDirectory()
    await walk(rootDir, '')
    if (cache.size) ctx.logger.info(`已从 OPFS 恢复 ${cache.size} 个文件（上次会话遗留）`)
  })().catch(e => ctx.logger.error(`OPFS 初始化失败：${(e as Error).message}`))

  const fs: FsService = {
    ready,
    read: p => (cache.has(p) ? cache.get(p)! : null),
    list: () => [...cache.keys()].sort(),
    async write(p, c) {
      const content = String(c ?? '')
      cache.set(p, content)
      if (rootDir) await persist(p, content)
      emit({ path: p, content })
    },
    async remove(p) {
      cache.delete(p)
      if (rootDir) {
        try {
          const { dir, name } = await resolveDir(p, false)
          await dir.removeEntry(name, { recursive: true })
        } catch {}
      }
      emit({ path: p, content: null })
    },
    async clear() {
      cache.clear()
      if (rootDir) {
        for await (const [name] of rootDir.entries()) {
          await rootDir.removeEntry(name, { recursive: true })
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  ctx.provide('fs', fs)
  ctx.effect(() => {
    ctx.logger.info('fs 插件已挂载（OPFS 持久化文件系统）')
    return () => ctx.logger.warn('fs 插件已卸载')
  })
}
