# Bridge — 多 Provider AI API 网关

单文件多上游 AI API 代理网关，统一接入 ModelHub、OpenRouter、DeepSeek 等多个 provider，同时兼容 OpenAI Responses / Chat Completions / Anthropic Messages 三种协议。

## 为什么用这个？

- **多 Provider 路由**：按模型名自动分流到不同上游（ModelHub SG/CN、OpenRouter、DeepSeek），配置驱动
- **三协议互转**：Anthropic Messages ↔ OpenAI Responses ↔ Chat Completions，客户端无感知
- **缓存友好**：自动对齐 ModelHub 的 `session_id`，多轮对话直接命中 prompt cache
- **轨迹落盘**：请求/响应以 SWE-agent `.traj.jsonl` 格式保存，方便后续分析
- **极致轻量**：单文件 \~2000 行，依赖仅 `fastify` + `undici` + `dotenv`

## 快速上手

```bash
# 安装依赖
cd bridge && npm install

# 配置环境变量（编辑 bridge/.env）
cp .env.example .env  # 或者直接编辑 .env

# 启动（如需优先走 IPv6，可在启动前设置 NODE_OPTIONS）
export NODE_OPTIONS=--dns-result-order=ipv6first
node bridge.js
```

## 配置

### 环境变量（`.env`）

Bridge 使用 `dotenv` 自动加载 `bridge/.env` 文件。所有 API key 和敏感信息应放在此文件中：

```bash
# Provider API Keys
OPENROUTER_API_KEY=sk-or-v1-xxx
OPENCODE_API_KEY=...
MINIMAX_CN_API_KEY=...
```

| 变量                   | 默认值      | 说明                                                                |
| -------------------- | -------- | ----------------------------------------------------------------- |
| `OPENROUTER_API_KEY` | —        | OpenRouter API key                                                |
| `OPENCODE_API_KEY`   | —        | OpenCode Go API key                                               |
| `MINIMAX_CN_API_KEY` | —        | MiniMax CN API key                                                |
| `BRIDGE_API_KEY`     | 空（不校验）   | 网关访问密钥，客户端用 `Authorization: Bearer <key>` 或 `x-api-key: <key>` 传入 |
| `BRIDGE_CORS_ORIGINS` | 空 | 额外允许的逗号分隔 origin；所有 HTTP(S) loopback origin（任意端口的 `localhost`、`*.localhost`、`127.0.0.0/8`、`::1`）自动允许 |
| `PORT`               | `8787`   | 监听端口                                                               |
| `BRIDGE_HOST`        | `127.0.0.1` | 监听地址；默认仅允许本机连接                                             |
| `BRIDGE_TRAJ_DIR`    | `./traj` | 轨迹日志目录                                                            |
| `NODE_OPTIONS`       | —        | 可设为 `--dns-result-order=ipv6first` 以优先使用 IPv6；需在启动 `node bridge.js` 前由 shell 导出，不能仅依赖 `dotenv` 在进程内加载 |

### 配置文件（`bridge.config.json`）

配置文件定义 provider、模型路由和 fallback 规则。字符串值支持 `$VAR` / `${VAR}` 语法引用环境变量：

```json
{
  "providers": {
    "opencode-go": {
      "base_url": "https://opencode.ai/zen/go/v1",
      "auth": "bearer",
      "api_key": "$OPENCODE_API_KEY"
    },
    "openrouter": {
      "base_url": "https://openrouter.ai/api/v1",
      "auth": "bearer",
      "api_key": "$OPENROUTER_API_KEY"
    }
  },
  "models": {
    "deepseek-v4-flash": {
      "provider": "opencode-go",
      "api": "chat",
      "params": { "max_tokens": 384000 }
    },
    "anthropic/claude-sonnet-4.5": {
      "provider": "openrouter",
      "api": "messages",
      "params": { "max_tokens": 64000 }
    }
  },
  "fallback": [
    { "match": "^anthropic/", "provider": "openrouter", "api": "messages" },
    { "match": "^deepseek-", "provider": "opencode-go", "api": "chat" }
  ]
}
```

**Provider 字段说明：**

| 字段               | 说明                                                 |
| ---------------- | -------------------------------------------------- |
| `base_url`       | 上游 API 基础 URL                                      |
| `auth`           | 认证方式：`query_ak`（URL 参数）或 `bearer`（Authorization 头） |
| `api_key`        | 密钥，支持 `$ENV_VAR` 引用环境变量                            |
| `session_header` | 可选，`"extra"` 时附加 ModelHub session 头                |
| `chat_path`      | 自定义 chat API 路径（默认 `chat/completions`）             |
| `messages_path`  | 自定义 messages API 路径（默认 `messages`）                 |
| `responses_path` | 自定义 responses API 路径（默认 `responses`）               |

**模型路由逻辑：** 精确匹配 `models` → 按序匹配 `fallback` 正则 → 都不命中返回 400。

**params 合并语义：** 配置中的 `params` 作为默认值，仅在客户端未提供该字段时写入（`== null` 判定）。

### 无配置文件降级

如果 `bridge.config.json` 不存在，会降级为环境变量模式：要求 `MODELHUB_AK` 已设置，所有模型路由到单个 ModelHub 后端。

## CLI 参数

```bash
node bridge.js [options]

# 日志级别
-v                  info 级别日志
-vv                 debug 级别日志

# 存储 & 轨迹
--traj-dir ./traj   启用磁盘存储 + 轨迹记录到指定目录
--no-traj           关闭所有记录功能
                    （不指定 --traj-dir 时默认仅内存存储）

# 配置文件
--config path       指定配置文件路径（默认 ./bridge.config.json）
```

## 支持的端点

| 端点                          | 说明                                                  |
| --------------------------- | --------------------------------------------------- |
| `POST /v1/responses`        | OpenAI Responses API，支持 `previous_response_id` 多轮对话 |
| `POST /v1/chat/completions` | OpenAI Chat Completions API                         |
| `POST /v1/messages`         | Anthropic Messages API                              |
| `GET /v1/responses/:id`     | 获取已存储的 response                                     |
| `GET /v1/models`            | 模型列表（按请求头自动返回 OpenAI 或 Anthropic 格式）                |
| `GET /health`               | 健康检查                                                |

### 端点 × 上游 API 矩阵

| 客户端端点 ↓ \ 上游 API →     | `responses`                       | `chat` | `messages` |
| ---------------------- | --------------------------------- | ------ | ---------- |
| `/v1/responses`        | 原生转发                              | 501    | 501        |
| `/v1/chat/completions` | 翻译（Chat→Responses→Chat）           | 透传     | 501        |
| `/v1/messages`         | 翻译（Anthropic→Responses→Anthropic） | 501    | 透传         |

## 轨迹日志

启用时（默认），每个对话按 `conversationKey` 生成两个文件：

- `<key>.traj.jsonl` — 成功的请求/响应记录
- `<key>.err.jsonl` — 错误记录

每行为一个 JSON 对象，包含 `ts`、`endpoint`、`request`、`upstream_body`、`response` 等字段，兼容 SWE-agent 工具链。

## 客户端配置示例

**Claude Code** **`settings.json`：**

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787"
  }
}
```

**Codex** **`config.toml`：**

```toml
model_context_window = 1000000
model_auto_compact_token_limit = 900000
model_provider = "proxy"

[model_providers.proxy]
name = "Bridge"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
model_max_output_tokens = 128000
```

## 测试

```bash
# 离线测试：验证配置完整性和路由逻辑
node test.e2e.js

# 在线测试：启动 bridge 实例，对每个模型发真实请求
node test.e2e.js --live
```

## 已配置的 Provider 和模型

当前 `bridge.config.json` 也包含 OpenCode Go 与 MiniMax CN provider：

| Provider        | 认证方式       | 模型示例                                                         |
| --------------- | ---------- | ------------------------------------------------------------ |
| **openrouter**  | `bearer`   | Claude Sonnet 4.5、Claude 3.5 Haiku（+ `^anthropic/` fallback） |
| **opencode-go** | `bearer`   | DeepSeek V4、Kimi coding，以及匹配的 coding models                    |
| **minimax-cn**  | `bearer`   | MiniMax-M2.7（Anthropic Messages）                              |
