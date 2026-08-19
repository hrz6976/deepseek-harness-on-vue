# Handoff Note — 190031 · kimi · researched-framework-choice

## 继承的上下文

线程：`conversations/260819-vue-harness-poc/`。前置文档：`调研结论详解.md`、`技术背景-为什么需要这些能力.md`、`190005`（总路线）、`190014`（OPFS HMR 规格）、`190023`（组件即插件设计，当前主方案）。

本篇回答的问题：**React 用于这个浏览器内 self-modifying agent 是否比 Vue 合适？有没有其他备选？**（选型标准：选前端框架是因为 cordis 的核心功能很像前端框架——所以要选的是"谁的生命周期系统能兼任 cordis"，不是选渲染器。）

## 本次会话完成的工作（调研结论）

### 决定性事实：harness 自己就是"React UI + 内嵌 cordis"

`grep -rln "cordis" packages/client/*/package.json` 确认 `packages/client/` 下几乎所有包（connection、runtime、modules、hmr、全部 `ui-*`）都依赖 cordis。`packages/client/modules/README.md` 原文：web shell "mounts the **vendored cordis Loader** for entry governance (fiber lifecycle, inject waiting, update/refresh)"。

含义：**DeepSeek 在浏览器里用 React 做 UI，但 React 的组件生命周期没能承担插件管理，于是往浏览器里又塞了一个 cordis**；UI 与插件生命周期之间靠框架无关的 store 抽象（`getSnapshot`/`subscribe`，见 `ui-slots` README）桥接。选 React = 重走这条路：手搓 scope 树/DI/就绪调度/状态机，React 只当渲染器。

### React vs Vue 逐维对比（仅 cordis 核心需求）

| 维度 | Vue | React |
|---|---|---|
| 组件外作用域原语 | `effectScope()` 独立存在、可 stop、可嵌套树 | 不存在；useEffect 绑死组件 |
| 注册即副作用 | `onScopeDispose` 随处可用 | cleanup 只能在 useEffect；逻辑插件需挂 renderless 组件硬凑 |
| 状态→UI | 细粒度响应式白拿；流式 delta 直写 | 无响应式；`useSyncExternalStore` + selector 手订阅 + 不可变纪律 |
| 运行时 HMR 保状态 | 迷你 HMR 三行（换 `instance.render`） | Fast Refresh 依赖构建工具链，无构建浏览器不可用；只能手搓壳组件间接层 |
| 状态机/错误边界 | `defineAsyncComponent` + `onErrorCaptured` | `React.lazy`+Suspense 稳定；错误边界还是 class（或引库） |
| 运行时模板 | 需带编译器构建（已有 vue.global，166KB，成本已付） | 不需要编译器（唯一真实优势，但已被抵消） |
| DI | 向下树 → 收敛注册表 | 同左，打平 |
| LLM 亲和 | 可变响应式容错高 | agent 自写代码须守不可变纪律，更易错 |

### 其他备选评估

| 备选 | 评估 | 结论 |
|---|---|---|
| **Solid** | 理念最像 cordis：`createRoot`→dispose、`onCleanup`、`getOwner` 拥有者树 ≈ fiber 树，细粒度无 vdom。致命伤：JSX 需编译，浏览器无构建环境无官方运行时编译路径，"运行时造组件"每步自己扛；生态与 LLM 覆盖弱 | 理念满分、工程不可行；若未来迁 Vite 工程可重议 |
| **Svelte 5** | runes 有独立 `effect_root`；但组件是编译产物（class），浏览器内造组件要拖 `svelte/compiler`，组件即插件形态不自然 | 排除 |
| **Angular** | 分层注入器是所有框架中最像 cordis Context/isolate 的 DI，`DestroyRef` 完整；但太重、无构建浏览器形态不现实 | 排除 |
| **仅 `@vue/reactivity` + 自研 UI** | 省渲染器但丢掉组件即插件全部红利（Teleport/错误边界/async 状态机/迷你 HMR），等于退回手搓 | 排除 |
| Preact signals / Web Components / RxJS 系 | 无 scope 树或无响应式 | 直接排除 |

## 结论（已封存的选型决策）

**维持 Vue。** 理由链：cordis 内核 = 作用域生命周期 + 依赖就绪 + 拦截扩展；Vue reactivity + 组件实例能整套兼任（190023 已逐项验证并定稿组件化方案）；React 不能（harness 被迫内嵌 cordis 是直接证据）；Solid 理念能但工具链不能。

**此决策下游锁定**：所有 PoC 设计以 Vue 3（`vue.global` 全构建）为唯一运行时；不再评估框架迁移，除非 PoC 毕业后迁 Vite 工程时重开评估（届时 Solid 可重新纳入候选）。

## 当前状态

| 文件 | 状态 |
|---|---|
| 本 note | 新建，选型决策封存 |
| `app/index.html` | 未动 |
| 190023 组件化设计 | 仍是当前实施蓝图，待办 1-5 不变 |

## 下一个 agent 的待办

不变，以 `190023-kimi-designed-component-as-plugin.md` 的待办 1-5 为准：① 内核组件化（响应式插件数组 + wrapper + services 注册表，删除 widgets 双注册表）→ ② defineAsyncComponent 包装层 → ③ Teleport 面板 → ④ OPFS HMR（变更感知沿用 190014 第一层）→ ⑤ 五条验收。

## 关键决策

| 决策 | 理由 |
|---|---|
| 框架锁定 Vue 3 | harness 内嵌 cordis 证明 React 生命周期系统不能兼任插件内核；Vue 能 |
| React 的"无需编译器"优势不成立 | vue.global 全构建成本已付，模板编译白拿 |
| Solid 记录为"迁 Vite 时唯一可重议项" | 理念匹配但无构建环境不可用，避免未来重复调研 |

## 阻塞项

- 单文件 vs Vite 工程仍未拍板（190005 待办 2）；本篇结论默认单文件 + vue.global。
- pi-ai 引入方式未定；不阻塞内核组件化。

## 建议的下一步

按 190023 待办 1 对 `app/index.html` 做内核组件化改造。
