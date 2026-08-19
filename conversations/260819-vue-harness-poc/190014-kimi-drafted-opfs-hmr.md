# Handoff Note — 190014 · kimi · drafted-opfs-hmr

## 继承的上下文

线程：`conversations/260819-vue-harness-poc/`。动手前先读：

1. `调研结论详解.md`——cordis 机制、Vue 映射、boilerplate 逐模块评估
2. `190005-kimi-researched-poc-roadmap.md`——PoC 总路线、六条设计哲学、非目标清单、待你拍板的两个决策点（单文件 vs Vite；pi-ai 引入方式）
3. `技术背景-为什么需要这些能力.md`——动机文档

**PoC 定位（用户原话）**：proof of concept，只在核心思路上保留 cordis 设计哲学，不需要 API 粒度对齐。

## 本次会话完成的工作

- [x] 评估「OPFS 上的 HMR：文件变了自动重载组件」的可行性——结论：可行，且比常规 HMR 简单（所有写入经过自家 fs 插件，不需要系统级文件监听）
- [x] 验证 FileSystemObserver API 现状（Chrome 已支持，Safari/Firefox 无）——结论：PoC 不需要它，带内事件足够
- [x] 产出三层设计方案（见下"功能规格"），写成本 note 待实施

## 功能规格：OPFS HMR

**目标**：`.plugins/` 下的插件源码或 widget 组件文件被改写后，对应插件/组件自动重载，不需要用户手动重挂。

**改动范围**：全部落在 `app/index.html` 现有的两个插件里——fs 插件（L159-212）和 plugins 管理器（L234-335）。**不需要动插件内核**。总量估计 60-70 行。

### 第一层：变更感知（~10 行，必做）

fs 插件里给每个路径维护响应式版本号：

```js
const versions = new Map()  // path -> ref<number>
function touch(path) { 
  const r = versions.get(path); 
  r ? r.value++ : versions.set(path, ref(1)) 
}
function version(path) {  // 供 watch 用
  if (!versions.has(path)) versions.set(path, ref(0))
  return versions.get(path)
}
```

`write()` / `remove()` 落盘成功后调 `touch(path)`。服务接口暴露 `version(path)`。
**不要**用 FileSystemObserver（Chrome-only，PoC 无外部改动场景）；**不要**轮询（有带内信号就够了）。

### 第二层：重载编排（~30 行，必做）

plugins 管理器里，对每个已挂载的动态插件 `dyn:{name}` 起一个 watcher：

```js
watch(version(`.plugins/${name}.js`), debounce(async () => {
  const source = await fs.read(`.plugins/${name}.js`)
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    const mod = await import(/* @vite-ignore */ url)   // Blob URL 天然唯一 = 自带 cache busting
    if (typeof mod.default !== 'function') throw new Error('插件需 export default function(ctx)')
    const oldConfig = configs.get(name)                 // cordis-hmr 语义：用旧 config 重挂新代码
    await ctx.dispose(`dyn:${name}`)                    // 级联回收旧 fiber 的工具/UI/监听
    await ctx.plugin(`dyn:${name}`, mod.default, oldConfig)
  } catch (e) {
    log(`[hmr] ${name} 重载失败，旧版本继续运行: ${e.message}`)  // 回滚语义：不动旧 fiber
  } finally {
    URL.revokeObjectURL(url)   // 注意：确认 import 完成后才 revoke
  }
}, 200))
```

要点：① debounce 200ms 防连续写入抖动；② 失败时**旧版本必须继续跑**（agent 改自己代码改挂了是常态，回滚是刚需）；③ `revokeObjectURL` 释放旧 URL 防内存泄漏；④ watcher 本身要用 `ctx.effect` 登记，插件被 `remove_plugin` 卸载时 watcher 随之回收（注册即副作用）。

### 第三层：render-only 热替换（~25 行，可选增强）

如果变更的插件只改了 widget 组件的 **template**（setup 逻辑没变），不重挂组件、原地换 render 函数以保留组件内状态：

```js
// vue.global 是全构建，自带编译器
const { compile } = Vue
const newRender = compile(newTemplate)
instance.render = newRender
instance.renderCache = []
instance.update()   // setup 状态原地保留
```

setup 逻辑变了则退回第二层整体重挂。**判定"只改了 template"在 PoC 里可以简化**：约定 widget 插件导出 `{ template, setup }` 结构，template 字符串比对不同、setup 源码比对相同 → 走 render-only；否则整体重挂。

### 顺带修复（同一个 PR 里做掉）

- `import(blob:)` 的 `new Function` 降级（Safari/严格 CSP，~10 行）：`new Function('ctx', '"use strict"; return (' + source 改写 + ')')` 形态，失去 ESM 语法但保住功能；
- `ctx.log` 切断 `getElementById('syslog')` 耦合：log 只推 reactive 数组，滚动挪进宿主组件的 watchEffect（~5 行）。

### 验收标准

1. 对话中让 agent 用 `create_plugin` 造一个带计数器 widget 的插件 → 点几下计数器（状态 = 5）；
2. 让 agent 改写该插件的 template（比如改按钮文字）→ **计数器保持 5**（render-only 路径生效）；
3. 让 agent 改写 setup 逻辑 → 组件重挂，计数器归零但功能正常（整体重载路径）；
4. 让 agent 写一段有语法错误的插件源码 → syslog 出现 `[hmr] 重载失败`，**旧版本 UI 仍在且能点**（回滚生效）；
5. `remove_plugin` 卸载后，再改 OPFS 里的源码文件 → 不再触发任何重载（watcher 已回收）。

## 关键决策

| 决策 | 理由 |
|---|---|
| 变更感知用响应式版本 ref，不用 FileSystemObserver / 轮询 | 所有写入经过自家 fs 插件，带内信号零成本且跨浏览器；FileSystemObserver Chrome-only 且 PoC 无外部改动场景 |
| 默认不保状态，纪律是"状态放 service、插件体无状态" | cordis 自己的哲学；render-only 热替换只覆盖 template-only 变更的窄场景 |
| 重载失败旧版本继续跑 | cordis-hmr 的回滚语义；agent 自改代码出错是常态 |
| 不动插件内核 | 三层全部落在 fs 插件和 plugins 管理器内，符合"一切皆插件"——HMR 自己也是插件能力而非内核特权 |

## 阻塞项

- 待办 2 的决策点仍未拍板（单文件 vs Vite 工程）。**本功能默认在单文件 `app/index.html` 上演进**——若用户决定重开 Vite 工程，第一层和第二层原样迁移，第三层的 `compile` 需确认构建包含编译器（或直接用 `vue/dist/vue.esm-bundler.js`）。

## 建议的下一步

在 `app/index.html` 上按第一、二层 + 顺带修复实施（第三层可作为第二个 commit），跑通五条验收标准后写下一篇 handoff note。
