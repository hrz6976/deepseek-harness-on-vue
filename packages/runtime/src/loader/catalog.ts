import { reactive, shallowReactive } from '@vue/reactivity'

/**
 * PluginCatalog：Vue reactive 的 desired-state 目录，驱动 UI 与 reconcile。
 * reactivity 只负责"状态变化可见/可触发"，真正的事务由 reconciler 完成。
 */

export type PluginStatus = 'stored' | 'loading' | 'active' | 'reloading' | 'failed' | 'disabled'

export interface PluginRecord {
  id: string
  enabled: boolean
  source: string
  /** 每次源码变更 +1，reconciler 据此跳过重复同步 */
  revision: number
  status: PluginStatus
  error?: string
}

export type PluginCatalog = Map<string, PluginRecord>

export function createCatalog(): PluginCatalog {
  return shallowReactive(new Map())
}

export function upsertRecord(
  catalog: PluginCatalog,
  id: string,
  patch: Partial<Omit<PluginRecord, 'id'>>,
): PluginRecord {
  const old = catalog.get(id)
  if (old) {
    Object.assign(old, patch)
    return old
  }
  const record = reactive<PluginRecord>({
    id,
    enabled: true,
    source: '',
    revision: 0,
    status: 'stored',
    ...patch,
  })
  catalog.set(id, record)
  return record
}
