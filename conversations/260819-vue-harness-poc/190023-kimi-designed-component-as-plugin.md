# Handoff Note — 190023 · kimi · designed-component-as-plugin

## 继承的上下文

线程：`conversations/260819-vue-harness-poc/`。动手前先读：

1. `调研结论详解.md`——cordis 机制、Vue 映射、boilerplate 评估
2. `技术背景-为什么需要这些能力.md`——动机
3. `190005-kimi-researched-poc-roadmap.md`——PoC 总路线与非目标
4. `190014-kimi-drafted-opfs-hmr.md`——OPFS HMR 规格（**本篇会修订其第二、三层的实现形态**）

**本次新增的两条用户决策（覆盖前文的保守假设）**：

- **不强求 `.vue` SFC 形态**——插件格式按"组件对象"设计即可，SFC 编译降级为可选增强；
- **PoC 阶段同步 dispose 可接受**——异步 teardown 的手搓需求从"必补"降级为"知道即可"，不阻塞设计。

## 本次会话完成的工作（调研结论）

在 `ref_repos/vue-core/packages/runtime-core/src` 逐一核实了关键 API 的真实语义，有四个**超出此前认知的发现**：

### 发现 1：`defineAsyncComponent` 就是 cordis 的 Fiber 状态机（最大的发现）

`apiAsyncComponent.ts` 源码确认它内置：`loader`（异步加载）、`loadingComponent`（加载中占位）、`errorComponent`（失败占位）、`delay`、`timeout`、`onError(err, retry, fail, attempts)`（失败重试策略）。

逐条对照 cordis Fiber：`PENDING/LOADING` = loader pending + loadingComponent；`ACTIVE` = resolved；`FAILED` = errorComponent；`onError` 的 `retry()` = 重挂载。**Vue 自带了整个状态机，此前映射表里标"需手搓（中）"的插件状态机可以删掉。**注意 `suspensible: false` 可切断对 Suspense 的依赖（见发现 4）。

### 发现 2：组件树的 provide/inject 就是 cordis 的 Context 原型链

`component.ts:643`：`provides: parent ? parent.provides : Object.create(appContext.provides)`——原型链派生，和 cordis `ctx.extend()` 的 `Object.create` 逐字同构。另外 `app.runWithContext(fn)`（`apiCreateApp.ts:470`）允许在组件外用 app 上下文做 inject，补上了"非组件代码也要取服务"的口子。

### 发现 3：`onErrorCaptured` 是免费的错误边界

给每个插件组件包一层 wrapper，`onErrorCaptured(err => { 标记失败; return false })` 即插件级故障隔离——cordis 里"插件崩了不拖死运行时"的能力，一行钩子拿到。

### 发现 4：Suspense 至今仍是 experimental

`Suspense.ts:476` 源码里仍写着 "experimental feature and its API will likely change"。**核心架构不要建在 Suspense 上**；PENDING 语义用 defineAsyncComponent 自己的 loading/error 态实现（稳定 API）。

### 社区先例（辅助佐证）

- **Renderless component**（Adam Wathan 一脉；TinyVue 把整套组件逻辑做成 renderless 核、UI 另挂）验证了"逻辑住进组件、不渲染任何 markup"是成熟模式——纯逻辑插件 = renderless 组件有充足先例；
- **portal-vue → Teleport** 的演化史验证了"逻辑挂载点和视觉挂载点分离"的面板模式；
- **@vue/repl**（官方 SFC Playground）验证了浏览器内编译 `.vue` 可行——但按用户决策，降为可选增强，不进 PoC 主线。

---

## 设计空间：「组件即插件」的四个候选方案

| 方案 | 做法 | 判断 |
|---|---|---|
| **A. 插件即组件，挂在根 app 的插件列表**（推荐） | 插件 = 组件对象；根模板 `v-for` 动态组件挂载；纯逻辑插件 renderless；UI 走 Teleport 或槽位注册表 | ✅ 主方案，见下 |
| B. 每插件独立 `createApp` | 各自挂载到独立 DOM 节点 | ❌ 各 app 的 provide 链互不相通，service 共享要手动桥接，复杂度全在自己身上 |
| C. 维持 effectScope 内核，组件只用于 widget（现状） | 插件/widget 两套机制 | ❌ 保留为对照组；二元对立正是要消除的东西 |
| D. defineAsyncComponent 承担全部生命周期 | 插件加载器 = async loader，等待依赖就绪才 resolve | ⚠️ 部分吸收进 A（PENDING/FAILED 用它），但"依赖变了自动重跑"交给响应式而非 loader |

## 主方案（A）设计定稿

### 1. 插件形态

插件就是一个 `.js` 模块，`export default` 一个**组件选项对象**（穷人版 SFC，无需任何编译器扩展）：

```js
export default {
  name: 'weather-widget',
  props: { city: { type: String, default: '北京' } },   // = cordis Config，自带校验
  template: `<div>...</div>`,                            // 可选；没有就是 renderless 纯逻辑插件
  setup(props, ctx) {
    // ctx 是 Vue setup context；服务从注入的注册表取（见 3）
    // 返回渲染函数或 state；watcher/定时器随便建，unmount 全回收
  },
  style: `...`                                           // 可选，挂载时注入 <style>，卸载时移除
}
```

### 2. 挂载与卸载

根 app 模板维护一个响应式插件数组：

```html
<component v-for="p in plugins" :is="p.def" v-bind="p.config" :key="p.name + ':' + p.version"/>
```

- 挂载 = push；卸载 = 移除 → Vue 自动停掉该插件的全部 watcher、DOM、子组件（"注册即副作用"原生成立）；
- `:key` 含 version：配置整体重启 / HMR 重挂 = `version++`（= cordis `fiber.update` 的 restart 语义）；
- 每个插件套一个 wrapper 组件：`onErrorCaptured` 故障隔离 + 失败时显示错误卡片带重试按钮。

### 3. 服务 DI：一个注入点 + 响应式注册表

**关键认知**：Vue 的 provide 沿树向下，而 cordis 的 provide 往全局注册表去——插件组件在根列表里是兄弟关系，互相 provide 够不着。所以 DI 收敛为：

- 根 app 只 provide 一次：`provide('services', reactive(Map<string, shallowRef>))`；
- 插件注册服务 = 往 Map 写（挂载时写、卸载时删——用 `onUnmounted` 或 watchEffect cleanup 保证对称）；
- 消费服务 = `inject('services')` 后 `computed(() => services.get('llm')?.value)`——**shallowRef 槽位保证热替换自动传播**；
- 依赖未就绪 = 槽位为空；就绪驱动 = 消费者的 watchEffect 自动重跑（比 cordis 的手动 notify 更自动）。

这与 boilerplate 现状一致（inject parent 链本来就是死代码），但语义从"约定"升级为"唯一的注入点 + 注册表纪律"。

### 4. UI 面板：Teleport，零代码槽位系统

根布局声明面板区域（`<div id="slot-sidebar"></div>` 等）；插件想要面板就 `<Teleport to="#slot-sidebar">`。多个插件指向同一目标 = 自然堆叠；卸载 = Teleport 内容自动消失。对照 harness 的 ui-slots（声明 = 渲染授权、disposer 坍缩子树），**Teleport 用平台原语拿到了同一语义，连注册表都不用写**。如果后面需要"声明式、可检查、带标签排序"的槽位（对齐 ui-slots 的 ledger），再在面板上套一个响应式注册表，不急。

### 5. PENDING / FAILED：defineAsyncComponent 当状态机

每个插件组件用 `defineAsyncComponent` 包装：`loader` 负责从 OPFS 读源码 + import + （可选）等待声明的服务就绪；`loadingComponent` = PENDING 占位；`errorComponent` = FAILED 卡片（编译错/挂载异常）；`onError` 接重试。**Fiber 状态机零行自研**。设 `suspensible: false`，不碰 experimental 的 Suspense。

### 6. HMR 形态修订（覆盖 190014 的第二、三层）

- **script/setup 变了** → `version++`（`:key` 变化）整体重挂——等价 cordis-hmr 的"旧 config 重跑新代码"；
- **只改 template** → 重编译 render 赋给 `instance.render; renderCache=[]; update()`，组件内状态原地保留（不变）；
- 变更感知层（fs 版本 ref，~10 行）**不变**；
- KeepAlive 考察后**弃用**：它按组件身份缓存，key bump 后产生新缓存项，语义不匹配，反而增加内存管理负担。

### 7. PoC 不管的（按用户决策）

- 异步 teardown：unmount 同步走完即视为完成；Worker 终止这类异步清理 fire-and-forget；
- `.vue` SFC 编译：需要时接 `@vue/compiler-sfc`（lazy load ~1MB + import 重写 transform），格式上已预留 `{template, setup, style}` 三字段对齐 SFC 心智模型；
- 每 agent 作用域、权限审批、多前端。

## 当前状态

| 文件 | 状态 |
|---|---|
| 本 note | 新建 |
| `app/index.html` | 未动（仍是 effectScope 内核 + widgets 双注册表） |
| 190014 OPFS HMR 规格 | 第一层（fs 版本 ref）仍有效；第二三层被本篇 §6 修订 |

## 下一个 agent 的待办（按优先级）

1. **内核改造**：把 `app/index.html` 的 `createContext()` 换成组件化内核——响应式插件数组 + 根模板 v-for + wrapper（onErrorCaptured）+ services 注册表（§3）。现有七插件（fs/tools/llm/loop/session/plugins/widgets）逐个改写为组件选项对象；fs/llm 这类纯逻辑插件改 renderless。**widgets 注册表删除**，并入插件数组。
2. **defineAsyncComponent 包装层**：loader 读 OPFS + Blob import（保留 `new Function` 降级），loading/error 占位组件各一个，~40 行。
3. **Teleport 面板**：根布局加 1-2 个面板槽位，widgets 类插件改用 Teleport。
4. **OPFS HMR**：按本篇 §6 实施（变更感知沿用 190014 第一层；重挂 = version++；template-only 走 render-only）。
5. **验收**（沿用并修订 190014 的五条）：造插件 → 改 template 计数器不归零 → 改 setup 重挂归零 → 写挂源码 FAILED 卡片出现且旧版可点、点重试可恢复 → 卸载后 Teleport 面板、工具、watcher 全部消失。

## 关键决策

| 决策 | 理由 |
|---|---|
| 插件形态 = 组件选项对象 `{name, props, template?, setup, style?}` | 用户决策：不强求 SFC；三字段结构与 SFC 心智对齐，未来接 compiler-sfc 无缝 |
| PENDING/FAILED 用 defineAsyncComponent，不建 Suspense | 源码核实 Suspense 仍 experimental；async 组件的 loading/error/onError 是稳定 API 且语义逐条对齐 Fiber |
| DI 收敛为单注入点 + 响应式注册表 | provide 向下、cordis provide 向全局，兄弟插件间够不着；注册表方案与 boilerplate 现状连续 |
| 面板用 Teleport 而非自建槽位注册表 | 平台原语零代码拿到 ui-slots 语义；注册表留作需要标签/排序时的升级位 |
| 弃用 KeepAlive 做 HMR 保状态 | 按组件身份缓存，与 key bump 重挂语义不匹配 |
| 同步 dispose 可接受 | 用户决策：PoC 不为 async teardown 手搓编排层 |
| 废弃 widgets/plugin 双注册表 | 组件形态下二元对立消失，一套机制一套生命周期 |

## 阻塞项

- 待办 2 的老决策点仍未拍板：单文件演进 vs Vite 工程。本篇设计**在单文件 + vue.global 全构建下完全成立**（compile/template/Teleport/defineAsyncComponent 全可用）；迁 Vite 后仅 Blob import 的 `@vite-ignore` 注释和编译器别名需要调整。
- pi-ai 引入方式（npm/CDN/vendor）未定——不阻塞本篇任何待办。

## 建议的下一步

按待办 1 把 `app/index.html` 内核组件化（预计净改动 ±100 行，删掉 widgets 注册表和 createContext 后可能不增反减），跑通后再依次做 2→3→4。
