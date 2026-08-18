import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { FiberStatus, createRootContext, type Context } from '../src/runtime'

/** 等 cordis 的异步加载/卸载与依赖通知全部收敛 */
async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await nextTick()
    await new Promise(r => setTimeout(r, 0))
  }
}

describe('service ownership', () => {
  it('重复提供同名 service 抛错', async () => {
    const root = createRootContext()
    const a = root.plugin({
      name: 'A',
      apply: (ctx: Context) => {
        ctx.provide('svc', 'A')
      },
    })
    await a
    expect(root.get('svc')).toBe('A')

    const b = root.plugin({
      name: 'B',
      apply: (ctx: Context) => {
        ctx.provide('svc', 'B')
      },
    })
    await expect(b).rejects.toThrow(/registered/)
    await a.dispose()
  })

  it('provider 卸载只撤回自己的 service，不残留', async () => {
    const root = createRootContext()
    const a = root.plugin({
      name: 'A',
      apply: (ctx: Context) => {
        ctx.provide('svc', 'A')
      },
    })
    await a
    expect(root.get('svc')).toBe('A')
    await a.dispose()
    expect(root.get('svc')).toBeUndefined()
  })
})

describe('异步生命周期', () => {
  it('async setup：await fiber 等待进入 active', async () => {
    const root = createRootContext()
    let phase = 'init'
    const fiber = root.plugin({
      name: 'p',
      apply: async (ctx: Context) => {
        await new Promise(r => setTimeout(r, 10))
        phase = 'setup-done'
        ctx.provide('x', 42)
      },
    })
    expect(fiber.state).toBe(FiberStatus.LOADING)
    await fiber
    expect(fiber.state).toBe(FiberStatus.ACTIVE)
    expect(phase).toBe('setup-done')
    expect(root.get('x')).toBe(42)
    await fiber.dispose()
  })

  it('async cleanup：dispose 等待异步清理完成', async () => {
    const root = createRootContext()
    let cleaned = false
    const fiber = root.plugin({
      name: 'p',
      apply: () => async () => {
        await new Promise(r => setTimeout(r, 10))
        cleaned = true
      },
    })
    await fiber
    await fiber.dispose()
    expect(cleaned).toBe(true)
  })

  it('setup 抛异常：state=failed', async () => {
    const root = createRootContext()
    const fiber = root.plugin({
      name: 'p',
      apply: async (ctx: Context) => {
        ctx.effect(() => () => {
          throw new Error('cleanup boom')
        })
        await new Promise(r => setTimeout(r, 5))
        throw new Error('boom')
      },
    })
    await expect(fiber).rejects.toThrow('boom')
    await settle()
    expect(fiber.state).toBe(FiberStatus.FAILED)
    expect(root.get('x')).toBeUndefined()
  })

  it('慢 setup 期间 dispose：插件不会进入 active', async () => {
    const root = createRootContext()
    const fiber = root.plugin({
      name: 'p',
      apply: async (ctx: Context) => {
        await new Promise(r => setTimeout(r, 20))
        ctx.provide('late', true)
      },
    })
    await new Promise(r => setTimeout(r, 5))
    await fiber.dispose()
    await settle()
    expect(fiber.state).not.toBe(FiberStatus.ACTIVE)
    expect(root.get('late')).toBeUndefined()
  })
})

describe('声明式 inject / PENDING 生命周期', () => {
  function llmProvider(name: string) {
    return (ctx: Context): void => {
      ctx.provide('llm', { name })
    }
  }

  it('依赖缺失 pending；出现挂载；消失卸载；provider 更换重载', async () => {
    const root = createRootContext()
    let setups = 0
    let cleanups = 0
    const fiber = root.plugin({
      name: 'consumer',
      inject: ['llm'],
      apply: () => {
        setups++
        return () => {
          cleanups++
        }
      },
    })
    await settle()
    expect(fiber.state).toBe(FiberStatus.PENDING)
    expect(setups).toBe(0)

    const a = root.plugin({ name: 'llm-a', apply: llmProvider('A') })
    await a
    await settle()
    expect(fiber.state).toBe(FiberStatus.ACTIVE)
    expect(setups).toBe(1)

    await a.dispose()
    await settle()
    expect(fiber.state).toBe(FiberStatus.PENDING)
    expect(cleanups).toBe(1)

    const b = root.plugin({ name: 'llm-b', apply: llmProvider('B') })
    await b
    await settle()
    expect(fiber.state).toBe(FiberStatus.ACTIVE)
    expect(setups).toBe(2)

    await b.dispose()
    await fiber.dispose()
  })

  it('嵌套链：依赖的依赖逐层收敛', async () => {
    const root = createRootContext()
    const mid = root.plugin({
      name: 'mid',
      inject: ['base'],
      apply: (ctx: Context) => {
        ctx.provide('mid-svc', 1)
      },
    })
    const leaf = root.plugin({
      name: 'leaf',
      inject: ['mid-svc'],
      apply: () => {},
    })
    await settle()
    expect(mid.state).toBe(FiberStatus.PENDING)
    expect(leaf.state).toBe(FiberStatus.PENDING)

    const base = root.plugin({
      name: 'base',
      apply: (ctx: Context) => {
        ctx.provide('base', 1)
      },
    })
    await base
    await settle()
    expect(mid.state).toBe(FiberStatus.ACTIVE)
    expect(leaf.state).toBe(FiberStatus.ACTIVE)

    await base.dispose()
    await mid.dispose()
    await leaf.dispose()
  })
})
