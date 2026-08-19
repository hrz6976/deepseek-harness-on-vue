# Handoff Note — 190128 · kimi · complete-p1-p2-implementation

## 继承的上下文

线程 `conversations/260819-vue-harness-poc/`。执行蓝图：`PoC重构计划.md`（P0 默认决策已被用户确认，并追加指示：**依赖全部下载到本地**，vue + pi-ai 不走 CDN）。架构依据：`190023`（组件即插件）、`190031`（框架选型封存）。

## 本次会话完成的工作

- [x] **pi-ai 本地 vendor**：`app/vendor/pi-ai-deepseek.bundle.mjs`（183KB，esm.sh 的 `@earendil-works/pi-ai@0.84.2/providers/deepseek` bundle）+ `app/vendor/node/`（process/buffer/fs 三个最小 shim——bundle 里这些 import 全是死代码或仅 `Buffer.isView`，已逐一核实）。Node 实测：模块可加载，`deepseekProvider()` 可用，模型目录 `deepseek-v4-flash` / `deepseek-v4-pro`，stream 函数在位。核心 bundle 不含 api 实现，必须用 provider 子路径 bundle（教训记录）
- [x] **P1+P2 实施**：`app/index.html` 全量重写（553 → 863 行，核心 JS ~720 行）。组件即插件内核四件套（services 注册表 / bus / plugins 数组 + PluginHost / 预编译加载器）、五个内置插件组件化、pi-ai 流式 + 内置 SSE 兜底双引擎、AbortController 真停止、blocks 消息 UI（text/thinking 折叠/toolcall 卡片）
- [x] **设计文档**（P1 硬性交付物）：`设计文档-cordis核心能力的Vue表达.md`，cordis 十二项能力 → Vue 表达 + 行号索引
- [x] **独立 subagent review**：实测 vendored Vue 响应式行为 + 核对 pi-ai 源码，产出 2 个 🔴 + 10 个 🟡
- [x] **修复全部 🔴 和大部分 🟡**：
  - 🔴-1 `reactive(Map)` 深响应化陷阱 → `shallowReactive`（修复 running 恒 false / 停止按钮失效 / engineName 不显示 / 双 loop 并发的连锁 bug）+ loop 重入保护
  - 🔴-2 HMR 只有语法探针 → 真试编译回滚（top-level 错误也拦，失败旧版继续跑）；顺带消除 defineAsyncComponent（简化为预编译模式，设计文档已同步）
  - 🟡 批次：piAiEngine done/error 死分支（done 携带 message 不是 partial）、create 双重执行、HMR watcher 死代码 onUnmounted、abort 回合工具结果补占位、`resetSession` 保留 .plugins/、滚动 watch 补 toolCalls、bus.emit try/catch、syslog 300 条上限、SSE 余量刷新、工具挂载层级注释纠正

## 当前状态

| 文件 | 状态 |
|---|---|
| `app/index.html` | 863 行，语法检查通过（node --check），**未经浏览器真机验证** |
| `app/vendor/pi-ai-deepseek.bundle.mjs` + `app/vendor/node/*.mjs` | 本地依赖，Node 加载测试通过 |
| `app/vue.global.prod.js` | 未动（Vue 3.5.41 全构建，自带编译器） |
| `conversations/260819-vue-harness-poc/设计文档-cordis核心能力的Vue表达.md` | review 修复后已修订（行号刷新、defineAsyncComponent→预编译、shallowReactive 坑记录） |
| git | 未提交（工作区全部改动待 commit） |

## 下一个 agent 的待办

1. **真机验证**（最高优先级）：起静态服务（`cd app && python3 -m http.server 8080`），浏览器开 `http://localhost:8080`，按 `PoC重构计划.md` P1/P2 各五条验收手动过一遍。重点：流式逐 token、停止按钮真停、create_plugin 造带 UI 插件、改写 .plugins/ 文件触发 HMR、写挂源码旧版继续跑、remove_plugin 无残留
2. DeepSeek 浏览器直连 CORS 真机确认（v4 模型端点）；若 CORS 挂，fallback SSE adapter 同样受影响——届时需要 userscript/扩展形态或本地代理
3. 验收过后 git commit（建议拆两个：vendor 依赖 / 重构本体）
4. P3（可选）：OPFS 路径三分（/config.json /plugins/ /workspace/）、文件导入导出、四面板 UI 重设计（计划文档 §P3 有完整规格）

## 关键决策

| 决策 | 理由 |
|---|---|
| 依赖全本地 vendor，不走 CDN | 用户明确指示；消灭网络不确定性，离线可演示 |
| vendor 用 provider 子路径 bundle 而非核心包 | 核心 bundle 不含 api 实现（lazy 动态 import 被 esm.sh 剥掉） |
| defineAsyncComponent 简化为预编译探针 | review 发现 loader 失败不进 onErrorCaptured 且无日志；预编译一处拦下编译+top-level 错误，语义更直白 |
| services 注册表用 shallowReactive | review 实测 reactive(Map) 会深响应化存入的 ref 并自动解包 impl 上的 ref 属性——连锁破坏 .value 语义 |
| P1/P2 合并交付，跳过计划的"P1 用非流式过渡" | 流式是用户核心诉求，双引擎一次到位 |

## 阻塞项

- 浏览器真机验证未做（本环境无法开浏览器）；DeepSeek CORS 未真机确认

## 建议的下一步

起静态服务器做真机验收，逐条过 P1/P2 验收标准，发现的问题直接修。
