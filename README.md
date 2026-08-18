# agentkit

浏览器里的 self-modifying coding agent。这个仓库是一个 Bun workspace，按职责拆成三层：

```text
packages/runtime   # 官方 @deepseek-ai/cordis 运行时 + 浏览器 loader/reconciler
packages/plugins   # 插件生态：fs/tools/widgets/session/loop/llm/meta-tools
apps/web-demo      # demo：宿主装配 + Vue UI
```

核心体验是：agent 可以在浏览器里现场给自己造插件（`create_plugin`），源码持久化到 OPFS，刷新后自动恢复；同名更新会走事务性热重载，失败自动回滚旧版本。

调研笔记见 `调研报告-Self-Modifying-Agent寄生任意Vue网站.md`。

## 命令

```bash
bun install
bun run dev        # 启动 apps/web-demo 开发服务器
bun run test       # 运行 packages/runtime 的单测
bun run typecheck  # 对 runtime、plugins、web-demo 分别做类型检查
bun run build      # 构建 apps/web-demo
```

## 项目边界

### packages/runtime

运行时与浏览器加载器，不包含业务插件、Vue SFC 或宿主装配。公共入口是 `src/index.ts`：

- `src/runtime`：直接复用官方 `@deepseek-ai/cordis`，补齐稳定的 `FiberStatus` 常量
- `src/loader`：插件目录、编译器、事务性 reconciler、source store、manager
- `src/types/opfs.ts`：浏览器文件系统类型补丁
- `tests`：runtime 与 reconciler 的单元测试

### packages/plugins

构建在 `@agentkit/runtime` 之上的内置插件生态：

- `fs`：OPFS 持久化文件系统
- `tools`：工具注册表
- `widgets`：动态 Vue 组件注册表
- `session`：append-only 会话日志
- `loop`：Agent Loop
- `llm`：OpenAI 兼容模型适配器
- `meta-tools`：`create_plugin` / `remove_plugin`
- `services/types.ts`：宿主与插件共享的服务类型

### apps/web-demo

这是 demo，负责：

- 使用 `@agentkit/runtime` 和 `@agentkit/plugins` 装配宿主
- 提供聊天、插件现场、文件预览、运行时日志等 UI
- 连接 OpenAI 兼容 API

```text
apps/web-demo
├─ index.html
├─ vite.config.ts
└─ src
   ├─ main.ts
   ├─ App.vue
   └─ app/host.ts
```

## 架构

```text
OPFS (.plugins/*.js + manifest.json)
        │  PluginSourceStore
        ▼
Reactive PluginCatalog（desired state：source / revision / enabled / status / error）
        │  BrowserPluginManager（install / update / enable / disable / remove / restore）
        ▼
PluginReconciler —— 事务性整插件热重载
        │  stage（编译候选，旧插件不受影响）
        │  → swap（卸载旧 fiber，挂载新 fiber）
        │  → verify（await fiber）
        │  → commit（成功后才写 OPFS）
        │  失败 → rollback（重新挂载旧模块）
        ▼
官方 cordis（@deepseek-ai/cordis）
```

### runtime

生命周期直接使用官方 `@deepseek-ai/cordis`：

- 服务提供：插件内 `ctx.provide(name, value)`，读取：`ctx.get(name)`
- 声明式依赖：插件对象上的 `inject: ['tools']`，依赖就绪才加载，依赖消失卸载
- 副作用：`ctx.effect(fn)` 返回 disposer，卸载时逆序执行
- 挂载与等待：`ctx.plugin({ name, inject, apply })` 返回 fiber，`await fiber` 等待进入 active

### loader

- `PluginCatalog`：`shallowReactive Map<id, reactive PluginRecord>`，驱动 UI 与 reconcile
- `PluginCompiler`：Blob URL + 原生 `import()`（浏览器）/ `data:` URL（Node 测试）
- `PluginReconciler`：每插件独立 epoch + 串行队列，事务性更新 + 失败回滚
- `BrowserPluginManager`：facade，同时暴露为 `plugins` service 供 agent 工具调用

### plugins

`fs`（OPFS + 结构化变更事件）、`tools`（token ownership 注册表）、`widgets`、`session`、`loop`、`llm`、元工具 `create_plugin` / `remove_plugin`。工具也是子插件，声明式 inject 未就绪时保持 PENDING。

## 设计约束（v0.1）

- 一个插件 = 一个单文件 ESM，不允许相对 import，能力一律走 `ctx.get()` 读取 service
- 更新粒度 = 整个插件重启（不做模块级依赖图 HMR）
- `file_editor` 直接改 `.plugins/x.js` 会通过 fs 事件触发同样的 reconcile（内容相同则幂等跳过）
- 动态插件源码由 `OpfsSourceStore` 直写 OPFS，不进 fs 缓存；从 agent 视角应使用 `plugins.list()` / 插件目录面板确认插件状态

## 测试

`packages/runtime/tests/runtime.test.ts`：ownership、异步生命周期、PENDING/重载状态机（基于官方 cordis）。

`packages/runtime/tests/reconciler.test.ts`：install/update/disable/remove/restore、编译失败不影响旧插件、挂载失败回滚、并发串行收敛。
