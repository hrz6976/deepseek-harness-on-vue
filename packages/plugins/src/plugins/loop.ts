import type { Context } from '@agentkit/runtime'
import type { LlmService, LoopService, SessionService, ToolsService } from '../services/types'

const SYSTEM_PROMPT = `你是一个运行在浏览器里的 coding agent，通过工具操作一个持久化的虚拟文件系统（OPFS）。
工作方式：
1. 用 file_editor 管理文件：先 list 看现状，write 创建文件，view 检查内容，str_replace 做局部修改
2. 用 run_js 执行 JavaScript 来验证逻辑、计算或调试
3. 如果用户要网页/游戏/工具，把所有代码写进 index.html 单个文件（内联 <style> 和 <script>），用户可以直接预览
4. 修改文件前先 view 确认当前内容
5. 你可以用 create_plugin 给自己造轮子（self-modifying）：写一个 ESM 插件源码，必须 export default function (ctx) {}，系统会立即编译挂载。插件里可以：
   - 注册新工具：const tools = ctx.get('tools'); const un = tools.register(工具名, { schema, run }); ctx.effect(() => un);
     schema 必须是 OpenAI function 格式：{ type: 'function', function: { name, description, parameters } }
   - 注册 UI 组件（会渲染到右侧"动态组件"面板）：const widgets = ctx.get('widgets'); const un2 = widgets.register(组件名, { template: '<div>...</div>', setup() { return {} } }); ctx.effect(() => un2); 组件里用 window.Vue 的 ref/computed
   - 组件要响应服务的热替换/卸载（比如模型切换），在 setup 里用 computed 惰性注入：const llm = window.Vue.computed(() => ctx.get('llm')); 模板里用 llm.value?.name 或 llm?.name（模板会自动解包）。这样 llm 服务挂载、卸载、换实现时组件自动更新
   - 可用 ctx.get(...) 读取的服务：fs、tools、widgets、session、llm、plugins；日志用 ctx.logger.info/warn/error
   - 外部资源（定时器等）必须包进 ctx.effect(fn)，fn 返回清理函数（可以是 async）
   - 如果用户要改宿主聊天界面本身（例如 app-shell、右侧面板、整体主题），这不是虚拟文件，不能用 file_editor。必须用 create_plugin 写插件直接操作宿主 document/CSS。宿主界面的根容器是 .app-shell，主题颜色由 :root 的 --bg、--panel、--panel-2、--border、--border-soft、--text、--muted、--faint、--accent、--good、--warn、--bad 控制。改这些 CSS 变量可以整体换肤；对 document 的修改要放在 ctx.effect 里，并返回恢复函数。
   修改宿主主题的插件示例：
   export default function (ctx) {
     ctx.effect(() => {
       const style = document.createElement('style');
       style.textContent = ':root { --bg: #f5f5f7 !important; --panel: #ffffff !important; --panel-2: #f7f8fa !important; --text: #1d1d1f !important; --muted: #6b7280 !important; } .app-shell { color: var(--text) !important; }';
       document.head.appendChild(style);
       return () => style.remove();
     });
   }
   用 remove_plugin 卸载。造轮子的典型场景：需要反复执行的复杂逻辑、需要访问 fetch/DOM 等 run_js 里不方便用的能力、需要常驻状态的功能。
   同名 create_plugin 会触发事务性热重载：先编译验证新源码，挂载失败会自动回滚旧版本，不会丢插件。
   插件示例：
   export default function (ctx) {
     const tools = ctx.get('tools');
     const un = tools.register('dice', {
       schema: { type: 'function', function: { name: 'dice', description: '掷一个 N 面骰子', parameters: { type: 'object', properties: { sides: { type: 'number' } } } } },
       run: ({ sides = 6 }) => String(1 + Math.floor(Math.random() * sides)),
     });
     ctx.effect(() => un);
   }
任务完成后，用一两句话总结你做了什么。只用已有工具，不要索要其他能力。`

/**
 * loop 插件：Agent Loop 本身也是插件。
 * tools/session 是生命周期依赖（挂载时声明 inject），
 * llm 是运行时动态查询（连接/断开模型不应拆毁 loop）。
 */
export function loopPlugin(ctx: Context): void {
  let aborted = false

  const loop: LoopService = {
    stop: () => {
      aborted = true
    },
    async run(goal) {
      aborted = false
      const llm = ctx.get('llm') as LlmService | undefined
      const tools = ctx.get('tools') as ToolsService | undefined
      const session = ctx.get('session') as SessionService | undefined
      if (!session || !tools) return
      if (!llm) {
        session.append({ role: 'note', content: 'llm 服务未就绪（请先挂载模型）' })
        return
      }
      const fs = ctx.get('fs') as import('../services/types').FsService | undefined
      if (fs?.ready) await fs.ready // 等 OPFS 预载完成，保证能看到上次会话的文件

      if (!session.messages.some(m => m.role === 'system')) {
        session.append({ role: 'system', content: SYSTEM_PROMPT })
      }
      session.append({ role: 'user', content: goal })

      for (let turn = 0; turn < 20; turn++) {
        if (aborted) {
          session.append({ role: 'note', content: '已手动停止' })
          return
        }
        let msg
        try {
          msg = await llm.chat(
            session.messages
              .filter(m => m.role !== 'note')
              .map(m => ({
                role: m.role,
                content: m.content,
                ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
                ...(m.role === 'tool' ? { tool_call_id: m.tool_call_id } : {}),
              })),
            tools.schemas(),
          )
        } catch (e) {
          session.append({ role: 'note', content: `LLM 调用失败：${(e as Error).message}` })
          return
        }
        session.append({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls || [] })
        if (!msg.tool_calls?.length) return // 无工具调用 = 完成
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(tc.function.arguments || '{}')
          } catch {}
          const result = await tools.call(tc.function.name, args)
          session.append({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: String(result).slice(0, 8000),
          })
        }
      }
      session.append({ role: 'note', content: '达到最大轮次（20），已停止' })
    },
  }

  ctx.provide('loop', loop)
  ctx.effect(() => {
    ctx.logger.info('loop 插件已挂载（Agent Loop，上限 20 轮）')
    return () => ctx.logger.warn('loop 插件已卸载')
  })
}
