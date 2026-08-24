# Chrome extension architecture

## 结论

这套能力适合做 Chrome 扩展，但不能把“模型在宿主页面运行任意 JS”当成默认权限模型。可落地的形态是三层执行域加 capability broker：DOM 是跨框架 ABI，框架 adapter 只负责提供额外诊断信息。

```text
Tab-specific side panel / options / service worker (trusted)
  ├─ LLM key + OpenAI-compatible SDK
  ├─ official MCP HTTP client
  ├─ OPFS plugin persistence
  └─ validated capability broker
                 │ postMessage / chrome.runtime.Port
Sandboxed Vue agent runtime (dynamic, no chrome.*)
  ├─ bundled system Fibers: loop / tools / prompt / manager / task
  ├─ protected shipped capability source (readable, workspace-locked)
  ├─ editable shipped and user capability source from OPFS
  └─ page tools expressed as broker requests
                 │ chrome.tabs.sendMessage
Host page isolated content runtime
  ├─ compressed DOM snapshot + stable ElementRef
  ├─ computed/inline/matched CSS inspection, including ::before/::after
  ├─ query / mutation and route observation
  ├─ Shadow DOM picker + annotation composer
  └─ preview/apply/verify/revert transactions

MAIN or USER_SCRIPT world evaluation
  └─ only through trusted chrome.userScripts broker
```

## 为什么 DOM 是主 ABI

DOM 能覆盖静态页面、服务端模板、Vue、React、Web Components 和未知框架。`ElementRef` 同时携带 page `documentId`/路由 `generation`、短生命周期 `nodeRef`、可重定位 selector 和 fingerprint；页面重渲染后优先重用 nodeRef，失效时再用 selector，并至少校验 tag fingerprint。跨文档或 SPA 路由代际的引用直接失效，不能静默落到新页面里的同名元素。

React/Vue adapter 不负责实施修改，只可补充组件名、props、路由或开发模式信息。React production component tree 没有稳定公开 API；修改 DOM 后 React 下一次 reconciliation 可能覆盖结果。Vue 暴露的信息更多，但也不应把私有 runtime 字段当长期 ABI。

## 标签页生命周期

service worker 为每个 `http(s)` tab 调用 `sidePanel.setOptions({ tabId, path, enabled: true })`，path 携带 tab id；Chrome 因而为相同页面创建彼此隔离的 side panel 实例。切换 tab 会切换 agent runtime，而不是让一个全局 runtime 临时猜测 active tab。

- broker port 在名称中绑定 tab id，sandbox 请求不能覆盖它。
- 每个 broker envelope 都包含由 caller-bound `BrokerRuntime` 生成的 capability principal；trusted shell 会校验 provider、permission、scope 与 task id。side panel 在任何 OPFS plugin 挂载前一次性签发高熵 session capability，并拒绝之后的重复握手和无 session/错误 session envelope，避免动态代码直接伪造 `postMessage` 请求。
- 动态模块表只包含公共 `@harness/sdk` 与第三方 authoring 依赖，不暴露 root Cordis、host、boot、compiler 或 mount/unmount。
- page command、页面事件和 MCP client 都按 tab 路由。
- `chrome://`、`chrome-extension://` 等页面切换到不启动 sandbox 的 tab-specific fallback；同一 tab 进入 `http(s)` 时再切换到绑定该 tab id 的 agent panel。
- OPFS、LLM 配置和 recipe 属于扩展级数据；对话、批注、DOM 引用和运行期撤销属于 tab 会话。
- `nodeRef` 只持有弱引用和五分钟租约；SPA 路由代际变化会清空节点租约和旧事务，未发生路由变化的 undo 闭包也会在两小时空闲后释放。
- tab 关闭时清理该 tab 的 MCP client；content-script 事务随页面生命周期自然销毁。

## 补丁事务

一个事务由 label、目标引用和一组有限操作组成。当前操作包括文本、attribute、style、class、hide/remove 和经过清洗的 HTML insertion。

1. `preview` 解析全部目标，不写 DOM。
2. `apply` 顺序执行；中途失败按相反顺序回滚已执行操作。
3. `verify` 对每个操作执行后置条件检查。
4. `revert` 使用事务保存的 undo closure 撤销；文本替换会恢复原始子节点本身，保留节点身份和监听器。
5. HTML insertion 删除脚本、对象、embed、base、refresh meta、inline handler 和 `javascript:` URL。

事务是运行期撤销，不是永久源码修改。持久修改用 `SiteRecipe` 保存 audited DOM operations 或声明式 `LiveRule`。LiveRule 由 selector、可选 text/attribute predicate 和一组幂等 action 构成；content runtime 持有 MutationObserver，对当前与未来节点重放，不需要持久宿主脚本。已授权 origin 在页面加载完成或 SPA 路由变化后自动重放。

## 权限与秘密

- 网页内容访问默认只有 `activeTab`，不会安装即读取所有网站。
- `tabs` 只用于跟踪 tab URL、配置 tab-specific side panel 和固定 broker 路由；DOM 读取仍需用户在该 tab 打开扩展。
- 持久 recipe 需要用户为对应 origin 单独授权。
- 首次 origin 授权按钮属于 trusted side panel，而不是 sandbox iframe；`chrome.permissions.request` 直接发生在该按钮的用户手势中，成功后才通知 sandbox 自动 snapshot。
- API key 只保存在 `chrome.storage.local` 的 `secrets.*` namespace；sandbox storage capability 明确拒绝该 namespace。
- 动态 plugin 在 sandbox 中运行，即使自我修改也拿不到 `chrome.*`、LLM key 或 MCP transport 对象；CSP 还把 `fetch`、WebSocket、beacon 等直接网络出口封死，I/O 必须经过 broker。
- 多个 side panel 共享 OPFS 时，trusted workspace provider 使用 `navigator.locks` 串行化写入，以内容 revision 做 optimistic conflict detection，并通过 `BroadcastChannel` 通知其他 sandbox 刷新缓存；冲突会显式失败，不再静默覆盖较新的文件。
- `page/eval` 不经过 content script；trusted broker 使用 `chrome.userScripts.execute`，且 prompt/tool policy 要求用户显式批准。
- 可选工具组不会全部塞进每轮 prompt。`capability_search` 返回 typed Capability/Tool/Provider/Workflow/EventSource/Panel/SiteSkill/tool-group 记录，`capability_load` 按 task/workspace/site/global scope 让相关 AgentTool 从下一轮开始可见。
- MCP 远端工具保留服务器声明的原生 JSON Schema 方言（Draft-07 或 2020-12），通过官方 SDK 的浏览器安全校验器注册；手写 Harness 工具继续使用 Zod，不维护 JSON Schema 到 Zod 的私有转换层。
- MCP HTTP 使用官方 SDK。stdio/本地进程不是浏览器能力，需要 Native Messaging host 或用户运行的 localhost bridge。

## 两个目标场景

### 古老网页一键重构

先 snapshot/query 定位目标，再用只读 `page_style_inspect` 检查元素和相关伪元素的 computed style、inline declaration 与可读 author rules；生成 CSS/DOM patch 后重新检查最终样式和关键交互，再保存按 origin/path 匹配的 recipe。对于 DOM 经常整块刷新的页面，observe/route event 可触发幂等重放。

### 前端交互式审阅

picker 运行在 closed Shadow DOM UI island 中，不污染宿主样式。用户点击元素并输入批注，事件把 annotation、selector、fingerprint、rect 和页面 URL 交给 agent。涉及视觉、布局或 CSS 的批注先触发目标元素及伪元素的样式检查，不依赖 class 名猜测级联。DOM 微调可直接事务修改；需要改 React/Vue 源码的反馈则导出给 coding workflow，并在页面刷新后重新验证。

## 后续扩展点

- Vue dev adapter：组件名、props/state 只读摘要。
- React dev adapter：仅在明确可用的开发工具 hook 上提供诊断，不能成为核心依赖。
- Native Messaging MCP bridge：显式安装、固定 allowlist、按 server 展示权限。
- Patch approval queue：把 model proposal 和用户批准拆成不可伪造的 trusted-shell 状态。
- Playwright/Chrome CI：加载 `dist/extension`，覆盖 legacy fixture 与 React/Vite fixture。
- Page frame/shadow-root/accessibility adapter：当前命令仍以 top frame 的 light DOM 为主；跨 frame、closed shadow root 与完整 accessibility tree 需要独立的显式 scope 和权限模型。
