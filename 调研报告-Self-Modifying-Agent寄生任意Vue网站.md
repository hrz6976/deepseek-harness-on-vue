# 调研报告：Self-Modifying Agent 作为"网页寄生虫"的可行性

> 背景：我们已基于 Vue 3 响应式基础设施实现了一个跑在纯浏览器端的 self-modifying coding agent（插件运行时 + OPFS 持久化 + 运行时造插件/造组件）。本报告评估一个进一步构想：**把 agentic 能力注入任意已有 Vue 网站**——作为组件寄生进宿主应用，读写其 vdom 树与组件状态；甚至以 userscript 形式注入所有网页（类似 pku-eutopia 的模式）。

**结论先行：构想基本成立，但应拆成三个难度等级——"挂载 agent 到任意页面"容易，"读写宿主 Vue 应用状态"意外地简单，"实时改写宿主组件渲染"需要复刻 Vue HMR 原理但也可行。**

---

## 一、构想的本质拆解

| 层级 | 能力 | 难度 |
|---|---|---|
| **A. 寄生** | 把 agent 运行时 + 对话 UI 注入任意网页 | ⭐ 容易，userscript 标准操作 |
| **B. 感知与操控** | 读取/修改宿主 Vue 应用的组件状态（data、props、setupState） | ⭐⭐ 意外地简单，且响应式白拿 |
| **C. 改写** | 运行时替换宿主组件的 render/template，真正改 vdom 树 | ⭐⭐⭐ 需要复刻 Vue HMR 机制，但原理清晰 |

## 二、关键调研发现

### 2.1 Vue 应用的"后门"在生产环境是开着的

这是整个构想成立的地基。Vue 3 挂载时会把 app 实例挂在容器 DOM 元素上，生产构建也不例外：

- `document.querySelector('#app').__vue_app__` → 拿到整个 App 实例，`._instance.proxy` 即根组件代理 [^1^]；
- 任意 DOM 元素上的 `__vnode.component` → 对应组件的内部实例，`.setupState` 可直接访问 `<script setup>` 的变量 [^1^]；
- Vue 2 老站对应 `__vue__` 属性。

即：**agent 无需宿主配合即可遍历整棵组件树、读出每个组件的状态**。Pinia/Vuex store、router 实例同理可及（经 app 实例的 `_context`）。

### 2.2 修改组件状态 = 直接改响应式代理，UI 自动更新

最优雅的部分：组件的 `data`、`setupState` 都是 Vue 的 reactive proxy。外部脚本执行 `instance.proxy.someField = newValue` 后，**宿主自己的响应式系统会自动触发重渲染**，无需任何强制刷新 hack。

### 2.3 改写组件渲染 = 复刻 Vue HMR 的三行核心

真正的"改 vdom tree"（换按钮文字、插入新节点）需要替换组件的 render 函数。Vue 官方 HMR 源码（`runtime-core/src/hmr.ts`）的核心操作极简 [^2^]：

```js
// Vue 官方 rerender 的本质：
instance.render = newRender;           // 换掉 render 函数
instance.renderCache = [];             // 清缓存
instance.update();                     // 触发重新 patch
```

`__VUE_HMR_RUNTIME__` 全局 API 只在开发构建暴露 [^2^]，但去掉记录簿管理后核心就是上面三行——**可在生产环境自实现迷你 HMR**；配合带编译器的 Vue 构建，还能把新 template 字符串编译成 render 再注入。`reload`（换整个组件定义、强制重挂载）原理类似，代价是组件状态丢失 [^2^]。

### 2.4 Userscript 载体的能力边界

对照 pku-eutopia 的模式（xmcp 的 PKU 站点增强 userscript 集，针对北大树洞等站点做 UI 增强与功能注入；有趣的是北大树洞前端本身已从 React 迁移到 Vue [^3^]），Tampermonkey/Violentmonkey 的能力恰好补齐短板：

- **CORS 问题消失**：`GM_xmlhttpRequest` 跨域直调 LLM API，不受页面源限制 [^4^]——纯网页版里头疼的"API key + 跨域"问题在 userscript 里不存在；
- **隔离世界问题**：userscript 默认跑在隔离世界，摸不到页面的 `window`/Vue 实例。两条路：Firefox 用 `unsafeWindow` [^5^]；Chrome 用注入 `<script>` 标签进主世界的经典 trick [^4^]。Tampermonkey 新的 `@sandbox MAIN_WORLD` 声明更直接 [^6^]；
- **存储**：`GM_setValue/GM_getValue` 跨站持久化，比 OPFS 更适合"一套配置所有站点生效"；OPFS 按源隔离，在寄生模式下反而成为"每个站点独立工作区"的特性；
- **SPA 路由切换会冲掉注入的 DOM**：需监听 urlchange 重新注入，油猴开发的常识性坑 [^7^]；
- **社区已有成熟实践**：用 Vue + Element 开发油猴脚本、`@require` 引入依赖、`externals` 配置，都是踩平的路 [^8^][^9^]。

### 2.5 主要障碍：CSP 与代码混淆

- **严格 CSP 的站点**（`script-src` 不含 `blob:`）会挡住 Blob URL 动态插件加载。缓解：Firefox 的 userscript 沙箱世界可绕过页面 CSP [^6^]；Chrome 下退化为 `new Function` 编译（失去 ESM 语法但够用）；
- **生产混淆**：宿主组件名被压缩后，agent 无法按名定位组件，只能靠 DOM 选择器 → `__vnode` 反查。组件树的"可读序列化"（把 vdom 树压缩成模型能理解的文本）是需要专门设计的上下文工程；
- **私有 API 漂移**：`__vue_app__`、`__vnode`、`instance.update()` 都是内部 API，不保证跨 Vue 小版本稳定；不过这些 API 自 Vue 3.0 以来未变 [^1^]。

## 三、架构草案（"寄生虫"模式）

```
userscript bootstrap（@match *://*/*，@sandbox MAIN_WORLD）
├── injector          → 创建挂载点 div，把 agent 宿主 app 挂上去
│                       （Vue 3 多 app 共存是官方支持的）
├── host-bridge 插件   → 站点探测：__vue_app__ / __vue__ / 非 Vue 降级
│                        ├── vue_inspect 工具：序列化组件树给模型看
│                        ├── vue_state 工具：读写指定组件的 setupState/props
│                        └── vue_patch 工具：替换 render（迷你 HMR）
├── page-api 插件     → page_eval（主世界执行）、拦截 fetch/XHR（monkeypatch）
├── llm 插件          → 改用 GM_xmlhttpRequest，CORS 免疫
├── fs 插件           → OPFS（按站点隔离）或 GM_setValue
└── loop / session / tools / plugins → 现有代码原样搬，运行时本身与 DOM 无关
```

关键洞察：**我们的插件运行时不依赖"自己是页面主人"这个假设**——root 上下文、服务注册表、Creator 模式全部可原样跑在注入的 script 里。agent 造轮子的能力在寄生模式下反而更值钱：用户在某网站遇到不顺手的功能，agent 现场写个插件改掉该页面的组件，插件持久化后**下次访问该站点自动生效**——这是 pku-eutopia 人工开发模式的自动化版本。

## 四、能力矩阵（诚实版）

| 能力 | Vue 3 站点 | Vue 2 站点 | React/其他 | 静态页 |
|---|---|---|---|---|
| 注入 agent UI + 对话 | ✅ | ✅ | ✅ | ✅ |
| DOM 级增删改 | ✅ | ✅ | ✅ | ✅ |
| 读组件树与状态 | ✅ | ✅（`__vue__`） | ⚠️ 要摸 fiber，另写适配器 | — |
| 改状态自动重渲染 | ✅ 响应式白拿 | ✅ | ⚠️ 需触发 setState 类机制 | — |
| 替换组件 render | ✅ 迷你 HMR | ✅ | ⚠️ 很难 | — |
| 调页面内 JS 函数 | ✅ 主世界注入 | ✅ | ✅ | ✅ |

## 五、风险清单

1. **提示注入是最大的真风险**：页面内容进入模型上下文后，恶意网页可以"指挥"你的 agent 做事（它手握读写全页的能力）。这比代码沙箱重要得多，是该产品形态与生俱来的头号问题；
2. **站点对抗**：电商/考试/政务站点可能做 DOM 篡改检测或 hook 检测，agent 的修改可能触发风控；
3. **CSP 严格站点**动态插件加载可能失败（有降级方案）；
4. **混淆站点的组件定位**依赖启发式，agent 可能改错组件——需要"修改前快照、可一键回滚"机制（`dispose()` 天然就是回滚）；
5. **合规**：userscript 修改自己浏览器里的页面展示属于普遍实践（pku-eutopia、去广告脚本皆然）；但自动化操作（自动选课、自动下单）会触及站点服务条款。

## 六、建议的验证路径

不要一上来就做通用 userscript。建议三步走：

1. **先在自家页面验证寄生模式**：把现有 index.html 当"宿主网站"，另写注入脚本把 agent 塞进去，验证多 app 共存 + `__vue_app__` 探测（约 100 行可跑通）；
2. **加 `vue_inspect` / `vue_state` 工具**：让 agent 能回答"这个页面上有什么、某组件的状态是什么"，先只读后写；
3. **最后上 `vue_patch`（迷你 HMR）**：实现"把页面上的按钮改成蓝色"级别的渲染改写，并验证卸载插件即回滚。

## 七、结论

Vue 把应用实例挂在 DOM 上、状态是可写的响应式代理、HMR 原理公开且极简——三个事实叠加，使"agent 实时修改宿主 Vue 应用"比直觉容易得多；userscript 的 `GM_xmlhttpRequest` 还顺手解决了纯网页版最大的工程痛点（CORS/密钥）。真正的难点不在技术而在两处：模型对宿主组件树的**上下文理解**（vdom 序列化），和网页内容对 agent 的**提示注入**。

---

[^1^]: Stack Overflow: Vue 3 通过 `el.__vue_app__` 与 `domComponent.__vnode.component.setupState` 从外部访问 app 与组件实例（生产构建可用）。
[^2^]: Vue 3 源码 `packages/runtime-core/src/hmr.ts`：HMR 的 `rerender`（替换 render + 清缓存 + update）与 `reload` 实现；`__VUE_HMR_RUNTIME__` 仅在 `__DEV__` 暴露。
[^3^]: pku-eutopia（github.com/xmcp/pku-eutopia）：PKU 站点增强 userscript 集；北大树洞（webhole）前端已从 React 迁移到 Vue。
[^4^]: Tampermonkey 文档：`GM_xmlhttpRequest` 跨域请求；Chrome 主世界注入 trick（向页面插入 `<script>` 标签）。
[^5^]: Stack Overflow / Tampermonkey 文档：Firefox 下 `unsafeWindow` 访问页面 JavaScript 变量。
[^6^]: Tampermonkey 文档：`@sandbox` 声明（MAIN_WORLD / raw / JavaScript / DOM 模式）；USERSCRIPT_WORLD 绕过页面 CSP。
[^7^]: Tampermonkey 社区实践：SPA 站点监听 `urlchange` 事件重新注入 UI。
[^8^][^9^]: 油猴脚本工程化实践：Vue + Element UI 通过 `@require` 与 webpack `externals` 集成。
