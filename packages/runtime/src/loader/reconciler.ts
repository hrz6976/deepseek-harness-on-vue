import type { Context, Fiber } from '../runtime'
import { FiberStatus } from '../runtime'
import type { PluginCatalog } from './catalog'
import type { CompiledPlugin, PluginCompiler } from './compiler'
import type { SourceStore } from './source-store'

/**
 * PluginReconciler：整插件热重载事务。
 *
 *   stage（编译候选，旧插件不受影响）
 *   → swap（卸载旧 fiber，挂载新 fiber）
 *   → verify（await fiber）
 *   → commit（成功后才写入 OPFS）
 *   失败 → rollback（重新挂载旧模块，旧服务恢复）
 *
 * 运行时生命周期由官方 cordis 负责；这里只保留浏览器加载器的
 * “编译 → 事务性替换 → 持久化”协调逻辑。
 */

interface ActivePlugin {
  revision: number
  source: string
  module: CompiledPlugin
  fiber: Fiber
}

export class PluginReconciler {
  private active = new Map<string, ActivePlugin>()
  private epochs = new Map<string, number>()
  private queues = new Map<string, Promise<void>>()

  constructor(
    private readonly host: Context,
    private readonly catalog: PluginCatalog,
    private readonly store: SourceStore,
    private readonly compiler: PluginCompiler,
  ) {}

  /** 串行化同一插件的更新；返回的 Promise 在失败时 reject（供调用方报错） */
  reconcile(id: string): Promise<void> {
    const prev = this.queues.get(id) ?? Promise.resolve()
    const next = prev.then(() => this._reconcile(id))
    this.queues.set(id, next.catch(() => {}))
    return next
  }

  isActive(id: string): boolean {
    return this.active.has(id)
  }

  private async _reconcile(id: string): Promise<void> {
    const epoch = (this.epochs.get(id) ?? 0) + 1
    this.epochs.set(id, epoch)

    const desired = this.catalog.get(id)
    const previous = this.active.get(id)

    // 记录被删除 → 卸载运行实例
    if (!desired) {
      if (previous) {
        await previous.fiber.dispose().catch(() => {})
        this.active.delete(id)
      }
      return
    }

    // 禁用 → 卸载运行实例，持久化 enabled=false
    if (!desired.enabled) {
      if (previous) {
        await previous.fiber.dispose().catch(() => {})
        this.active.delete(id)
      }
      desired.status = 'disabled'
      await this.store.setEnabled(id, false).catch(() => {})
      return
    }

    // 运行实例已是最新 revision → 无需动作
    if (
      previous &&
      previous.revision === desired.revision &&
      previous.fiber.state === FiberStatus.ACTIVE
    ) {
      desired.status = 'active'
      return
    }

    desired.status = previous ? 'reloading' : 'loading'
    desired.error = undefined

    // ① stage：先编译候选源码，旧插件继续运行；编译失败不影响现状
    let candidate: CompiledPlugin
    try {
      candidate = await this.compiler.compile(id, desired.source)
    } catch (e) {
      desired.status = 'failed'
      desired.error = `编译失败：${(e as Error).message}`
      throw e
    }
    if (this.epochs.get(id) !== epoch) return // 编译期间又来了新更新

    // ② swap + ③ verify
    let fiber: Fiber | null = null
    try {
      if (previous) await previous.fiber.dispose().catch(() => {})
      fiber = this.host.plugin({ name: `dyn:${id}`, apply: candidate.default })
      await fiber
      if (this.epochs.get(id) !== epoch) {
        await fiber.dispose().catch(() => {})
        return
      }
      this.active.set(id, {
        revision: desired.revision,
        source: desired.source,
        module: candidate,
        fiber,
      })
    } catch (e) {
      await fiber?.dispose().catch(() => {})
      // ④ rollback：新插件挂载失败，恢复旧模块
      if (previous) {
        try {
          const restored = this.host.plugin({
            name: `dyn:${id}`,
            apply: previous.module.default,
          })
          await restored
          this.active.set(id, { ...previous, fiber: restored })
          desired.error = `更新失败（已回滚到 revision ${previous.revision}）：${(e as Error).message}`
        } catch (e2) {
          this.active.delete(id)
          desired.error = `更新失败且回滚失败：${(e as Error).message} / ${(e2 as Error).message}`
        }
      } else {
        desired.error = `挂载失败：${(e as Error).message}`
      }
      desired.status = 'failed'
      throw e
    }

    // ⑤ commit：验证通过后才持久化
    try {
      await this.store.commit(id, desired.source, desired.enabled)
    } catch (e) {
      // 运行时已成功，仅持久化失败：不回滚运行实例
      desired.error = `已挂载，但持久化失败：${(e as Error).message}`
      this.host.logger.error(`插件 ${id} 持久化失败：${(e as Error).message}`)
    }
    desired.status = 'active'
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.queues.values()]).catch(() => {})
    for (const [, p] of this.active) await p.fiber.dispose().catch(() => {})
    this.active.clear()
  }
}
