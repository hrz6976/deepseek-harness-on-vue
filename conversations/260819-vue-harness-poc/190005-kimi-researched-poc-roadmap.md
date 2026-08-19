# Handoff Note — 190005 · kimi · researched-poc-roadmap

## 继承的上下文

本线程为新建，无更早的 handoff note。会话开始前工作区已有：

- `调研报告-Self-Modifying-Agent寄生任意Vue网站.md`——前置调研（寄生模式可行性，非本次重点）
- `app/index.html`（553 行）+ `app/vue.global.prod.js`——之前让 Kimi 写的纯浏览器 self-modifying agent boilerplate
- `ref_repos/`：cordis、deepseek-harness、vue-core 三个参考仓库
- 本次新增：`ref_repos/pi-mono`（浅克隆，npm 包名现为 `@earendil-works/*`）

**用户明确的 PoC 定位（最重要的一条）**：目标是 proof of concept，**只要在核心思路上保留 cordis 的设计哲学即可，不需要 API 粒度对齐**。设计哲学的具体内容见调研文档第五部分 5.1 节（六条：一切皆插件、注册即副作用、作用域树级联回收、服务就绪驱动激活、拦截链扩展点、运行时自修改）。

## 本次会话完成的工作

- [x] 调研 cordis 能力模型（Fiber/Context/effect/DI/事件总线/HMR），验证"类似 React 副作用管理"的猜想——半对，cordis 无细粒度依赖追踪
- [x] 调研 deepseek-harness 对 cordis 的实际使用，提取最小能力子集（DI + 注册即副作用 + waterfall + per-agent 作用域）
- [x] 产出 cordis→Vue reactivity 映射表，识别三块必须手搓的肉：异步 teardown、声明式 inject 调度、waterfall
- [x] 克隆并深读 pi-mono：pi-ai 官方支持浏览器、BYOK 用 `options.apiKey`、流式事件自带累积快照 partial、`Model.compat` 吸收各 provider 怪异行为
- [x] 调研 bolt.diy / nanobrowser 的 API 接入与流式方案（同源 proxy / 扩展豁免 CORS / 裸 fetch 直连三条路）
- [x] 逐模块评估 `app/index.html`：核心承诺兑现（插件运行时、OPFS、self-modifying 闭环），缺口在声明式依赖、异步 dispose、事件链、流式、真停止
- [x] 写出完整调研文档：`conversations/260819-vue-harness-poc/调研结论详解.md`

## 当前状态

| 文件 | 状态 |
|---|---|
| `conversations/260819-vue-harness-poc/调研结论详解.md` | 新建，完整调研记录（五部分 + 参考材料索引） |
| `ref_repos/pi-mono/` | 新增浅克隆（--depth 1），关键文件：packages/ai/src/types.ts、utils/event-stream.ts、packages/agent/src/agent-loop.ts |
| `app/index.html` | 未动，仍是 553 行 boilerplate |
| ref_repos 下其他仓库 | 未动 |

## 下一个 agent 的待办（按优先级）

1. **先读 `调研结论详解.md` 全文**，尤其是第五部分的 PoC 哲学清单与非目标清单，避免做超范围的事。
2. **决策点（需要用户拍板，或直接按推荐执行）**：在 `app/index.html` 单文件上演进，还是重开 Vite 工程？推荐：PoC 继续单文件 + `vue.global.js` 全构建（现成、可演示、self-modifying 需要运行时编译器）；等 PoC 验证通过再迁 Vite 工程解决 HMR/类型。
3. **升级插件内核**（把现有 ~40 行 `createContext()` 扩到 ~80 行）：补 async disposer 的 Promise 汇总 teardown、声明式 inject（服务槽 shallowRef + watchEffect 自动重跑插件体）、Fiber 状态的最小 ref。对照 `ref_repos/cordis/packages/core/src/fiber.ts` 理解语义，但按 Vue 习惯重写，不抄 API。
4. **加事件总线**（~40 行）：`ctx.on/emit` 挂 scope 自动注销 + waterfall 中间件链（next() 短路语义）。loop 的 `llm/request`、`tools/pre|post-execute` 三个挂点先接上。
5. **接入 pi-ai 流式**：`npm` 不可用就走 ESM CDN 或 vendor 拷贝（需用户确认网络策略）；BYOK key 存 localStorage；流式事件 `Object.assign(msg, ev.partial)` 灌 reactive 消息；AbortController 让 stop 真停（现有 stop 是假停）。真机验证 DeepSeek 端点的浏览器 CORS。
6. **两个便宜硬伤修复**（随时可做，各 ~5-10 行）：动态插件 `import(blob:)` 加 `new Function` 降级（Safari/CSP）；`ctx.log` 切断 getElementById 耦合。
7. **验收标准**：agent 能在对话里 `create_plugin` 造一个带 UI 的天气 widget 插件 → 刷新页面后仍在 → 对话中要求卸载 → 其 UI、工具、文件全部消失且无副作用残留。这一条跑通 = 六条哲学全部落地。

## 关键决策

| 决策 | 理由 |
|---|---|
| LLM adapter 直接依赖 pi-ai，不手搓 | 官方支持浏览器；`Model.compat` 是多年踩坑积累，手搓等于重踩；BYOK 用 options.apiKey 是正解 |
| agent loop 参考 pi-agent-core 自写（~200 行）而非直接依赖 | 要让 loop 与 Vue reactive 状态和插件 waterfall 链深度耦合，自写更顺手 |
| 不做 yml 配置树 / loader | PoC 用 TS 代码组合插件；声明式配置是产品形态问题不是内核问题 |
| 保留 OPFS 而非降级 localStorage | 已经写好且能工作，砍了反而浪费；除非后续证明它是麻烦源 |
| PoC 不做 session 持久化/resume、审批系统、多 agent | 非目标清单，防止范围蔓延 |
| 迷你 HMR 保状态**不做** | 该机制服务于改写宿主站点组件（寄生模式），PoC 改自己的 UI 用 `<component :is>` 足够 |

## 阻塞项

- （无硬阻塞）两个待确认事项：① 演进单文件还是重开 Vite 工程（待办 2）；② pi-ai 的引入方式——npm install 还是 CDN/vendor（取决于用户对构建工具的偏好，单文件路线下建议先用 CDN 或直接把 `ref_repos/pi-mono/packages/ai` 的适配层按需 vendor 进来）。

## 建议的下一步

读 `调研结论详解.md` 第五部分，然后就待办 2 的决策点问用户一句，随后从待办 3（插件内核升级）开工。
