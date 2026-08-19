# PoC 重构计划：组件即插件 + pi-ai 流式 + 工作台 UI

> 2026-08-19 定稿。目标：**simple and streamlined**——每个阶段都可独立验收，核心 JS 总量控制在 ~500 行内。
> 前置阅读：`调研结论详解.md`、`190023-kimi-designed-component-as-plugin.md`（组件化设计定稿，本计划的架构依据）、`190031`（框架选型封存：Vue 3 全构建）。

---

## 总体原则

1. **最大化吃 Vue 内置能力**：凡 Vue 平台原语能表达的（组件生命周期、props 校验、defineAsyncComponent、onErrorCaptured、Teleport、watch），一律不手写机制；
2. **每个阶段结束都是可演示状态**：P1 结束 = 现有功能全部还能跑；P2 结束 = 流式对话可用；P3 结束 = 完整工作台；
3. **单文件优先**：继续在 `app/index.html` + `vue.global.js` 上演进；任何需要构建工具链的东西不进 PoC；
4. **删减优先于新增**：每阶段先列"删什么"。

---

## P0 · 决策确认（开工前 5 分钟）

| 决策点 | 推荐默认 | 说明 |
|---|---|---|
| 单文件 vs Vite | **单文件** | self-modifying 需要运行时编译器，vue.global 现成 |
| pi-ai 引入方式 | **ESM CDN 动态 import + 本地兜底** | `await import('https://esm.sh/@earendil-works/pi-ai')`，失败回退到现有薄 adapter（离线可演示）；key 存 localStorage 不落 OPFS |
| OPFS 保留 | 保留 | 已写好能工作 |

如果用户对默认无异议，直接按此执行。

---

## P1 · 组件化内核重构（核心阶段）

### 删什么

- `createContext()` 整套（~40 行）——effectScope 内核被组件实例生命周期取代；
- widgets 独立注册表 + `<component :is>` 槽位——并入插件数组 + Teleport；
- inject 的 parent 链遍历（本来就是死代码）；
- session 插件的空壳——并入 loop 插件（messages 数组挂 loop 内部）。

### 建什么

**1.1 内核四件套（~120 行，全部为 Vue 原语的薄编排）**

```text
① services 注册表（~20 行）
   root setup: const services = reactive(new Map())  // name -> shallowRef(impl)
   provide('services', services)
   辅助: useService(name) = inject + computed(() => map.get(name)?.value)
   纪律: 插件注册服务 = 写 Map，onUnmounted 时删（对称性由组件生命周期保证）

② plugins 响应式数组 + PluginHost wrapper（~50 行）
   plugins = reactive([{ name, def, config, version, status, error }])
   根模板: <PluginHost v-for="p in plugins" :plugin="p" :key="p.name + ':' + p.version"/>
   PluginHost:
     - onErrorCaptured → p.status='failed', p.error=err, return false（故障隔离）
     - status 为 failed 时渲染错误卡片 + [重试] 按钮（重试 = version++）
     - 否则 <component :is="p.def" v-bind="p.config"/>

③ 动态插件加载器（~30 行）
   defineAsyncComponent({
     loader: async () => 读 OPFS .plugins/x.js → Blob import（含 new Function 降级）
           → 校验组件对象 → compile(template)（如有 template 字段）→ 注入 style（如有）
           → markRaw，
     loadingComponent: PendingCard, errorComponent: FailedCard, suspensible: false
   })

④ 事件总线（~40 行）
   bus = { on, emit, waterfall }   // waterfall 带 next() 短路语义
   插件内 useBus() 辅助：onUnmounted 自动摘除监听（注册即副作用）
```

**1.2 内置插件改写为组件（~150 行改写）**

| 现有插件 | 改写形态 | 备注 |
|---|---|---|
| fs | renderless 组件，setup 里建 OPFS 缓存 Map 并注册 `services.set('fs', ...)` | 加 `version(path)` 响应式版本号（为 HMR） |
| tools + 3 内置工具 | renderless 组件；工具表 `services.set('tools', reactiveMap)` | 工具注册 = 写 Map + onUnmounted 删 |
| llm | renderless 组件；`services.set('llm', { chat })` | P1 阶段仍是薄 adapter，P2 换流式 |
| loop | renderless 组件；持有 messages；watch llm 槽位就绪才可运行 | session 并入此处 |
| plugins 管理器 | renderless 组件；持有 plugins 数组的写权、create_plugin/remove_plugin 工具、启动时扫 OPFS 恢复 | HMR watcher 也在这里（1.3） |

宿主 shell UI（连接面板/对话/文件树/日志）保持现状，仅把"动态组件槽"换成 `<div id="plugin-panels">`，插件用 `<Teleport to="#plugin-panels">` 投 UI。

**1.3 简单 HMR（~40 行）**

- fs 插件：`write()/remove()` 成功后 `touch(path)` 版本自增（沿用 190014 第一层）；
- plugins 管理器：`watch(version('.plugins/x.js'), debounce(...))` → 读新源码 → `version++`（`:key` 变化整体重挂，工具/UI/监听随 unmount 全回收）；
- 编译/挂载失败 → 不进 plugins 数组替换，`status='failed'` 显示错误，**旧版继续跑**（回滚）；
- stretch（可不做）：template-only 变更走 `instance.render` 三行保状态热替换。

**1.4 产出设计文档（本阶段的硬性交付物）**

《设计文档：cordis 核心能力的 Vue 表达》，逐项对照，每项含" cordis 语义 → Vue 高层能力 → 代码位置（index.html 行号）"：

| cordis 核心能力 | Vue 高层表达 |
|---|---|
| Fiber 插件实例 + 状态机（PENDING/ACTIVE/FAILED） | 组件实例 + defineAsyncComponent 的 loading/error/onError |
| 注册即副作用 + 逆序回收 | 组件实例的 effect scope：watcher 随 unmount 停 + onUnmounted 清理 |
| 声明式 inject + 就绪驱动激活 | services 注册表 shallowRef 槽位 + useService 的 computed/watch 自动重跑 |
| Service DI 容器 | provide 单注入点 + reactive Map 注册表 |
| 配置（Config schema 校验） | props 声明（type/required/default/validator） |
| 配置更新重启 | `:key` 含 version，version++ 强制重挂 |
| 子上下文/作用域树 | 组件树 + provide 原型链（`Object.create(appContext.provides)`，逐字同构） |
| 错误隔离 | onErrorCaptured 错误边界（PluginHost） |
| 事件总线 + waterfall 拦截链 | 手搓 bus（唯一无平台对应物的能力，~40 行） |
| UI 槽位（对照 harness ui-slots） | Teleport 到命名面板 |
| HMR（cordis-hmr） | fs 版本 ref 感知 + `:key` 重挂 + Blob URL 天然 cache busting |
| 运行时造插件（harness Creator 模式） | create_plugin 工具 → OPFS → Blob import → push 进 plugins 数组 |

### P1 验收标准

1. 现有全部行为回归：连接 DeepSeek（非流式）→ 对话 → 工具调用 → `create_plugin` 造带 UI 插件 → 刷新后自动恢复；
2. 对话中改写插件源码 → 自动重挂，其旧 UI/工具消失、新版出现；
3. 写挂源码 → 旧版继续可用 + syslog 报错；
4. `remove_plugin` → 该插件的 UI（Teleport 内容）、工具、watcher 全部消失，DOM 无残留；
5. 设计文档写完并归档到 handoff 线程。

---

## P2 · pi-ai provider + 流式（第二阶段）

### 建什么

**2.1 pi-ai 接入层（~60 行）**

```js
// llm 插件内部
let pi = null
try { pi = await import('https://esm.sh/@earendil-works/pi-ai') } catch { /* 离线兜底 */ }
// 有 pi: 构造 openAICompletions provider（baseURL 可配，默认 deepseek）
// 无 pi: 回退现有薄 fetch adapter（非流式 → 合成单发 text 事件，接口不变）
```

统一对外接口：`llm.stream({ messages, tools, signal }) → AsyncIterable<event>`，事件归一化为 `{type: 'text_delta'|'toolcall'|'done'|'error', partial}`。BYOK：key 存 localStorage，UI 设置面板填一次。

**2.2 loop 流式化（~80 行改写）**

- 消息模型升级：`{ role, blocks: [{type:'text'|'thinking'|'toolcall', ...}], status: 'streaming'|'done'|'error' }`；
- 消费流：每个事件 `Object.assign(currentMsg, ev.partial)`（pi-ai 事件自带累积快照，不手拼 delta）；
- tool call 循环不变（最多 20 轮），关键节点过 waterfall：`llm/request`（可改请求）、`tools/pre-execute`（可否决）、`tools/post-execute`；
- **真停止**：AbortController，stop 按钮 = abort 当前流 + 终止 loop；
- LLM 报错以 `note` 块落会话（保持模型友好的错误回传）。

**2.3 对话 UI 流式化（~50 行）**

- 消息列表按 blocks 渲染：text 段落、thinking 折叠块、toolcall 卡片（名称 + 流式参数 + 执行状态 + 结果）；
- streaming 中的消息显示光标态；发送中输入框禁用、显示停止按钮。

### 删什么

- 旧的"⏳ agent 工作中…"假流式；
- 假 stop（置 flag 不取消请求）。

### P2 验收标准

1. 肉眼可见逐 token 输出；thinking 块折叠展示；
2. 流式中途点停止 → 请求立即中断（Network 面板可见 abort），loop 干净退出；
3. 工具调用卡片在流式过程中逐步成形，执行状态实时更新；
4. 断网/无 CDN 时自动回退薄 adapter，功能降级但可用；
5. 插件通过 `bus.waterfall('tools/pre-execute')` 能拦截并否决一次工具调用（写个演示插件验证）。

---

## P3 · 工作台：OPFS 布局 + 文件管理 + UI 重设计（可选，稍后）

### 3.1 OPFS 路径约定

```text
/config.json        全局配置：provider、baseURL、model、UI 偏好（**api key 不落盘**，只存 localStorage）
/plugins/*.js       动态插件源码（plugins 管理器只 watch 这个目录）
/workspace/**       agent 的工作文件（file_editor 工具的默认根）
```

理由：三个顶层命名空间职责单一；`/plugins` 是 HMR 唯一监听面；`/workspace` 是文件查看器的默认视图；配置与代码分离，导出 workspace 时不带配置。

### 3.2 文件查看器 + 导入导出（~80 行）

- 树形浏览 `/workspace`（递归，reactive 缓存驱动）；
- 点击 → 文本预览（图片走 Blob URL 预览）；简单 textarea 编辑 + 保存；
- 导入：文件选择/拖拽 → 写入 `/workspace`；
- 导出：单文件 download；「导出全部」打包为单个 JSON `{path: content}` 下载；导入 JSON 包可还原整套工作区（含 plugins，等于工作区迁移）。

### 3.3 UI 重设计（~120 行）

左侧 tab 栏切换四个面板，替代现在的五区块平铺：

| 面板 | 内容 |
|---|---|
| **对话** | P2 的流式 chat panel（主视图，占最大宽度） |
| **插件** | 插件树：名称 + 状态徽标（pending/active/failed）+ 每个插件的 [重载] [卸载] 按钮；failed 显示错误 + [重试]；展开可看其注册的服务/工具 |
| **文件** | 3.2 的查看器 |
| **日志** | reactive 日志数组渲染（顺手切断 `getElementById('syslog')` 耦合——日志插件只推数组，滚动逻辑进面板组件的 watchEffect） |

设置（provider/key/model）做成对话面板顶部的折叠条。

### P3 验收标准

1. 导入一个 JSON 包 → 插件、文件、配置全部就位，插件自动挂载；
2. 插件面板上点 [重载] 等价于改源码触发 HMR；点 [卸载] 后 UI/工具/watcher 无残留；
3. agent 在对话里写文件 → 文件面板实时出现（响应式白拿）。

---

## 风险与对策

| 风险 | 对策 |
|---|---|
| esm.sh 不可用 / pi-ai 浏览器包问题 | P2 的兜底 adapter 保证离线可演示；真机上先跑通最小 spike 再铺开 |
| Blob import 在 Safari 全挂 | `new Function` 降级（P1 加载器内置） |
| 组件化后 fs 未就绪时其他插件读文件 | useService 的 computed 判空 + PENDING 卡片；boot 顺序由 services 就绪驱动，不手写 |
| 单文件膨胀 | 三阶段结束核心 JS 预算 ~500 行；超出时优先砍功能不砍架构 |

## 工作量估计

| 阶段 | 净改动 | 性质 |
|---|---|---|
| P1 | ±100 行（删 ~150 增 ~250） | 重构为主 |
| P2 | +190 行 | 新增为主 |
| P3 | +200 行 | 纯增量，可延后 |
