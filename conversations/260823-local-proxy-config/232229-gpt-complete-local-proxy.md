# Handoff Note — 232229 · gpt · complete-local-proxy

## 继承上下文

- 最近的 handoff 线程是 `conversations/260823-git-pull-stash-pop/`，内容是 Git 同步，与本次 LLM 配置任务不匹配，因此新建本线程。
- standalone 的 `serve.mjs` 已支持 `/proxy` 转发，并能从 `~/.pi/agent/auth.json` 选择 `deepseek` 或 `opencode-go` 凭据；扩展设置页此前仍强制要求 API key。

## 本次完成

- [x] 扩展 options 页增加“使用本地 proxy（免填 API key）”选项。
- [x] 本地 proxy 默认地址为 `http://localhost:7100/proxy`，并限制本地 proxy 模式只能使用 localhost、127.0.0.1 或 ::1。
- [x] service worker 接受 `localProxy` 配置；该模式忽略旧的直连 API key，使用 `pi-local` 占位符让 `serve.mjs` 注入本机凭据。
- [x] standalone 自由配置支持绝对的 localhost proxy 地址，不再误判为必须填写 key。
- [x] 扩展构建、standalone 构建、68 个测试和 `git diff --check` 均通过。

## 当前状态

| 文件 | 改动 |
| --- | --- |
| `src/extension/options.html` | 增加本地 proxy 选项和使用说明 |
| `src/extension/options.ts` | 保存/恢复 `localProxy` 模式，允许无 key 配置 |
| `src/extension/options.css` | 增加复选框与说明文字样式 |
| `src/extension/service-worker.ts` | 接受无 key 的本地 proxy 配置并强制使用 proxy 凭据 |
| `src/plugins/ui/settings.ts` | standalone 识别绝对 localhost proxy |

## 未完成事项

1. 用户需要重新构建并在 Chrome 扩展管理页重新加载扩展。
2. 用户需要在本机先启动 `npm run serve`，并确认 `~/.pi/agent/auth.json` 中存在可用的 `opencode-go` 或 `deepseek` api_key credential。

## 关键决策

| 决策 | 原因 |
| --- | --- |
| 使用显式 `localProxy` 字段，而不是把空 key 当作 proxy | 保留直连 endpoint 的严格校验，避免空 key 配置被误判为可用。 |
| local proxy 模式忽略存储中的旧 API key | 用户从直连切换到 proxy 时，必须真正使用本机 opencode/pi 凭据，不能让旧 key 覆盖 proxy 注入逻辑。 |
| 仅允许本地 hostname | `pi-local` 占位符不应被误发给任意远程 endpoint。 |

## 阻塞项

- `npm run typecheck` 仍被既有 `vite.config.ts` 的 `ManifestV3Export` 类型错误阻塞；扩展构建本身成功，错误与本次改动无关。

## 建议下一步

运行 `npm run serve` 后重建/重新加载扩展，在设置页勾选“使用本地 proxy”、填写实际 model 名称并保存。
