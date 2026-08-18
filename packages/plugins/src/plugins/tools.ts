import { reactive } from '@vue/reactivity'
import type { Context } from '@agentkit/runtime'
import type { FsService, ToolDefinition, ToolsService } from '../services/types'

/**
 * tools 插件：工具注册表（token ownership：unregister 只撤自己的注册）。
 * 工具本身也是子插件 —— 热插拔一个工具 = 挂载一个 fiber。
 * 内置工具声明式 inject 依赖，fs 与 tools 未就绪时保持 PENDING。
 */
export function toolsPlugin(ctx: Context): void {
  interface Entry extends ToolDefinition {
    token: symbol
  }
  const registry = reactive(new Map<string, Entry>())

  const tools: ToolsService = {
    schemas: () => [...registry.values()].map(t => t.schema),
    list: () => [...registry.keys()],
    async call(name, args) {
      const t = registry.get(name)
      if (!t) return `Error: 工具 ${name} 不存在（当前可用：${[...registry.keys()].join(', ')}）`
      try {
        return await t.run(args)
      } catch (e) {
        return `Error: ${(e as Error).message}`
      }
    },
    register(name, def) {
      const token = Symbol(name)
      registry.set(name, { token, ...def })
      return () => {
        if (registry.get(name)?.token === token) registry.delete(name)
      }
    },
  }

  ctx.provide('tools', tools)
  ctx.plugin({ name: 'tool:file_editor', inject: ['fs', 'tools'], apply: fileEditorTool })
  ctx.plugin({ name: 'tool:run_js', inject: ['tools'], apply: runJsTool })
  ctx.effect(() => {
    ctx.logger.info('tools 插件已挂载（工具注册表）')
    return () => ctx.logger.warn('tools 插件已卸载')
  })
}

/** file_editor：对标 Harness minimal 模式的 str_replace_editor */
function fileEditorTool(ctx: Context): void {
  const fs = ctx.get('fs') as FsService
  const tools = ctx.get('tools') as ToolsService
  const unregister = tools.register('file_editor', {
    schema: {
      type: 'function',
      function: {
        name: 'file_editor',
        description:
          '操作虚拟文件系统：list 列出全部文件；view 读取文件；write 创建或整体覆写文件；str_replace 把文件中的 old_str 替换为 new_str',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', enum: ['list', 'view', 'write', 'str_replace'] },
            path: { type: 'string', description: '文件路径，如 index.html' },
            content: { type: 'string', description: 'write 时写入的完整内容' },
            old_str: { type: 'string' },
            new_str: { type: 'string' },
          },
          required: ['command'],
        },
      },
    },
    async run({ command, path, content, old_str, new_str }) {
      if (command === 'list') return fs.list().join('\n') || '(空)'
      if (command === 'view') {
        const c = fs.read(path as string)
        return c === null ? `Error: ${path} 不存在` : c
      }
      if (command === 'write') {
        await fs.write(path as string, content as string)
        return `已写入 ${path}（${String(content ?? '').length} 字符）`
      }
      if (command === 'str_replace') {
        const c = fs.read(path as string)
        if (c === null) return `Error: ${path} 不存在`
        if (!c.includes(old_str as string)) return `Error: 在 ${path} 中找不到 old_str`
        await fs.write(path as string, c.replace(old_str as string, (new_str as string) ?? ''))
        return `已编辑 ${path}`
      }
      return `Error: 未知命令 ${command}`
    },
  })
  ctx.effect(() => {
    ctx.logger.info('工具 file_editor 已注册')
    return unregister
  })
}

/** run_js：Web Worker 里执行 JS，对标 minimal 模式的 bash */
function runJsTool(ctx: Context): void {
  const tools = ctx.get('tools') as ToolsService
  const unregister = tools.register('run_js', {
    schema: {
      type: 'function',
      function: {
        name: 'run_js',
        description:
          '在浏览器 Web Worker 中执行 JavaScript 代码，返回 console 输出。用于验证逻辑、计算、调试。5 秒超时。',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string' } },
          required: ['code'],
        },
      },
    },
    run({ code }) {
      return new Promise<string>(resolve => {
        const src =
          'onmessage = async e => {' +
          'const out = [];' +
          'const fmt = x => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return String(x); } };' +
          'const con = { log: (...a) => out.push(a.map(fmt).join(" ")), error: (...a) => out.push(a.map(fmt).join(" ")), warn: (...a) => out.push(a.map(fmt).join(" ")) };' +
          'try { const r = new Function("console", e.data)(con); if (r && r.then) await r; }' +
          'catch (err) { out.push("Uncaught " + err.message); }' +
          'postMessage(out.join("\\n") || "(无输出)");' +
          '}'
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
        const w = new Worker(url)
        const timer = setTimeout(() => {
          w.terminate()
          URL.revokeObjectURL(url)
          resolve('Error: 执行超时（5s）')
        }, 5000)
        w.onmessage = e => {
          clearTimeout(timer)
          w.terminate()
          URL.revokeObjectURL(url)
          resolve(e.data)
        }
        w.onerror = e => {
          clearTimeout(timer)
          w.terminate()
          URL.revokeObjectURL(url)
          resolve('Error: ' + e.message)
        }
        w.postMessage(String(code ?? ''))
      })
    },
  })
  ctx.effect(() => {
    ctx.logger.info('工具 run_js 已注册（Web Worker 沙箱）')
    return unregister
  })
}
