import type { Context } from '../runtime'
import { createCatalog, upsertRecord, type PluginCatalog, type PluginRecord } from './catalog'
import { BlobCompiler, type PluginCompiler } from './compiler'
import { PluginReconciler } from './reconciler'
import type { SourceStore } from './source-store'

/**
 * BrowserPluginManager：对 agent/UI 暴露的 facade。
 *
 *   install / update / enable / disable / remove / restore / list
 */
export class BrowserPluginManager {
  readonly catalog: PluginCatalog
  private readonly reconciler: PluginReconciler
  private readonly store: SourceStore

  constructor(options: {
    host: Context
    store: SourceStore
    compiler?: PluginCompiler
    catalog?: PluginCatalog
  }) {
    this.catalog = options.catalog ?? createCatalog()
    this.store = options.store
    this.reconciler = new PluginReconciler(
      options.host,
      this.catalog,
      options.store,
      options.compiler ?? new BlobCompiler(),
    )
  }

  private static assertName(id: string): void {
    if (!/^[a-z][a-z0-9_-]*$/i.test(id)) {
      throw new Error('插件名需以字母开头，只含字母数字 - _')
    }
  }

  list(): PluginRecord[] {
    return [...this.catalog.values()]
  }

  /** 安装新插件：编译→挂载→验证→持久化，任一步失败不留残局 */
  async install(id: string, source: string): Promise<void> {
    BrowserPluginManager.assertName(id)
    if (this.catalog.has(id)) throw new Error(`插件 ${id} 已存在，请使用 update`)
    upsertRecord(this.catalog, id, { source, enabled: true, revision: 1, status: 'loading' })
    try {
      await this.reconciler.reconcile(id)
    } catch (e) {
      // 首次安装失败：不保留记录（也没有旧版本可回滚）
      this.catalog.delete(id)
      throw e
    }
  }

  /** 更新源码：revision +1 触发事务性重载，失败自动回滚旧版本 */
  async update(id: string, source: string): Promise<void> {
    const record = this.catalog.get(id)
    if (!record) return this.install(id, source)
    record.source = source
    record.revision += 1
    record.enabled = true
    await this.reconciler.reconcile(id)
  }

  /** 文件系统事件入口（file_editor 直接改 .plugins/*.js 时）；内容相同则跳过 */
  async syncFromExternal(id: string, source: string): Promise<void> {
    const record = this.catalog.get(id)
    if (record && record.source === source) return
    await this.update(id, source)
  }

  async enable(id: string): Promise<void> {
    const record = this.catalog.get(id)
    if (!record) throw new Error(`插件 ${id} 不存在`)
    if (record.enabled) return
    record.enabled = true
    await this.reconciler.reconcile(id)
  }

  async disable(id: string): Promise<void> {
    const record = this.catalog.get(id)
    if (!record) throw new Error(`插件 ${id} 不存在`)
    record.enabled = false
    await this.reconciler.reconcile(id)
  }

  async remove(id: string): Promise<void> {
    this.catalog.delete(id)
    await this.reconciler.reconcile(id)
    await this.store.remove(id)
  }

  /** 启动恢复：从 SourceStore 读出 desired state，逐个收敛 */
  async restore(): Promise<void> {
    const stored = await this.store.list()
    for (const { id, source, enabled } of stored) {
      if (!this.catalog.has(id)) {
        upsertRecord(this.catalog, id, { source, enabled, revision: 1, status: 'stored' })
      }
    }
    for (const { id, enabled } of stored) {
      if (!enabled) continue
      try {
        await this.reconciler.reconcile(id)
      } catch {
        // 恢复失败：记录已标记 failed，下次刷新重试，不阻断其他插件
      }
    }
  }

  async dispose(): Promise<void> {
    await this.reconciler.disposeAll()
  }
}
