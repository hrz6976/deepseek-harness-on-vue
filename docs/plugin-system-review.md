# 插件与系统设计检查

基线：`7e7915a`。范围包括两种宿主、18 个内置 capability、13 个系统身份、动态插件生命周期，以及提供给模型的工具和源码示例。在结构整理之后，已进一步重写插件装配、请求生命周期、任务状态与插件更新四条核心链路。

## 功能与架构判断

| 当前能力 | 实际实现与判断 |
|---|---|
| 对话与工具循环 | `loop.ts` 负责请求、流快照、工具调用、结束原因和取消；任务及持久状态在 `task-runtime.ts`。保留这条边界，HMR 不应替换整个对话。 |
| 上下文压缩 | `compaction.ts` 在轮次和溢出错误时介入；算法、长提示词独立。它通过可选服务读取当前 LLM，不能因模型尚未连接而阻止启动。 |
| 网页检查与修改 | Page 工具只转换参数并调用 broker；真实 DOM、选择器、事务、撤销在 content runtime，用户脚本在 trusted host。UI 展示、runtime 策略和宿主操作分别归属明确。 |
| 持久站点定制 | recipe/live rules/userscript 与 sandbox capability 是不同运行对象。保留区分；不能把保存 recipe 描述成给 Harness 安装源码插件。 |
| 工作区与自修改 | 工作区服务负责权限和持久化，Manager 负责 draft/active revision、挂载和安全时点。工具不再复制工作区的源码保护规则。 |
| 能力发现与按需工具 | catalog 是服务和贡献的查询视图；tool group 只影响后续模型可见工具，不是另一个插件引擎。保留现有工具名称和分组。 |
| MCP 与 Web | MCP 是 HTTP 客户端，Web 使用 trusted 浏览器读取。两者都不是本地进程或命令执行器。网络资源由 trusted host 管理。 |
| 插件 UI | Cordis 注册真实 Vue 面板，Vue 订阅可替换服务。自动重连、页面限制等启动/运行策略不依赖组件挂载。用户点击触发的展示操作仍可留在组件中。 |

不新增第二套插件 DSL、依赖调度器或通用注册框架。原生 Cordis `inject` 管服务依赖，`ctx.effect` 管资源；可信安装目录只记录环境、入口和权限等安装信息。

## 全部内置 capability

权限与环境的运行时真值是 [`builtin-plugins.ts`](../src/kernel/builtin-plugins.ts)。下表是本次设计检查，不参与装配。除特别注明外，两种宿主均包含该入口；需要 broker 的能力在没有 broker 的 standalone 中保持 pending。

| 定义 | 依赖与职责 | 处理结论 |
|---|---|---|
| [compaction](../src/plugins/compaction.ts) | 可选 `llm/task`；提供压缩服务及两个 loop 中间件；`llm.use` | 保留算法和长提示词拆分；入口直接包含生命周期。固定保留预算见后文。 |
| [llm](../src/plugins/llm.ts) | standalone 按需挂载；提供 `llm`；配置闭包持有连接参数 | 真实/离线引擎及消息转换属于同一个传输实现，保持集中；扩展使用系统 LLM adapter。 |
| [artifacts](../src/plugins/tools/artifacts.ts) | `task/fs/tools/prompt`；4 个工具；只读取 workspace，持久化交给 task | 单文件原生定义，保留明确的 task API 调用。 |
| [capability-catalog](../src/plugins/tools/capability-catalog.ts) | `tools/prompt/manager/task`；可选 broker；3 个发现/加载工具 | 保留分组优先和可选 Site Skill 查询；声明不等于可执行能力，见后文。 |
| [create-plugin](../src/plugins/tools/create-plugin.ts) | `tools/prompt/manager`；`capability.manage` | 修复模型可见示例并实际编译、挂载、调用；不再宣称存在 workflow 注册运行时。 |
| [file-editor](../src/plugins/tools/file-editor.ts) | `fs/tools/prompt`；基础文件操作；workspace 读写权限 | 删除重复的路径保护检查，直接使用 fs 的同一权限边界。 |
| [mcp](../src/plugins/tools/mcp.ts) | `broker/tools/prompt`；6 个按需工具及运行时加载的远端工具 | 保留原生远端 JSON Schema；Fiber 卸载清理工具注册，连接归 trusted host 所有。 |
| [page](../src/plugins/tools/page.ts) | `tools/prompt/broker`；24 个工具，其中 5 个按需 | 按检查、交互、事务、动态规则、持久 recipe 分组。保留工具参数和名称，共用一个 page 请求函数。 |
| [read-state](../src/plugins/tools/read-state.ts) | `ui/tools/prompt`；读取面板显式暴露的状态 | 保持单文件及输出上限，无 broker 权限。 |
| [remove-plugin](../src/plugins/tools/remove-plugin.ts) | `manager/tools`；`capability.manage` | 直接调用 Manager，源码/生命周期决策不搬进工具。 |
| [run-js](../src/plugins/tools/run-js.ts) | `tools/prompt`；Worker 中计算，5 秒超时 | 保持单文件，不伪装本地 shell；成功、错误和超时清理 Worker/URL。卸载和 Stop 的统一取消见后文。 |
| [web](../src/plugins/tools/web.ts) | `broker/tools/prompt`；两个 Web 工具；`web.read` | 保留薄 adapter，不在 sandbox 重做搜索/网络逻辑。 |
| [workspace-tools](../src/plugins/tools/workspace-tools.ts) | `fs/tools/prompt`；7 个按需搜索、diff 和修改工具 | 基础 editor 与高级工具的用途不同，保留接口；源码保护合并到 fs，diff 是纯函数。 |
| [chat](../src/plugins/ui/chat.ts) | standalone；注册 UI，可替换的 loop/task/llm/compaction 由面板订阅 | 保留长面板与入口分离。清空通过 task.clearConversation 执行，组件不写持久状态。 |
| [files](../src/plugins/ui/files.ts) | standalone；UI + workspace 只读 | 保持一个文件；Vue 仅管理选中文件和展示。 |
| [preview](../src/plugins/ui/preview.ts) | standalone；UI + workspace 只读 | 保持一个文件及 iframe sandbox 边界。 |
| [settings](../src/plugins/ui/settings.ts) | standalone；`ui`；`capability.manage` | 面板只编辑配置草稿并调用 modelConnection；连接持久化和恢复由 standalone shell 拥有，移除 settings 不影响连接服务。 |
| [syslog](../src/plugins/ui/syslog.ts) | standalone；UI，公开日志只读 | 保持一个文件；滚动属于展示行为，留在 Vue。 |

## 全部系统身份与生命周期

系统身份不可被工作区源码覆盖。宿主传入原生插件对象，名称来自定义；实现不同但角色相同的 workspace/llm 使用相同身份。下表包含运行期间创建的外层和就绪屏障，不遗漏无工具的系统对象。

| 系统身份 | 定义与依赖 | 判断/处理 |
|---|---|---|
| `shell` | [runtime-supervisor](../src/kernel/runtime-supervisor.ts)，拥有系统子 Fiber 和宿主 UI context | 保留宿主作用域和广泛权限；不向动态模块表导出根 Context。 |
| `broker` | [broker](../src/kernel/broker.ts)，提供带调用者追踪的 broker service | 保留 Service，普通对象会丢失调用者身份；transport 授权的限制见后文。 |
| `workspace` | [standalone fs](../src/plugins/fs.ts) 或 [broker-fs](../src/extension/broker-fs.ts)，扩展依赖 broker | 缓存/只读权限/effect 共享 WorkspaceRuntime；OPFS 和 broker mutation 各自保留。它们的事务/冲突语义不同，不强行合并。 |
| `ui` | [ui](../src/kernel/ui.ts)，贡献登记、状态暴露、Vue 宿主 | 实际注册项与目录共同按实例身份清理；展示错误不重启整个插件。 |
| `tools` | [tools](../src/plugins/tools.ts)，注册、校验、按需分组、每轮快照 | 合并无价值的 runtime 转发文件；去掉额外 token 对象，使用注册项本身的身份。 |
| `prompt` | [prompt](../src/plugins/prompt.ts)，有序提示词登记 | 与 tools 使用一致的替换清理语义；无需新增通用基类。 |
| `manager` | [manager](../src/plugins/manager.ts)，fs，启动装配时要求 task | 主入口和服务 facade 合并。授权 facade 保留：外部调用校验 caller，内部恢复/HMR 用 manager 自己的持久化权限。bootstrap、activation、reload queue 是实际职责边界。 |
| `task-runtime` | [task-runtime](../src/plugins/task-runtime.ts)，依赖 fs | 合并仅转发的 runtime 文件。每个 active task 的子 Fiber 在切换时销毁并重建，持久身份不随 UI 重建。 |
| `loop` | [loop](../src/plugins/loop.ts)，`tools/prompt/task`，可选 llm | 运行流程和短协议检查回到入口；保留较大的流缓冲与 persona。取消在 Fiber 清理中触发。 |
| `model-profiles` | [model-profiles](../src/extension/model-profiles.ts)，`broker/ui` | 目录服务只含脱敏信息；控件独立。API key 和真正请求在 trusted host。元数据请求失败仍可启动，不等于模型可用。 |
| `llm` | [broker-llm](../src/extension/broker-llm.ts)，依赖 broker | 保留 Service 链中的 caller，既不能把一切升级为 adapter 的身份，也不能暴露密钥。 |
| `page-policy` | [page-policy](../src/extension/page-policy.ts)，`prompt/task` | 页面限制、临时修改提示和 artifact 事件处理归 runtime，生命周期独立于 Vue。 |
| `ready` | [runtime-supervisor](../src/kernel/runtime-supervisor.ts) 中的就绪屏障 | 等待必需服务、fs/task ready 和 bootstrap；监听初始 pending 后的系统失败。移除扩展入口重复的服务就绪清单和检查。 |

`fs`、`state` 是旧版本保留名称，不是额外运行实例。`task:<id>` 是 task-runtime 持有的生命周期作用域，不是可安装插件。trusted host 的 page/workspace/site-skill/storage/llm/mcp/web 七个业务 provider，以及仅供 Manager 申请安装权限的 runtime 控制入口 保留在扩展层，不能因为它们“也提供能力”就移入动态插件装载器。

## 确实减少的复杂度

- 删除了 tools/runtime、task-runtime/runtime、loop/runtime、loop/protocol、manager/runtime、manager/service、manager/types、settings/panel 这 8 个仅转发或过细拆分的文件；没有删除它们的功能。
- 所有内置 capability 使用一份原生 default 对象，工具入口不再额外定义 name/inject/apply 再组装。
- 可信入口/权限/环境目录取代分散清单；源代码的运行依赖仍只写在原生定义上。扩展不打包 standalone 专用 capability。
- 文件工具直接依赖工作区服务的保护规则；旧注册释放不会删除新注册及其目录；运行时策略不靠 Settings/Page UI 的挂载顺序触发。
- 内置源码按实际依赖打包；公开依赖保持运行时同一份模块实例，不重新打包私有 kernel 状态。自动测试执行模型可见示例，而不只检查示例文字存在。

## 四项核心重构的实际结果

| 部分 | 当前模型 | 删除的重复机制 |
|---|---|---|
| 插件定义与装配 | 安装清单只记录身份、版本、作用域和权限；原生 Cordis inject 管依赖，实际注册生成工具/提示词/面板目录 | generated/declared 运行时分支、贡献声明与实际注册的双份同步、无实现的 capability dependency/workflow 声明，以及不完整的 event-source 目录 |
| 权限与请求 | trusted shell 以可信内置目录或用户已批准并保存的 grants 决定权限；普通请求和流共用 request ID、deadline、cancel、结束处理 | 从输入 principal 直接采信权限；独立 llm/cancel 协议；流与普通请求各自维护等待状态 |
| 任务 | 每个 host 一个写入所有者；所有任务命令串行提交 tasks.json 完整快照；UI 调用任务操作 | 元数据、context、artifact、checkpoint 和索引的分散写入；独立 LLM 保存队列；UI 写 running/idle、直接清消息及越权清文件 |
| 更新与恢复 | Manager 串行处理安装/挂载/移除/HMR；先编译并验证元数据和 Config，启动后提交单个 package.json | 三份 package 写入、由描述文字推断运行时 manifest 来源、任务 attach 事件反向触发 Manager 再挂载的循环路径 |

任务 capability 在 apply 前完成任务关联，因此初始化阶段就能使用合法 broker 权限。失败安装撤销关联；刷新时直接从持久任务关联恢复插件，不触发与 Manager 启动屏障相互等待的事件。

进一步收掉重复结构：Manager 操作直接进入自身队列，删除中间的串行转发对象；activeTaskId 直接引用任务状态，不再维护另一份 ref 并在保存、恢复和回滚时同步；热更新队列用计时器是否存在区分等待状态，取消、刷新和销毁共用清理路径；普通事件与重启恢复共用事件编号逻辑。没有新增通用基类、队列框架或状态机。

### 明确的状态语义

- 同一 host 的第二个面板不能成为写入运行时，会显示已有面板占用的提示。不同 host 的任务库仍彼此独立；这版没有第二个只读观察面板。
- 切换、删除、清空任务必须等待运行结束；切换期间拒绝另一个切换或新运行。普通命令串行提交，写入失败恢复可见状态。文件 revision 仍是额外的冲突检测层。
- 旧任务布局会在首次成功保存时导入 tasks.json；旧文件保留但不再参与读取和写入。损坏数据不会被当成空任务库覆盖。全局模型选择是独立的用户偏好记录。
- 编译、配置或缺失依赖导致的更新拒绝保留旧实例。apply 或 package 提交失败时重新创建旧定义并验证恢复是否成功；失败恢复会明确报告。插件局部内存重新初始化，需要持久保留的状态由 task/workspace 持有。
- 已取消或超时的请求不能在后来的审批通过后继续派发。LLM/MCP 使用 AbortSignal，run_js 终止 Worker，Web 请求关闭临时标签页。取消不会撤回已经完成的页面点击，也不声称 Chrome API 已开始的持久写入可以被强行中断；相关提交完成后不再返回成功结果给已取消请求。

### 权限与范围边界

`CapabilityGrants` 忽略请求自报的 providers/permissions，从可信目录或扩展私有存储重建权限；自定义插件新增权限需要 trusted shell 审批，保存失败不会发布授权。授权记录不向 sandbox 的通用 storage provider 开放。

插件仍共享同一个 JavaScript realm。session 和 Cordis caller tracing 用于正常运行时身份传递，不构成互相敌对插件之间的隔离；本次没有引入每插件 iframe/Worker，也不声称能抵御已控制整个 sandbox 的代码冒用同一会话里的其他身份。standalone 的配置与插件仍同源，不能承诺扩展级密钥隔离。

本次四项重构不改变上下文压缩算法；固定 recent-token 预算的模型适配仍是单独的功能问题。

## 简化与验证

计数对比的是这次四项重构开始时的工作区，不是更早的 7e7915a。只统计 src/scripts 的 TS/TSX/JS/MJS/Vue 源码；测试和文档不算进删减收益。最终数字见本节下方。具体简化依据是上述被删除的机制，不以行数作为唯一验收条件。

回归测试覆盖：真实 sidepanel 消息入口在审批挂起时取消、取消后迟到批准不派发、普通请求和流取消、可信授权拒绝扩权、同 host 所有权、并发任务命令、失败快照回滚、持久清空、带插件的任务恢复、任务插件初始化权限、配置/apply/存储失败后的插件恢复、安装与删除串行化。

原有工具名称保持不变；有意收窄 create_plugin 的 manifest 与 capability_search 的 kinds，去掉没有运行实现的声明。原始 manifest 的旧贡献字段在读取时被剥离，工具、提示词和面板只展示真实注册结果。TaskRuntimeService 的插件关联统一为 setCapability，装配操作通过 Manager 发起。

完整检查包括类型检查、Node 测试、扩展构建及验证器、standalone 和 fixtures 构建。真实 Chrome 的原生权限弹窗、网络与重载验收尚未执行；自动测试中的浏览器边界使用模拟实现。

| 计数范围 | 重构前 | 重构后 | 减少 |
|---|---:|---:|---:|
| 任务与存储 | 433 | 325 | 108 行（24.9%） |
| 插件定义、装配与更新 | 856 | 626 | 230 行（26.9%） |
| 全部 src/scripts 源码 | 10548 | 10223 | 325 行（3.1%） |

验证结果：217 项 Node 测试全部通过，类型检查、扩展构建及验证器、standalone/fixtures 构建通过，git diff --check 通过。新增权限和取消机制的代码也包含在全量净变化中。构建保留既有依赖 externalization 与 chunk size 提示。


## UI 与业务边界补齐

- task-runtime 拥有文件附加、消息产物保存、首次运行命名和工作区失效后的刷新。上下文与对应事件在一次快照中提交；名称与 running 状态一起提交。外部刷新通过 Cordis 事件触发，等待运行结束，不依赖组件内的监听与计时器。
- page-policy 提供 pageSession 操作：读取页面并记录上下文、启动选择器、获取页面插件、启停与移除。服务保留 caller tracing，浏览器请求仍通过 broker；页面读取期间切换任务会拒绝迟到结果。Inspector 只维护抽屉、加载状态、列表展示和操作反馈。
- standalone shell 在 runtime ready 后创建 modelConnection 并尝试恢复连接，再渲染应用。settings 只持有可编辑草稿；持久化成功配置、连接和断开由服务完成。连接失败会展示错误，不把被拒绝的配置标记为已保存。
- 扩展 Provider 配置的校验、权限申请和存储归 llm-profiles，Options 只管理表单草稿。Worker 与 Options 共用读取逻辑；保存失败时 UI 保留未保存的 key 草稿。

本次没有引入新的 Controller、Repository 或通用状态框架。表格已包含这轮服务接口和运行时归属调整增加的代码；业务分离的验收依据是所有权与可独立执行性，不以文件搬移算作代码删减。新增测试不挂载 UI，直接验证任务/页面操作、失败回滚、迟到结果拒绝、运行后刷新、连接恢复和配置持久化。原生 Chrome UI 手动验收仍未执行。


后续代码收减：相对 UI 分离完成后的 10260 行，源码减少到 10218 行，净减 42 行（其中 41 行为非空行）。配置保存直接复用已有标准化逻辑，删除重复 URL/字段处理；Inspector 在当前 Cordis 上下文中获取服务，移除父组件的五项服务转交及空转发函数；启动流程合并一次性工厂和重复完成/失败转发，保留 PENDING、延迟失败与任务恢复屏障。未删除功能、权限检查或恢复路径，215 项测试和完整构建检查通过。


“存为报告”回归修复：抽屉的能力卡片仍读取已删除的 contributions.services/events，因 v-show 隐藏内容仍参与渲染，打开产物也会抛出 undefined.length。模板已改用实际 panels/prompts，报告卡片显示安全 Markdown 正文，保存失败向用户报告。新增测试使用真实任务持久化、保存操作和生产抽屉模板复现原错误并验证修复；Naive UI 容器在测试中以 slot 容器替代，原生 Chrome 验收仍未执行。
