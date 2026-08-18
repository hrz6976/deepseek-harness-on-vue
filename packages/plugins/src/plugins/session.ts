import { reactive } from '@vue/reactivity'
import type { Context } from '@agentkit/runtime'
import type { ChatMessage, SessionService } from '../services/types'

/** session 插件：append-only 会话日志（resume / fork / 审计的基础） */
export function sessionPlugin(ctx: Context): void {
  const messages = reactive<ChatMessage[]>([])
  const session: SessionService = {
    messages,
    append: m => messages.push(m),
    clear: () => messages.splice(0),
  }
  ctx.provide('session', session)
  ctx.effect(() => {
    ctx.logger.info('session 插件已挂载（append-only 日志）')
    return () => ctx.logger.warn('session 插件已卸载')
  })
}
