# Harness Page Agent

一个 TypeScript + Vue 的自修改 agent runtime，同时提供 standalone 演示和 Chrome Manifest V3 扩展。扩展允许用户通过 LLM 对话读取网页、选取并批注元素、预览/应用/验证/撤销 DOM 补丁，以及把确认后的补丁保存为站点 recipe。

## 工程命令

```bash
npm install
npm run check              # strict typecheck + tests + 扩展、standalone、宿主页构建
npm run build              # Chrome 扩展 → dist/extension
npm run build:standalone   # standalone → dist/standalone
npm run build:fixtures     # legacy + React 19 宿主页 → dist/fixtures
npm run dev                # CRXJS + Vite 扩展开发模式
npm run dev:fixtures       # 本地宿主页：/legacy-host/ 与 /react-host/
npm test                   # node:test；包含内容脚本 DOM 集成测试
```

构建由 Vite/CRXJS 管理 manifest、service worker、HTML 页面、sandbox ESM runtime 和 content-script IIFE。sandbox 页面会在 ESM 图执行前加载一个极小的经典脚本，把启动异常转发给 trusted shell；构建末尾会校验入口和浏览器环境约束。源码 import 使用 extensionless specifier。

## 加载 Chrome 扩展

1. 运行 `npm run build`。
2. 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”。
3. 选择 `dist/extension`。
   如果之前已经加载过，构建后请在扩展卡片上点击“重新加载”，再关闭并重新打开 side panel。
4. 点击扩展图标打开 side panel；在“LLM 设置”中配置 DeepSeek 或其他 OpenAI-compatible endpoint。
5. 首次进入某个 origin 时，点击 trusted shell 顶部的“授权并读取”。扩展只申请当前 origin，授权成功后自动读取；此后该站点可直接读取并在刷新后运行已启用的 recipe。

Chrome 135+ 才支持当前使用的 `chrome.userScripts.execute`。`page/eval` 还要求在扩展详情页允许 user scripts；普通 DOM 工具不依赖该开关。

## 架构

- **Trusted extension shell**：service worker、按 tab 独立挂载的 side panel 和 options page。持有 `chrome.*`、LLM key、MCP 连接和扩展 OPFS。
- **Sandboxed Cordis runtime**：浏览器内运行 `@deepseek-ai/cordis`，管理 Plugin/Fiber、服务注入、事件、中间件、effect 与异步销毁；Vue 只渲染 `ctx.ui.register()` 注册的真实 UI。它没有 `chrome.*`，只能发送经过 Zod 校验的 capability request。
- **Public plugin SDK**：动态源码只能导入 Vue、Cordis、Zod、模型 SDK 与 `@harness/sdk`；root Context、mount/unmount、compiler、boot 和持久化仓库不进入动态模块表。fs、tools、prompt、manager、task runtime、state、loop 等框架服务作为不可编辑的 system Fibers 装配。
- **Principal-bound broker**：Cordis `Service` tracing 把每次 provider 调用绑定到发起调用的 capability Fiber；trusted shell 校验 manifest 中声明的 provider、permission、scope 和 active task id 后才分派请求。中间的 workspace/LLM adapter 继续传递调用者身份。
- **Host-page content runtime**：框架无关的 DOM ABI，提供 snapshot/query/observe/picker 与事务补丁；补丁有 preview/apply/verify/revert 生命周期。
- **MAIN / USER_SCRIPT execution**：仅由 trusted broker 通过 Chrome User Scripts API 执行，不把任意 `eval` 权限交给 content script。

动态 capability 源码仍以 JavaScript 存放在 OPFS 的 `.plugins/` 下，但 builtin capability 的仓库源码统一用 TypeScript 编写，构建时由 Vite/Oxc 去除类型后作为 factory source 嵌入。插件使用 Cordis 的 function/class/`{ apply }` 类型，推荐导出 `name`、`inject`、`apply(ctx)` 并在函数里显式注册 tool、prompt、service、event 与 UI。首次启动 write-if-missing，用户修改不会被新版 bundle 静默覆盖；保留的系统 Fiber 名称不能从 workspace 覆盖。

`.plugins/<id>.js` 是可编辑 working draft，`.harness/capabilities/<id>/index.js` 是最后成功激活的 revision。编译或 apply 失败不会替换正在运行的 Fiber；刷新后也会从最后 active revision 恢复，同时保留坏 draft 供继续修复。

MCP 使用官方 `@modelcontextprotocol/sdk` 的 Streamable HTTP transport；浏览器扩展不伪装支持本地 stdio，后者需要 Native Messaging 或本地 bridge。

详细设计、信任边界和 React/Vue 支持范围见 [扩展架构](docs/extension-architecture.md)。浏览器 Cordis 内核与插件格式见 [docs/cordis-to-vue.md](docs/cordis-to-vue.md)，验证清单见 [docs/TESTING.md](docs/TESTING.md)。

## 框架支持边界

DOM 是稳定主路径，因此古老服务端页面、Vue、React 和其他前端框架都能被修改。对 React/Vue 页面直接改 DOM 不会更新其业务 state，后续重渲染也可能覆盖补丁；recipe 会在路由/刷新后重新应用，但涉及业务逻辑或持久状态时应生成站点 adapter，而不是冒充修改了组件源码。

每个 `http(s)` 标签页使用 Chrome tab-specific side panel：对话、批注、页面引用和 MCP 会话不会串到其他 tab；OPFS 插件、LLM 设置和 recipe 仍是扩展级共享状态。`chrome://`、扩展页等受限页面会直接禁用该面板。

共享 OPFS 写入使用浏览器锁与文件 revision 做冲突检测，并通过跨 panel change feed 刷新缓存。两个标签页同时编辑同一文件时，后到的旧 revision 写入会明确报冲突，而不是覆盖较新的内容。

Vue 的组件树可作为可选诊断 adapter；React production build 没有稳定公共组件树 API，因此只承诺 DOM 级修改。需要真正修改 React 源码时，应把批注和 DOM 定位信息交给外部 coding agent/compiler 工作流。

仓库提供两个可重复验证的宿主页：[`examples/legacy-host`](examples/legacy-host) 模拟古老班车查询页，[`examples/react-host`](examples/react-host) 使用真实 React 19 `createRoot` 和状态更新，用来观察 reconciliation 覆盖外部 DOM 补丁的边界。

`app/` 是项目早期的冻结 PoC；`conversations/` 保存原始调研与决策记录。
