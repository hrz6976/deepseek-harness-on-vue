import { describe, expect, it } from 'vitest'
import { createRootContext } from '../src/runtime'
import { BrowserPluginManager } from '../src/loader/manager'
import { MemorySourceStore } from '../src/loader/source-store'
import { DataUrlCompiler } from '../src/loader/compiler'

function setup() {
  const root = createRootContext()
  const store = new MemorySourceStore()
  const manager = new BrowserPluginManager({
    host: root,
    store,
    compiler: new DataUrlCompiler(),
  })
  return { root, store, manager }
}

const pluginWithService = (key: string, value: string) => `
export default function (ctx) {
  ctx.provide(${JSON.stringify(key)}, ${JSON.stringify(value)})
}
`

describe('BrowserPluginManager 事务性热重载', () => {
  it('install：编译 → 挂载 → 验证 → 提交 OPFS', async () => {
    const { root, store, manager } = setup()
    await manager.install('alpha', pluginWithService('alpha-svc', 'v1'))
    expect(root.get('alpha-svc')).toBe('v1')
    const record = manager.catalog.get('alpha')!
    expect(record.status).toBe('active')
    expect(record.revision).toBe(1)
    expect((await store.list()).map(p => p.id)).toContain('alpha')
    await manager.dispose()
  })

  it('install 语法错误：不留记录、不持久化', async () => {
    const { store, manager } = setup()
    await expect(manager.install('bad', 'this is not js')).rejects.toThrow()
    expect(manager.catalog.has('bad')).toBe(false)
    expect((await store.list()).length).toBe(0)
  })

  it('update 语法错误：旧插件继续运行，store 保持旧源码', async () => {
    const { root, store, manager } = setup()
    await manager.install('alpha', pluginWithService('alpha-svc', 'v1'))
    await expect(manager.update('alpha', 'not valid js')).rejects.toThrow()
    const record = manager.catalog.get('alpha')!
    expect(record.status).toBe('failed')
    expect(record.error).toMatch(/编译失败/)
    expect(root.get('alpha-svc')).toBe('v1')
    const stored = (await store.list()).find(p => p.id === 'alpha')!
    expect(stored.source).toContain('v1')
    await manager.dispose()
  })

  it('update 挂载抛异常：自动回滚旧版本', async () => {
    const { root, manager } = setup()
    await manager.install('alpha', pluginWithService('alpha-svc', 'v1'))
    const boom = `export default function () { throw new Error('mount boom') }`
    await expect(manager.update('alpha', boom)).rejects.toThrow()
    const record = manager.catalog.get('alpha')!
    expect(record.status).toBe('failed')
    expect(record.error).toMatch(/已回滚到 revision 1/)
    expect(root.get('alpha-svc')).toBe('v1')
    await manager.dispose()
  })

  it('update 成功：revision+1，旧 fiber 卸载，新服务生效，源码落盘', async () => {
    const { root, store, manager } = setup()
    await manager.install('alpha', pluginWithService('alpha-svc', 'v1'))
    await manager.update('alpha', pluginWithService('alpha-svc', 'v2'))
    const record = manager.catalog.get('alpha')!
    expect(record.status).toBe('active')
    expect(record.revision).toBe(2)
    expect(root.get('alpha-svc')).toBe('v2')
    const stored = (await store.list()).find(p => p.id === 'alpha')!
    expect(stored.source).toContain('v2')
    await manager.dispose()
  })

  it('disable 与 enable：卸载运行实例并可恢复', async () => {
    const { root, store, manager } = setup()
    await manager.install('alpha', pluginWithService('alpha-svc', 'v1'))
    await manager.disable('alpha')
    expect(root.get('alpha-svc')).toBeUndefined()
    expect(manager.catalog.get('alpha')!.status).toBe('disabled')
    expect((await store.list()).find(p => p.id === 'alpha')!.enabled).toBe(false)
    await manager.enable('alpha')
    expect(root.get('alpha-svc')).toBe('v1')
    expect(manager.catalog.get('alpha')!.status).toBe('active')
    await manager.dispose()
  })

  it('remove：卸载并从 store 删除', async () => {
    const { root, store, manager } = setup()
    await manager.install('alpha', pluginWithService('alpha-svc', 'v1'))
    await manager.remove('alpha')
    expect(root.get('alpha-svc')).toBeUndefined()
    expect(manager.catalog.has('alpha')).toBe(false)
    expect((await store.list()).length).toBe(0)
    await manager.dispose()
  })

  it('restore：从 store 收敛 desired state；坏插件标记 failed 不阻断其他', async () => {
    const store = new MemorySourceStore()
    await store.commit('good', pluginWithService('good-svc', 'g'), true)
    await store.commit('broken', 'not js', true)
    await store.commit('off', pluginWithService('off-svc', 'o'), false)

    const root = createRootContext()
    const manager = new BrowserPluginManager({ host: root, store, compiler: new DataUrlCompiler() })
    await manager.restore()

    expect(root.get('good-svc')).toBe('g')
    expect(manager.catalog.get('good')!.status).toBe('active')
    expect(manager.catalog.get('broken')!.status).toBe('failed')
    expect(manager.catalog.get('off')!.status).toBe('stored')
    expect(root.get('off-svc')).toBeUndefined()
    await manager.dispose()
  })

  it('并发 update：串行收敛，最终状态以最后一次为准', async () => {
    const { root, manager } = setup()
    await manager.install('alpha', pluginWithService('alpha-svc', 'v1'))
    const p1 = manager.update('alpha', pluginWithService('alpha-svc', 'v2'))
    const p2 = manager.update('alpha', pluginWithService('alpha-svc', 'v3'))
    await Promise.all([p1, p2])
    expect(root.get('alpha-svc')).toBe('v3')
    expect(manager.catalog.get('alpha')!.revision).toBe(3)
    await manager.dispose()
  })

  it('syncFromExternal：内容相同跳过，不同则热重载', async () => {
    const { root, manager } = setup()
    const src = pluginWithService('alpha-svc', 'v1')
    await manager.install('alpha', src)
    await manager.syncFromExternal('alpha', src)
    expect(manager.catalog.get('alpha')!.revision).toBe(1)
    await manager.syncFromExternal('alpha', pluginWithService('alpha-svc', 'v2'))
    expect(root.get('alpha-svc')).toBe('v2')
    await manager.dispose()
  })
})

describe('非法输入', () => {
  it('插件名校验', async () => {
    const { manager } = setup()
    await expect(manager.install('1bad', 'export default function(){}')).rejects.toThrow(/插件名/)
    await expect(manager.install('bad name', 'export default function(){}')).rejects.toThrow(/插件名/)
  })
})
