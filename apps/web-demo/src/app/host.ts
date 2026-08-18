import { shallowReactive } from 'vue'
import {
  BrowserPluginManager,
  MemorySourceStore,
  OpfsSourceStore,
  createRootContext,
  type Context,
} from '@agentkit/runtime'
import {
  createPluginTool,
  fsPlugin,
  loopPlugin,
  removePluginTool,
  sessionPlugin,
  toolsPlugin,
  widgetsPlugin,
} from '@agentkit/plugins'
import type { FsService } from '@agentkit/plugins'

/** 宿主装配：cordis 运行时 + 核心插件 + 浏览器动态插件加载器 */

export interface SyslogEntry {
  text: string
  level: string
}

export const syslogs = shallowReactive<SyslogEntry[]>([])

/**
 * 把 cordis 服务可用性镜像成 Vue 可追踪状态。
 * UI 的 useService 读这张表；服务挂载/卸载时由 internal/service 事件更新。
 */
export const serviceState = shallowReactive(new Map<string, unknown>())

export const root: Context = createRootContext()

// cordis 结构化日志 → 宿主右侧运行时日志面板
root.logger.exporter({
  export(message) {
    const text = message.args.map(String).join(' ')
    const level =
      message.type === 'error' ? 'err' : message.type === 'warn' ? 'warn' : 'ok'
    syslogs.push({ text, level })
  },
})

root.on('internal/service', (name: string, value: unknown) => {
  serviceState.set(name, value)
})

export const log = (
  text: string,
  level: 'ok' | 'warn' | 'err' = 'ok',
): void => {
  if (level === 'err') root.logger.error(text)
  else if (level === 'warn') root.logger.warn(text)
  else root.logger.info(text)
}

// 核心插件（挂载顺序无关：cordis 声明式 inject 会自动等依赖就绪）
root.plugin({ name: 'fs', apply: fsPlugin })
root.plugin({ name: 'tools', apply: toolsPlugin })
root.plugin({ name: 'widgets', apply: widgetsPlugin })
root.plugin({ name: 'session', apply: sessionPlugin })
root.plugin({ name: 'loop', inject: ['tools', 'session'], apply: loopPlugin })

// 动态插件管理器（浏览器加载器 + 事务性热重载）
const opfsSupported =
  typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
export const pluginManager = new BrowserPluginManager({
  host: root,
  store: opfsSupported ? new OpfsSourceStore() : new MemorySourceStore(),
})
root.provide('plugins', pluginManager)

// 元工具（agent 造轮子的入口）
root.plugin({ name: 'tool:create_plugin', inject: ['tools', 'plugins'], apply: createPluginTool })
root.plugin({ name: 'tool:remove_plugin', inject: ['tools', 'plugins'], apply: removePluginTool })

// file_editor 直接改 .plugins/x.js 时触发事务性热重载（内容相同则跳过，天然幂等）
root.inject(['fs'], ctx => {
  const fs = ctx.get('fs') as FsService
  return fs.subscribe(e => {
    const m = /^\.plugins\/([a-z][a-z0-9_-]*)\.js$/i.exec(e.path)
    if (!m) return
    if (e.content === null) {
      void pluginManager
        .remove(m[1])
        .catch(err => log(`移除插件 ${m[1]} 失败：${(err as Error).message}`, 'err'))
    } else {
      void pluginManager
        .syncFromExternal(m[1], e.content)
        .catch(err => log(`热重载插件 ${m[1]} 失败：${(err as Error).message}`, 'err'))
    }
  })
})

// 启动恢复：从 OPFS 收敛 desired state
void pluginManager.restore().then(() => {
  const n = pluginManager.list().length
  if (n) log(`已从 OPFS 恢复 ${n} 个动态插件`)
})
