# 设计文档：cordis 核心能力的 Vue 表达

> PoC 阶段 P1 交付物。2026-08-19 定稿（review 修复后修订）。
> 本文回答一个问题：**cordis 为 deepseek-harness 提供的每一项核心能力，在 `app/index.html` 里分别由 Vue 的什么内置能力承接。**
> 原则：能在 Vue 平台原语上表达的一律不手写机制；唯一完全手搓的是事件总线（Vue 无对应物）。代码位置以 `app/index.html` 当前行号为准。

---

## 对照总表

| cordis 核心能力 | cordis 语义 | Vue 高层表达 | 代码位置 |
|---|---|---|---|
| Fiber 插件实例 | `ctx.plugin()` 生成运行实例，父子成树 | **组件实例**：插件即组件选项对象，推入根 app 的 `plugins` 响应式数组，v-for 渲染即挂载 | L182-196（数组）、L123-126（模板 v-for） |
| Fiber 状态机 PENDING/ACTIVE/FAILED + 重试 | inject 不齐等待、激活、失败 | **预编译探针 + PluginHost 状态卡片**：编译失败不挂载（PENDING 等价）；运行期错误被错误边界捕获 → failed 卡片 + 重试按钮（version++ 重挂） | L199-219、L453-470 |
| 注册即副作用（registrations are effects） | 一切对外影响经 `ctx.effect` 登记，卸载逆序回收 | **组件实例的 effect scope**：watcher 随 unmount 自动停；`onUnmounted` 登记服务撤回/工具注销/监听摘除 | L149-157（provideService）、L354-364（工具注册） |
| 作用域树 + 级联回收 | Fiber 树，父死子亡 | **组件树**：卸载 = 从 plugins 数组移除 = unmount = watcher/DOM/子组件全自动回收 | L189-196（unmountPlugin） |
| Service DI 容器 | `ctx.provide/inject`，Context 原型链 | **单注入点 + 响应式注册表**：`shallowReactive(Map<string, shallowRef>)`，app.provide 一次，插件 `inject('services')` 取 | L148、L842-845 |
| 声明式 inject + 就绪驱动激活 | service 不齐挂 PENDING，就绪自动激活 | **shallowRef 槽位 + computed/watch 自动重跑**：`useService(name)` 返回 computed，服务出现/替换/消失自动传播——比 cordis 的手动 notify/epoch 更自动 | L154-156、L354-364（工具组件的就绪 watch） |
| 配置（Config schema 校验 + update 重启） | StandardSchema 校验，update 整体 restart | **props 声明**（type/required/default/validator 内置）+ `:key` 含 version，`version++` 强制重挂 | L123（key 与 v-bind） |
| 错误隔离 | 插件崩溃不拖死运行时 | **onErrorCaptured 错误边界**：PluginHost 捕获子树异常 → 标 failed → 错误卡片 + 重试 | L199-219 |
| 事件总线 emit/on + waterfall 拦截链 | 五种派发；waterfall 中间件可短路否决 | **手搓 bus（~30 行）**：emit/on + waterfall（`next()` 不调即短路，`return {veto}` 即否决）。唯一无 Vue 对应物的能力 | L159-181 |
| UI 槽位（对照 harness ui-slots） | 声明 = 渲染授权，disposer 坍缩子树 | **插件面板容器直接渲染**（Teleport 备用）：插件的 template 渲染到面板盒内；卸载即消失，零机制 | L121-127 |
| HMR（cordis-hmr） | 监视文件 → 清缓存 → 旧 config 重挂新代码 → 失败回滚 | **响应式内容即变更信号**（fs cache 是 reactive Map，watch 内容即可，无需 chokidar）+ 真试编译探针 + 换 def & version++ + 失败旧版继续跑 | L437-470 |
| 运行时造插件（Creator 模式） | agent 写源码 → 运行时编译挂载 → 持久化恢复 | `create_plugin` 元工具 → 试编译 → OPFS 落盘 → 推入 plugins 数组；启动时扫描恢复 | L252-259（编译器）、L471-520（管理器） |
| 异步 teardown（可 await 的 dispose） | disposer 可为 async/生成器，LIFO await | **PoC 不做**（用户决策）：unmount 同步走完即完成 | — |

## 关键设计决策

1. **插件形态 = 组件选项对象** `{ name?, props?, template?, setup }`：纯逻辑插件 = renderless 组件（`return () => null`），带 UI 插件写 template。plugin/widget 二元对立消失。（`style` 字段暂未实现。）
2. **DI 收敛为单注入点**：Vue provide 沿树向下而 cordis provide 向全局，兄弟插件互相够不着——根 app 只 provide 注册表本身，服务读写都走 `services` Map。
3. **注册表必须 `shallowReactive`**：`reactive(Map)` 会把存入的 ref/impl 深响应化并自动解包 impl 上的 ref 属性（review 实测确认），导致 `.value` 访问语义错乱——这是 Vue 响应式容器最容易踩的坑，选型时明确记录。
4. **PENDING/FAILED 不建 Suspense**（源码核实仍为 experimental）；defineAsyncComponent 曾被采用后简化为**预编译探针**——试编译在挂载前完成，编译失败可回滚（旧版继续跑），top-level 错误一并拦下；setup 期错误由 onErrorCaptured 兜底。
5. **HMR 的变更感知不需要文件监听**：所有写入经过自家 fs 插件，响应式 cache 的内容变化就是信号——cordis-hmr 的 chokidar 层整个消失；Blob URL 天然唯一 = 自带 import cache busting（含 Safari/CSP 的 `new Function` 降级）。
6. **唯一手搓：事件总线**。waterfall 是 agent loop 的扩展命脉（`llm/request`、`tools/pre-execute`、`tools/post-execute` 三个拦截点已在 loop 接线）。
7. **工具组件平级挂载**（不是 tools 的子组件）：经 tools 服务的就绪 watch 注册/注销，服务热替换时自动重注册——用响应式而非组件层级表达依赖。

## 已知取舍（PoC 阶段接受）

- unmount 同步，异步清理（Worker 终止等）fire-and-forget；
- HMR 不保组件内状态（默认重挂；render-only 保状态热替换留作 stretch）；
- 插件子树没有 isolate/realm（harness 也几乎没用）；
- 配置树组合（yml loader）不做，插件组合即代码；
- 核心 JS ~720 行，超 ~500 行预算，主要超在 SYSTEM_PROMPT 与双引擎 adapter，记账待 P3 后清理。

## 与 harness 架构的对应

harness 的浏览器端是"React UI + 内嵌 cordis Loader + 框架无关 store 桥接"三层；本 PoC 证明在 Vue 下这三层塌缩成一层——**组件系统同时是渲染层、插件生命周期层和状态同步层**。
