import type { BrowserPluginManager } from '@agentkit/runtime'

/** 全局 service 注册表的类型视图（动态插件也可注册约定外 key，故 inject 保留 string 重载） */

export interface FsChangeEvent {
  path: string
  content: string | null // null = 删除
}

export interface FsService {
  readonly ready: Promise<void>
  read(path: string): string | null
  list(): string[]
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
  clear(): Promise<void>
  subscribe(listener: (e: FsChangeEvent) => void): () => void
}

export interface ToolDefinition<A = Record<string, unknown>> {
  schema: Record<string, unknown>
  run(args: A): Promise<string> | string
}

export interface ToolsService {
  schemas(): Record<string, unknown>[]
  call(name: string, args: Record<string, unknown>): Promise<string>
  /** 返回 unregister；token 语义：只撤自己的注册，不误删覆盖者 */
  register(name: string, def: ToolDefinition): () => void
  list(): string[]
}

export interface WidgetsService {
  entries(): [string, unknown][]
  register(name: string, comp: unknown): () => void
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'note'
  content: string
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

export interface SessionService {
  messages: ChatMessage[]
  append(m: ChatMessage): void
  clear(): void
}

export interface LoopService {
  run(goal: string): Promise<void>
  stop(): void
}

export interface LlmService {
  name: string
  chat(messages: unknown[], tools: unknown[]): Promise<{
    content: string | null
    tool_calls?: { id: string; function: { name: string; arguments: string } }[]
  }>
}

export interface Services {
  fs: FsService
  tools: ToolsService
  widgets: WidgetsService
  session: SessionService
  loop: LoopService
  llm: LlmService
  plugins: BrowserPluginManager
}
