# Handoff Note — 232238 · gpt · fixed-llm-mount

## 继承上下文

- `main` 上的 standalone 已由 `serve.mjs` 在 `http://localhost:7100` 运行，并通过 `PI_AUTH_PROVIDER=opencode-go` 转发到 OpenCode Zen。
- 用户反馈点击 “Mount LLM plugin” 没有反应。诊断确认 shipped `llm` 源码包含动态插件方言不支持的 re-export，而 settings 丢弃了 manager 的错误返回值。

## 本次完成

- [x] 删除 `src/plugins/llm.ts` 中不受支持的 `export { toPiMessages } from '../shared/pi-engine'`。
- [x] 将 `toPiMessages` 测试直接改为从 `src/shared/pi-engine.ts` 导入。
- [x] 将 settings 的 connect 改为等待 `manager.mount()`，并在面板显示成功或错误信息。
- [x] mount 失败时关闭 autoconnect，避免刷新后重复静默失败。
- [x] 增加 shipped `llm` 走真实 `compilePlugin()` 的回归测试。
- [x] 运行完整测试：69/69 通过。
- [x] `npm run build` 与 `npm run build:standalone` 均通过，7100 服务保持 HTTP 200。

## 当前状态

| 文件 | 改动 |
| --- | --- |
| `src/plugins/llm.ts` | 删除非法 re-export |
| `src/plugins/ui/settings.ts` | 显示 mount/unmount 结果与错误；正确维护 autoconnect |
| `tests/invariants.test.ts` | 直接导入 shared `toPiMessages` |
| `tests/compaction.test.ts` | 直接导入 shared `toPiMessages` |
| `tests/plugin-defaults.test.ts` | 新增 shipped LLM 真实编译回归测试 |

## 后续事项

1. 浏览器现有 OPFS 仍保留旧 `.plugins/llm.js`；需要用户明确选择是否访问 `http://localhost:7100/?reset`。该操作会重置整个 `.plugins/`，包括用户自定义/修改过的插件，但保留 localStorage 模型配置。
2. 用户确认后，可打开 reset URL，再重新点击 Mount LLM plugin。
3. 当前修复尚未提交。

## 关键决策

| 决策 | 原因 |
| --- | --- |
| 不自动执行 `?reset` | 它会删除整个 OPFS `.plugins/`，可能清除用户自定义插件，属于需要明确确认的数据操作。 |
| 对 shipped LLM 增加真实编译测试 | 原测试只执行 `rewriteImports()`，无法发现合法 ESM 但不属于动态插件方言的 re-export。 |
| 不把所有 shipped plugin 都放进 Node fallback 编译测试 | `create-plugin` 的教学模板字符串包含字面量 `export default`，会触发已有 fallback 正则限制；浏览器主 ESM 路径正常，这与本次故障无关。 |

## 阻塞项

- 激活现有浏览器实例中的修复需要用户决定是否清空 OPFS `.plugins/`。

## 建议下一步

先确认是否可以丢弃 standalone 中现有的自定义/修改插件；若可以，访问 `http://localhost:7100/?reset` 后重新 Mount。
