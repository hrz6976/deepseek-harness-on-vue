# Chrome extension architecture

## 结论

这套能力适合做 Chrome 扩展，但不能把“模型在宿主页面运行任意 JS”当成默认权限模型。可落地的形态是三层执行域加 capability broker：DOM 是跨框架 ABI，框架 adapter 只负责提供额外诊断信息。

```text
Tab-specific side panel / options / service worker (trusted)
  ├─ LLM key + shared pi-ai engine (shared/pi-engine.ts)
  ├─ OPFS plugin persistence
  └─ validated capability broker
                 │ postMessage / chrome.runtime.Port
Sandboxed Vue agent runtime (dynamic, no chrome.*)
  ├─ existing loop / tools / prompt / compaction
  ├─ builtin and user plugin source from OPFS
  └─ page tools expressed as broker requests
                 │ chrome.tabs.sendMessage
Host page isolated content runtime
  ├─ compressed DOM snapshot + stable ElementRef
  ├─ query / mutation and route observation
  ├─ Shadow DOM picker + annotation composer
  └─ preview/apply/verify/revert transactions

MAIN or USER_SCRIPT world evaluation
  └─ only through trusted chrome.userScripts broker
```

## 为什么 DOM 是主 ABI

DOM 能覆盖静态页面、服务端模板、Vue、React、Web Components 和未知框架。`ElementRef` 同时携带短生命周期 `nodeRef`、可重定位 selector 和 fingerprint；页面重渲染后优先重用 nodeRef，失效时再用 selector，并至少校验 tag fingerprint。

React/Vue adapter 不负责实施修改，只可补充组件名、props、路由或开发模式信息。React production component tree 没有稳定公开 API；修改 DOM 后 React 下一次 reconciliation 可能覆盖结果。Vue 暴露的信息更多，但也不应把私有 runtime 字段当长期 ABI。

## 标签页生命周期

service worker 为每个 `http(s)` tab 调用 `sidePanel.setOptions({ tabId, path, enabled: true })`，path 携带 tab id；Chrome 因而为相同页面创建彼此隔离的 side panel 实例。切换 tab 会切换 agent runtime，而不是让一个全局 runtime 临时猜测 active tab。

- broker port 在名称中绑定 tab id，sandbox 请求不能覆盖它。
- page command 和页面事件都按 tab 路由。
- `chrome://`、`chrome-extension://` 等页面通过 tab-specific `enabled: false` 禁用。
- OPFS、LLM 配置和 recipe 属于扩展级数据；对话、批注、DOM 引用和运行期撤销属于 tab 会话。
- tab 关闭时 content-script 事务随页面生命周期自然销毁。

## 补丁事务

一个事务由 label、目标引用和一组有限操作组成。当前操作包括文本、attribute、style、class、hide/remove 和经过清洗的 HTML insertion。

1. `preview` 解析全部目标，不写 DOM。
2. `apply` 顺序执行；中途失败按相反顺序回滚已执行操作。
3. `verify` 对每个操作执行后置条件检查。
4. `revert` 使用事务保存的 undo closure 撤销；文本替换会恢复原始子节点本身，保留节点身份和监听器。
5. HTML insertion 删除脚本、对象、embed、base、refresh meta、inline handler 和 `javascript:` URL。

事务是运行期撤销，不是永久源码修改。持久修改用 `SiteRecipe` 保存 audited DOM operations；已授权 origin 在页面加载完成或 SPA 路由变化后自动重放。

## 权限与秘密

- 网页内容访问默认只有 `activeTab`，不会安装即读取所有网站。
- `tabs` 只用于跟踪 tab URL、配置 tab-specific side panel 和固定 broker 路由；DOM 读取仍需用户在该 tab 打开扩展。
- 持久 recipe 需要用户为对应 origin 单独授权。
- 首次 origin 授权按钮属于 trusted side panel，而不是 sandbox iframe；`chrome.permissions.request` 直接发生在该按钮的用户手势中，成功后才通知 sandbox 自动 snapshot。
- API key 只保存在 `chrome.storage.local` 的 `secrets.*` namespace；sandbox storage capability 明确拒绝该 namespace。
- 动态 plugin 在 sandbox 中运行，即使自我修改也拿不到 `chrome.*` 或 LLM key；CSP 还把 `fetch`、WebSocket、beacon 等直接网络出口封死，I/O 必须经过 broker。
- `page/eval` 不经过 content script；trusted broker 使用 `chrome.userScripts.execute`，且 prompt/tool policy 要求用户显式批准。
- MCP 暂不在 PoC 范围；后续接入外部工具时优先考虑 Streamable HTTP（浏览器可直接 fetch），stdio/本地进程需要 Native Messaging host 或用户运行的 localhost bridge。

## 两个目标场景

### 古老网页一键重构

先 snapshot/query，生成 CSS/DOM patch，preview 后由用户批准 apply，验证布局与关键交互，再保存按 origin/path 匹配的 recipe。对于 DOM 经常整块刷新的页面，observe/route event 可触发幂等重放。

### 前端交互式审阅

picker 运行在 closed Shadow DOM UI island 中，不污染宿主样式。用户点击元素并输入批注，事件把 annotation、selector、fingerprint、rect 和页面 URL 交给 agent。DOM 微调可直接事务修改；需要改 React/Vue 源码的反馈则导出给 coding workflow，并在页面刷新后重新验证。

## 后续扩展点

- Vue dev adapter：组件名、props/state 只读摘要。
- React dev adapter：仅在明确可用的开发工具 hook 上提供诊断，不能成为核心依赖。
- Native Messaging MCP bridge：显式安装、固定 allowlist、按 server 展示权限。
- Patch approval queue：把 model proposal 和用户批准拆成不可伪造的 trusted-shell 状态。
- Playwright/Chrome CI：加载 `dist/extension`，覆盖 legacy fixture 与 React/Vite fixture。
