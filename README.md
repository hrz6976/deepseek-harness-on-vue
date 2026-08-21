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

构建由 Vite/CRXJS 管理 manifest、service worker、HTML 页面和 content-script IIFE，不使用手写构建脚本。源码 import 使用 extensionless specifier。

## 加载 Chrome 扩展

1. 运行 `npm run build`。
2. 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”。
3. 选择 `dist/extension`。
4. 点击扩展图标打开 side panel；在“LLM 设置”中配置 DeepSeek 或其他 OpenAI-compatible endpoint。
5. 首次进入某个 origin 时，点击 trusted shell 顶部的“授权并读取”。扩展只申请当前 origin，授权成功后自动读取；此后该站点可直接读取并在刷新后运行已启用的 recipe。

Chrome 135+ 才支持当前使用的 `chrome.userScripts.execute`。`page/eval` 还要求在扩展详情页允许 user scripts；普通 DOM 工具不依赖该开关。

## 架构

- **Trusted extension shell**：service worker、按 tab 独立挂载的 side panel 和 options page。持有 `chrome.*`、LLM key、MCP 连接和扩展 OPFS。
- **Sandboxed agent runtime**：运行原有 kernel、loop、compaction 和可自修改 builtin/user plugins；没有 `chrome.*`，只能发送经过 Zod 校验的 capability request。
- **Host-page content runtime**：框架无关的 DOM ABI，提供 snapshot/query/observe/picker 与事务补丁；补丁有 preview/apply/verify/revert 生命周期。
- **MAIN / USER_SCRIPT execution**：仅由 trusted broker 通过 Chrome User Scripts API 执行，不把任意 `eval` 权限交给 content script。

动态插件源码仍以 JavaScript 存放在 OPFS 的 `.plugins/` 下，但 builtin 的仓库源码统一用 TypeScript 编写，构建时由 Vite/Oxc 去除类型后作为 factory source 嵌入。首次启动 write-if-missing，用户修改不会被新版 bundle 静默覆盖。

MCP 使用官方 `@modelcontextprotocol/sdk` 的 Streamable HTTP transport；浏览器扩展不伪装支持本地 stdio，后者需要 Native Messaging 或本地 bridge。

详细设计、信任边界和 React/Vue 支持范围见 [扩展架构](docs/extension-architecture.md)。原 harness 的 Cordis→Vue 映射见 [docs/cordis-to-vue.md](docs/cordis-to-vue.md)，验证清单见 [docs/TESTING.md](docs/TESTING.md)。

## 框架支持边界

DOM 是稳定主路径，因此古老服务端页面、Vue、React 和其他前端框架都能被修改。对 React/Vue 页面直接改 DOM 不会更新其业务 state，后续重渲染也可能覆盖补丁；recipe 会在路由/刷新后重新应用，但涉及业务逻辑或持久状态时应生成站点 adapter，而不是冒充修改了组件源码。

每个 `http(s)` 标签页使用 Chrome tab-specific side panel：对话、批注、页面引用和 MCP 会话不会串到其他 tab；OPFS 插件、LLM 设置和 recipe 仍是扩展级共享状态。`chrome://`、扩展页等受限页面会直接禁用该面板。

Vue 的组件树可作为可选诊断 adapter；React production build 没有稳定公共组件树 API，因此只承诺 DOM 级修改。需要真正修改 React 源码时，应把批注和 DOM 定位信息交给外部 coding agent/compiler 工作流。

仓库提供两个可重复验证的宿主页：[`examples/legacy-host`](examples/legacy-host) 模拟古老班车查询页，[`examples/react-host`](examples/react-host) 使用真实 React 19 `createRoot` 和状态更新，用来观察 reconciliation 覆盖外部 DOM 补丁的边界。

`app/` 是项目早期的冻结 PoC；`conversations/` 保存原始调研与决策记录。
