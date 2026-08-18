import type { Context } from '@agentkit/runtime'
import type { BrowserPluginManager } from '@agentkit/runtime'
import type { ToolsService } from '../services/types'

/**
 * 元工具：create_plugin / remove_plugin —— agent 造轮子与拆轮子的入口。
 * 走 BrowserPluginManager 事务：stage → validate → swap → verify → commit，失败回滚。
 */
export function createPluginTool(ctx: Context): void {
  const tools = ctx.get('tools') as ToolsService
  const unregister = tools.register('create_plugin', {
    schema: {
      type: 'function',
      function: {
        name: 'create_plugin',
        description:
          '创造并立即加载一个新插件（self-modifying）：源码在运行时编译挂载，插件可注册新工具或 UI 组件，后续对话轮次立即可用。同名调用会事务性热重载（失败自动回滚旧版本）。源码持久化，刷新后自动恢复。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '插件名，字母开头，可含数字 - _' },
            source: { type: 'string', description: 'ESM 模块源码，必须 export default function (ctx) {}' },
          },
          required: ['name', 'source'],
        },
      },
    },
    async run({ name, source }) {
      const plugins = ctx.get('plugins') as BrowserPluginManager | undefined
      if (!plugins) return 'Error: plugins 服务未就绪'
      try {
        await plugins.update(String(name), String(source ?? ''))
        return `插件 ${name} 已编译并挂载成功，其注册的工具/组件立即可用`
      } catch (e) {
        return `Error: ${(e as Error).message}`
      }
    },
  })
  ctx.effect(() => {
    ctx.logger.info('工具 create_plugin 已注册（agent 可以造轮子了）')
    return unregister
  })
}

export function removePluginTool(ctx: Context): void {
  const tools = ctx.get('tools') as ToolsService
  const unregister = tools.register('remove_plugin', {
    schema: {
      type: 'function',
      function: {
        name: 'remove_plugin',
        description: '卸载一个 agent 之前创建的动态插件，回收其全部副作用（工具、组件、定时器等）',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    },
    async run({ name }) {
      const plugins = ctx.get('plugins') as BrowserPluginManager | undefined
      if (!plugins) return 'Error: plugins 服务未就绪'
      if (!plugins.catalog.has(String(name))) {
        return `Error: 动态插件 ${name} 不存在（当前：${plugins.list().map(p => p.id).join(', ') || '无'}）`
      }
      await plugins.remove(String(name))
      return `插件 ${name} 已卸载，其注册的工具/组件已移除`
    },
  })
  ctx.effect(() => {
    ctx.logger.info('工具 remove_plugin 已注册')
    return unregister
  })
}
