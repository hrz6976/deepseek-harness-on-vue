# 交接记录 — 241344 · gpt · fixed-stream-cors

## 继承上下文

延续 `241340-gpt-generalized-bridge-cors.md`。Bridge 已能为任意 loopback 开发 origin 处理 OPTIONS 预检，但用户发现实际 `POST /v1/chat/completions` 的流式响应仍缺少 `Access-Control-Allow-Origin`。

## 本次完成的工作

- [x] 定位到根因：SSE 路径直接调用 `reply.raw.write()` / `flushHeaders()`，绕过了只挂在 Fastify `reply` 上的 CORS 头。
- [x] 新增 `setCorsHeader()`，将每个 CORS 头同时写入 Fastify reply 和底层 Node raw response。
- [x] 将 CORS 测试从仅验证 OPTIONS 扩展为本地假上游驱动的真实流式 POST。
- [x] 验证流式响应正文和 `Access-Control-Allow-Origin` 同时存在。
- [x] 停止旧 Bridge 进程树并启动包含修复的新进程。

## 当前状态

| 文件 | 变更 |
| --- | --- |
| `bridge/bridge.js` | CORS 头同步写入 `reply` 与 `reply.raw`，覆盖普通响应和 SSE 响应。 |
| `bridge/test.cors.js` | 使用临时配置与本地 SSE 假上游，回归验证真实 `POST /v1/chat/completions`。 |

验证结果：

- `npm --prefix bridge test` 全部通过，包括真实流式 POST CORS 测试。
- 当前实例的 OPTIONS 响应为 204，允许 origin 为 `http://127.0.0.1:4000`，并允许 Stainless headers。
- `npm audit --omit=dev` 为 0 vulnerabilities。
- `node --check` 与 `git diff --check` 通过。
- Bridge 当前由 PID 64936 监听 `127.0.0.1:8787`。

## 下一位 agent 的待办事项

1. 无必须待办。若用户仍看到旧报错，先硬刷新页面并在 Network 面板确认响应来自当前 PID 64936。

## 关键决策

| 决策 | 理由 |
| --- | --- |
| 同时设置 Fastify 与 raw response header | Bridge 多条流式路径直接操作原生响应，仅设置 Fastify reply 无法保证 header 被 flush。 |
| 使用本地 SSE 上游做回归测试 | OPTIONS 成功不能证明实际流式 POST 响应满足 CORS；需要覆盖真实失败路径。 |
| 重启现有 Bridge | 旧 Node 进程不会自动加载 `bridge.js` 修改。 |

## 阻塞项

- 无。

## 建议下一步

刷新 `http://127.0.0.1:4000` 页面并重新连接 `http://127.0.0.1:8787/v1`。
