import type { Context } from '@agentkit/runtime'
import type { LlmService } from '../services/types'

export interface LlmConfig {
  baseURL: string
  model: string
  apiKey: string
}

/** llm 插件工厂：OpenAI 兼容适配器。换模型 = 卸载旧 fiber + 挂载新 fiber（provider identity 变更） */
export function makeLlmPlugin(cfg: LlmConfig) {
  return function llmPlugin(ctx: Context): void {
    const adapter: LlmService = {
      name: cfg.model,
      async chat(messages, tools) {
        const res = await fetch(cfg.baseURL.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
          body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: 'auto' }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
        const data = await res.json()
        return data.choices[0].message
      },
    }
    ctx.provide('llm', adapter)
    ctx.effect(() => {
      ctx.logger.info(`llm 插件已挂载（${cfg.model}）`)
      return () => ctx.logger.warn('llm 插件已卸载')
    })
  }
}
