/**
 * 运行时直接使用官方 `@deepseek-ai/cordis`（DeepSeek Harness vendor 版）。
 *
 * 这里只做一件事：把它作为 `@agentkit/runtime` 的公共运行时底座重新导出，
 * 并补充一个稳定的 Fiber 状态常量（避免向浏览器代码泄露 cordis 的 const enum）。
 */
import { Context } from '@deepseek-ai/cordis'

export { Context, Fiber, Service } from '@deepseek-ai/cordis'
export type {
  Disposable,
  Effect,
  Exporter,
  Inject,
  Logger,
  LoggerService,
  Message,
  Plugin,
} from '@deepseek-ai/cordis'

/**
 * Cordis `FiberState` 的运行时值映射。
 *
 * `@deepseek-ai/cordis` 用 `const enum` 暴露状态，在 `isolatedModules` 下
 * 不便跨包作为值使用，因此这里保留一份只读常量，数值与官方定义一致：
 * PENDING=0, LOADING=1, ACTIVE=2, FAILED=3, DISPOSED=4, UNLOADING=5。
 */
export const FiberStatus = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

export type FiberStatus = (typeof FiberStatus)[keyof typeof FiberStatus]

/** 创建 cordis 根上下文。 */
export function createRootContext(): Context {
  return new Context()
}
