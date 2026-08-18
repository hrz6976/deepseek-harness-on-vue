import type { Context } from '../runtime'

/**
 * PluginCompiler：源码 → 可挂载模块。
 * v0.1 限制：单文件 ESM、不允许相对 import，依赖一律走 ctx capability。
 */

export interface CompiledPlugin {
  default: PluginFn
}

/** 动态插件入口：与 cordis 函数插件的 `apply(ctx)` 保持一致。 */
export type PluginFn = (ctx: Context) => unknown

export interface PluginCompiler {
  compile(id: string, source: string): Promise<CompiledPlugin>
}

function validate(id: string, mod: Record<string, unknown>): CompiledPlugin {
  if (typeof mod.default !== 'function') {
    throw new Error(`插件 ${id} 必须 export default function (ctx)`)
  }
  return mod as unknown as CompiledPlugin
}

/** 浏览器：Blob URL + 原生 dynamic import */
export class BlobCompiler implements PluginCompiler {
  async compile(id: string, source: string): Promise<CompiledPlugin> {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      const mod = await import(/* @vite-ignore */ url)
      return validate(id, mod)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

/** Node/测试：data: URL import（Node ESM 原生支持） */
export class DataUrlCompiler implements PluginCompiler {
  async compile(id: string, source: string): Promise<CompiledPlugin> {
    const mod = await import(/* @vite-ignore */ `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`)
    return validate(id, mod)
  }
}
