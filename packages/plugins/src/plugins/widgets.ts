import { markRaw, reactive } from '@vue/reactivity'
import type { Context } from '@agentkit/runtime'
import type { WidgetsService } from '../services/types'

/** widgets 插件：动态 UI 组件注册表（token ownership 同 tools） */
export function widgetsPlugin(ctx: Context): void {
  const registry = reactive(new Map<string, { token: symbol; comp: unknown }>())
  const widgets: WidgetsService = {
    entries: () => [...registry.entries()].map(([name, e]) => [name, e.comp] as [string, unknown]),
    register(name, comp) {
      const token = Symbol(name)
      registry.set(name, { token, comp: markRaw(comp as object) })
      return () => {
        if (registry.get(name)?.token === token) registry.delete(name)
      }
    },
  }
  ctx.provide('widgets', widgets)
  ctx.effect(() => {
    ctx.logger.info('widgets 插件已挂载（动态 UI 组件槽位）')
    return () => ctx.logger.warn('widgets 插件已卸载')
  })
}
