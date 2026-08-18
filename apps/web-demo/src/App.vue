<script setup lang="ts">
import { computed, nextTick, reactive, ref, watchEffect } from 'vue'
import type { ComputedRef } from 'vue'
import { makeLlmPlugin } from '@agentkit/plugins'
import type { ChatMessage, Services } from '@agentkit/plugins'
import type { Fiber } from '@agentkit/runtime'
import { FiberStatus } from '@agentkit/runtime'
import { log, pluginManager, root, serviceState, syslogs } from './app/host'

function useService<K extends keyof Services>(key: K): ComputedRef<Services[K] | null> {
  return computed(() => (serviceState.get(key) as Services[K]) ?? null)
}

const cfg = reactive({ baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' })
const llm = useService('llm')
const connected = computed(() => !!llm.value)
const connecting = ref(false)
const running = ref(false)
const demoRunning = ref(false)
const resetting = ref(false)
const goal = ref('')
const selectedFile = ref('')
const showPreview = ref(false)
let llmFiber: Fiber | null = null
let demoAbort = false

const fs = useService('fs')
const session = useService('session')
const loop = useService('loop')
const widgets = useService('widgets')
const tools = useService('tools')

const plugins = computed(() => pluginManager.list())
const widgetList = computed(() =>
  (widgets.value?.entries() ?? []).map(([name, comp]) => ({ name, comp })),
)
const fileList = computed(() => fs.value?.list().filter(p => !p.startsWith('.plugins')) ?? [])
const messages = computed<ChatMessage[]>(() => session.value?.messages ?? [])
const visibleMessages = computed(() => messages.value.filter(m => m.role !== 'system'))
const previewHtml = computed(() => fs.value?.read('index.html') ?? '')
const selectedFileContent = computed(() =>
  selectedFile.value ? fs.value?.read(selectedFile.value) ?? '' : '',
)
const selectedFileStats = computed(() => {
  const content = selectedFileContent.value
  return {
    chars: content.length,
    lines: content ? content.split('\n').length : 0,
  }
})
const working = computed(() => running.value || demoRunning.value)
const activePlugins = computed(() => plugins.value.filter(p => p.status === 'active'))

const pluginAction = reactive<Record<string, 'toggle' | 'remove' | undefined>>({})

const DEMO_PLUGIN_SOURCE = `export default function (ctx) {
  const tools = ctx.get('tools')
  const unregister = tools.register('dice', {
    schema: {
      type: 'function',
      function: {
        name: 'dice',
        description: '掷一个 N 面骰子，返回 1 到 N 之间的结果',
        parameters: {
          type: 'object',
          properties: {
            sides: { type: 'number', description: '骰子面数，默认 6' },
          },
        },
      },
    },
    run: ({ sides = 6 }) => String(1 + Math.floor(Math.random() * Number(sides || 6))),
  })
  ctx.effect(() => unregister)
}`

async function connect() {
  if (connected.value || connecting.value) return
  connecting.value = true
  const fiber = root.plugin({ name: 'llm', apply: makeLlmPlugin({ ...cfg }) })
  try {
    await fiber
    if (fiber.state !== FiberStatus.ACTIVE) {
      throw new Error('LLM 插件未能进入 active')
    }
    llmFiber = fiber
  } catch (e) {
    await fiber.dispose().catch(() => {})
    llmFiber = null
    log(`挂载 LLM 插件失败：${(e as Error).message}`, 'err')
  } finally {
    connecting.value = false
  }
}

async function disconnect() {
  if (!llmFiber || running.value) return
  const fiber = llmFiber
  llmFiber = null
  await fiber.dispose()
}

async function run() {
  const task = goal.value.trim()
  if (!task || !connected.value || working.value) return
  goal.value = ''
  running.value = true
  try {
    await loop.value?.run(task)
  } finally {
    running.value = false
    scrollChat()
  }
}

function stop() {
  if (demoRunning.value) {
    demoAbort = true
    return
  }
  loop.value?.stop()
}

async function pause(ms = 650): Promise<boolean> {
  await new Promise(resolve => setTimeout(resolve, ms))
  return demoAbort
}

function appendToolCall(id: string, name: string, args: unknown): ChatMessage['tool_calls'] {
  return [{ id, function: { name, arguments: JSON.stringify(args) } }]
}

async function runDemo() {
  if (working.value) return
  const sessionSvc = session.value
  const toolsSvc = tools.value
  if (!sessionSvc || !toolsSvc) return

  demoAbort = false
  demoRunning.value = true
  sessionSvc.clear()
  selectedFile.value = ''
  showPreview.value = false

  try {
    sessionSvc.append({
      role: 'user',
      content: '给 agent 装一个 dice 插件，然后马上掷一个 20 面骰子。',
    })
    if (await pause()) {
      sessionSvc.append({ role: 'note', content: '演示已停止' })
      return
    }

    sessionSvc.append({
      role: 'assistant',
      content: '我先用 create_plugin 现场注册一个 dice 工具。',
      tool_calls: appendToolCall('demo_create', 'create_plugin', {
        name: 'dice',
        source: DEMO_PLUGIN_SOURCE,
      }),
    })
    if (await pause(850)) {
      sessionSvc.append({ role: 'note', content: '演示已停止' })
      return
    }

    const createResult = await toolsSvc.call('create_plugin', {
      name: 'dice',
      source: DEMO_PLUGIN_SOURCE,
    })
    sessionSvc.append({
      role: 'tool',
      tool_call_id: 'demo_create',
      name: 'create_plugin',
      content: String(createResult).slice(0, 8000),
    })
    if (await pause()) {
      sessionSvc.append({ role: 'note', content: '演示已停止' })
      return
    }

    sessionSvc.append({
      role: 'assistant',
      content: '插件已经热加载，接着直接调用 dice 工具。',
      tool_calls: appendToolCall('demo_dice', 'dice', { sides: 20 }),
    })
    if (await pause(850)) {
      sessionSvc.append({ role: 'note', content: '演示已停止' })
      return
    }

    const diceResult = await toolsSvc.call('dice', { sides: 20 })
    sessionSvc.append({
      role: 'tool',
      tool_call_id: 'demo_dice',
      name: 'dice',
      content: String(diceResult),
    })
    if (await pause()) {
      sessionSvc.append({ role: 'note', content: '演示已停止' })
      return
    }

    sessionSvc.append({
      role: 'assistant',
      content: `演示完成：dice 插件在聊天过程中被编译、挂载、持久化，并在同一轮对话里被调用。结果：${diceResult}`,
    })
  } finally {
    demoRunning.value = false
  }
}

async function resetWorkspace() {
  if (working.value || resetting.value) return
  resetting.value = true
  try {
    session.value?.clear()
    const fsSvc = fs.value
    if (fsSvc) {
      const userFiles = fsSvc.list().filter(p => !p.startsWith('.plugins'))
      await Promise.all(userFiles.map(p => fsSvc.remove(p)))
    }
    selectedFile.value = ''
    showPreview.value = false
    log('已清空会话与工作区文件（动态插件保留）', 'warn')
  } finally {
    resetting.value = false
  }
}

function readFile(path: string): string {
  return fs.value?.read(path) ?? ''
}

async function togglePlugin(id: string, enabled: boolean) {
  if (pluginAction[id]) return
  pluginAction[id] = 'toggle'
  try {
    if (enabled) await pluginManager.disable(id)
    else await pluginManager.enable(id)
  } catch (e) {
    log(`切换插件 ${id} 失败：${(e as Error).message}`, 'err')
  } finally {
    delete pluginAction[id]
  }
}

async function removePlugin(id: string) {
  if (pluginAction[id]) return
  if (!window.confirm(`确定移除动态插件「${id}」？其源码也会从 OPFS 删除。`)) return
  pluginAction[id] = 'remove'
  try {
    await pluginManager.remove(id)
  } catch (e) {
    log(`移除插件 ${id} 失败：${(e as Error).message}`, 'err')
  } finally {
    delete pluginAction[id]
  }
}

const STATUS_LABEL: Record<string, string> = {
  stored: '待恢复',
  loading: '加载中',
  active: '运行中',
  reloading: '热重载中',
  failed: '失败',
  disabled: '已禁用',
}

function statusTone(status: string): string {
  if (status === 'active') return 'on'
  if (status === 'failed') return 'bad'
  if (status === 'disabled') return 'off'
  return 'wait'
}

interface DisplayToolCall {
  id?: string
  function?: {
    name?: string
    arguments?: string
  }
}

function getToolCalls(message: ChatMessage): DisplayToolCall[] {
  if (!Array.isArray(message.tool_calls)) return []
  return message.tool_calls as DisplayToolCall[]
}

function summarizeArgs(s?: string): string {
  const raw = s || ''
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const parts: string[] = []
    if (o.command) parts.push(String(o.command))
    if (o.path) parts.push(String(o.path))
    if (o.name) parts.push(String(o.name))
    if (o.sides) parts.push(`sides=${String(o.sides)}`)
    if (o.code) parts.push(`${String(o.code).slice(0, 40)}…`)
    if (o.content) parts.push(`内容 ${String(o.content).length} 字符`)
    return parts.join(', ')
  } catch {
    return raw.slice(0, 60)
  }
}

function truncate(s: string): string {
  return s.length > 500 ? s.slice(0, 500) + `\n…（共 ${s.length} 字符）` : s
}

function scrollChat() {
  nextTick(() => {
    const el = document.getElementById('chat')
    if (el) el.scrollTop = el.scrollHeight
  })
}

function scrollLog() {
  nextTick(() => {
    const el = document.getElementById('syslog')
    if (el) el.scrollTop = el.scrollHeight
  })
}

watchEffect(() => {
  messages.value.length
  scrollChat()
})

watchEffect(() => {
  syslogs.length
  scrollLog()
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">SELF-MODIFYING AGENT DEMO</p>
        <h1>和 agent 对话，看它现场加载插件</h1>
        <p class="lede">
          打开网页 → 聊天 → agent 用 <code>create_plugin</code> 给自己加能力 →
          插件在右侧热加载 → 同一轮对话里马上使用。
        </p>
      </div>

      <div class="top-actions">
        <button class="primary" :disabled="working || connected" @click="runDemo">
          {{ demoRunning ? '演示进行中…' : '▶ 运行插件演示' }}
        </button>
        <span class="model-pill" :class="connected ? 'on' : 'off'">
          <span class="dot" :class="connected ? 'on' : 'off'"></span>
          {{ connecting ? '连接中…' : connected ? cfg.model : '离线演示模式' }}
        </span>
      </div>
    </header>

    <details class="connector" :open="!connected">
      <summary>
        <span>连接真实模型</span>
        <small>不连接也可以先运行插件演示</small>
      </summary>

      <form class="connector-form" @submit.prevent="connect">
        <label class="field">
          <span>Base URL</span>
          <input v-model="cfg.baseURL" type="text" :disabled="connected || connecting" />
        </label>
        <label class="field">
          <span>Model</span>
          <input v-model="cfg.model" type="text" :disabled="connected || connecting" />
        </label>
        <label class="field">
          <span>API Key</span>
          <input
            v-model="cfg.apiKey"
            type="password"
            placeholder="sk-..."
            :disabled="connected || connecting"
          />
        </label>
        <div class="actions">
          <button type="submit" class="primary" :disabled="connected || connecting || !cfg.apiKey">
            {{ connecting ? '挂载中…' : connected ? '已连接' : '连接并挂载 LLM' }}
          </button>
          <button type="button" class="danger" :disabled="!connected || running" @click="disconnect">
            断开
          </button>
        </div>
      </form>
    </details>

    <main class="layout">
      <section class="chat-column">
        <div class="panel chat-panel">
          <div class="panel-head">
            <div>
              <h2>对话</h2>
              <p>模型思考 → 工具调用 → 结果回填；演示模式不调用模型，直接展示真实插件链路。</p>
            </div>
            <span class="count">{{ activePlugins.length }} 个插件在线</span>
          </div>

          <div id="chat">
            <div v-if="!visibleMessages.length" class="welcome">
              <strong>不用 API key，先看核心能力。</strong>
              <span>
                点击右上角“运行插件演示”，或连接模型后直接告诉 agent 要做什么。
              </span>
            </div>

            <template v-for="(m, i) in visibleMessages" :key="i">
              <div v-if="m.role === 'user'" class="msg user">
                <span class="who">你</span>{{ m.content }}
              </div>
              <div v-else-if="m.role === 'assistant'" class="msg assistant">
                <span class="who">agent</span>{{ m.content || '（调用工具中…）' }}
                <div
                  v-for="(tc, j) in getToolCalls(m)"
                  :key="j"
                  class="toolcall"
                >
                  🔧 {{ tc.function?.name }}({{ summarizeArgs(tc.function?.arguments) }})
                </div>
              </div>
              <div v-else-if="m.role === 'tool'" class="msg tool">
                <span class="who">工具结果 · {{ m.name }}</span>{{ truncate(m.content) }}
              </div>
              <div v-else class="msg note">
                <span class="who">系统</span>{{ m.content }}
              </div>
            </template>

            <div v-if="working" class="working">
              {{ demoRunning ? '⏳ 正在加载插件并执行演示…' : '⏳ agent 工作中…' }}
            </div>
          </div>

          <textarea
            v-model="goal"
            placeholder="例如：写一个贪吃蛇游戏到 index.html；或统计 1 到 100 的质数"
            :disabled="!connected || working"
            @keydown.ctrl.enter.prevent="run"
            @keydown.meta.enter.prevent="run"
          ></textarea>

          <div class="actions">
            <button class="primary" :disabled="!connected || working || !goal.trim()" @click="run">
              运行（Ctrl / ⌘ + Enter）
            </button>
            <button class="danger" :disabled="!working" @click="stop">停止</button>
            <button :disabled="working || resetting" @click="resetWorkspace">
              {{ resetting ? '清理中…' : '清空会话与工作区' }}
            </button>
          </div>
        </div>
      </section>

      <aside class="side-column">
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>插件现场</h2>
              <p>agent 在聊天中创建或更新的动态插件会实时出现在这里。</p>
            </div>
            <span class="count">{{ plugins.length }}</span>
          </div>

          <div v-if="!plugins.length" class="empty">
            还没有动态插件。运行右上角演示后，会看到 <code>dice</code> 被加载。
          </div>

          <div v-for="p in plugins" :key="p.id" class="plugin-row">
            <div class="plugin-head">
              <span class="dot" :class="statusTone(p.status)"></span>
              <code>{{ p.id }}</code>
              <span class="plugin-meta">rev {{ p.revision }} · {{ STATUS_LABEL[p.status] ?? p.status }}</span>
            </div>
            <div v-if="p.error" class="plugin-error">{{ p.error }}</div>
            <div class="plugin-actions">
              <button :disabled="!!pluginAction[p.id]" @click="togglePlugin(p.id, p.enabled)">
                {{ p.enabled ? '禁用' : '启用' }}
              </button>
              <button class="danger" :disabled="!!pluginAction[p.id]" @click="removePlugin(p.id)">
                移除
              </button>
            </div>
          </div>
        </section>

        <section v-if="fileList.length || selectedFile" class="panel">
          <div class="panel-head">
            <div>
              <h2>工作区文件</h2>
              <p>agent 写出的文件会出现在这里，可预览 index.html。</p>
            </div>
            <span class="count">{{ fileList.length }}</span>
          </div>

          <div
            v-for="f in fileList"
            :key="f"
            class="file"
            :class="{ active: selectedFile === f }"
            @click="selectedFile = f"
          >
            📄 {{ f }}
          </div>

          <div v-if="selectedFile" class="fileview">
            <div class="fileview-meta">
              <code>{{ selectedFile }}</code>
              <span>{{ selectedFileStats.lines }} 行 · {{ selectedFileStats.chars }} 字符</span>
            </div>
            <pre>{{ readFile(selectedFile) }}</pre>
          </div>

          <button
            v-if="fileList.includes('index.html')"
            class="primary preview-toggle"
            @click="showPreview = !showPreview"
          >
            {{ showPreview ? '关闭预览' : '预览 index.html' }}
          </button>
        </section>

        <section v-if="showPreview" class="panel">
          <div class="panel-head">
            <div>
              <h2>实时预览</h2>
              <p>iframe 沙箱运行工作区里的 index.html。</p>
            </div>
          </div>
          <iframe sandbox="allow-scripts" :srcdoc="previewHtml" title="index.html 预览"></iframe>
        </section>

        <section v-if="widgetList.length" class="panel">
          <div class="panel-head">
            <div>
              <h2>动态组件</h2>
              <p>agent 注册的 Vue 组件。</p>
            </div>
            <span class="count">{{ widgetList.length }}</span>
          </div>
          <div v-for="w in widgetList" :key="w.name" class="widget">
            <div class="widget-head">🔌 {{ w.name }}</div>
            <component :is="w.comp" />
          </div>
        </section>

        <section class="panel log-panel">
          <div class="panel-head">
            <div>
              <h2>运行时日志</h2>
              <p>插件挂载、卸载、热重载与错误。</p>
            </div>
          </div>
          <div id="syslog">
            <div v-for="(l, i) in syslogs" :key="i" :class="l.level">· {{ l.text }}</div>
          </div>
        </section>
      </aside>
    </main>
  </div>
</template>

<style>
:root {
  color-scheme: dark;
  --bg: #0b0e14;
  --panel: #121722;
  --panel-2: #171d2a;
  --border: #252e3e;
  --border-soft: #1d2635;
  --text: #dbe2ee;
  --muted: #8b96a8;
  --faint: #59667a;
  --accent: #4d9fff;
  --accent-strong: #6fb0ff;
  --good: #55d68b;
  --warn: #e5b85c;
  --bad: #f06c75;
  --mono: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, Menlo, monospace;
}

* {
  box-sizing: border-box;
}

body {
  font-family: var(--mono);
  background: var(--bg);
  color: var(--text);
  margin: 0;
  min-height: 100vh;
}

button,
input,
textarea {
  font: inherit;
}

button {
  background: #202839;
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 13px;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    opacity 0.15s ease;
}

button:hover:not(:disabled) {
  border-color: var(--accent);
  background: #27324a;
}

button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

button.primary {
  background: #153d64;
  border-color: #2564a3;
  color: #f4f8ff;
}

button.primary:hover:not(:disabled) {
  background: #1c4c7c;
  border-color: var(--accent-strong);
}

button.danger:hover:not(:disabled) {
  border-color: var(--bad);
  background: #42212c;
}

input,
textarea {
  width: 100%;
  background: #0d111a;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  padding: 9px 11px;
  font-size: 13px;
  outline: none;
}

input:focus,
textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgb(77 159 255 / 0.12);
}

textarea {
  resize: vertical;
  min-height: 88px;
  line-height: 1.6;
}

.app-shell {
  width: min(1440px, 100%);
  margin: 0 auto;
  padding: 22px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-end;
  padding: 14px 2px 18px;
}

.eyebrow {
  color: var(--accent);
  font-size: 10px;
  letter-spacing: 2px;
  margin: 0 0 8px;
}

h1 {
  font-size: 28px;
  line-height: 1.15;
  margin: 0;
  letter-spacing: -0.04em;
}

.lede {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
  max-width: 760px;
  margin: 10px 0 0;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.model-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 9px;
}

.model-pill.on {
  color: var(--good);
  border-color: rgb(85 214 139 / 0.35);
  background: rgb(85 214 139 / 0.08);
}

.connector {
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: 12px;
  margin-bottom: 16px;
  overflow: hidden;
}

.connector summary {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 14px;
  cursor: pointer;
  color: var(--text);
  font-size: 12px;
  list-style: none;
}

.connector summary::-webkit-details-marker {
  display: none;
}

.connector summary small {
  color: var(--muted);
}

.connector-form {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  padding: 4px 14px 14px;
  border-top: 1px solid var(--border-soft);
}

.field {
  display: block;
}

.field span {
  display: block;
  color: var(--muted);
  font-size: 11px;
  margin-bottom: 5px;
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  gap: 16px;
  align-items: start;
}

.chat-column,
.side-column {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.panel {
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: 14px;
  padding: 16px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 13px;
}

.panel h2 {
  font-size: 12px;
  margin: 0 0 5px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.panel p {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
  margin: 0;
}

.count {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 11px;
  padding: 4px 7px;
  border-radius: 6px;
  background: var(--panel-2);
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.actions button {
  margin: 0;
}

#chat {
  max-height: 520px;
  overflow-y: auto;
  font-size: 12.5px;
  line-height: 1.7;
  margin-bottom: 14px;
  padding-right: 4px;
}

.welcome {
  color: var(--muted);
  font-size: 12px;
  padding: 18px 14px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  display: grid;
  gap: 5px;
}

.welcome strong {
  color: var(--text);
}

.msg {
  margin-bottom: 10px;
  padding: 9px 11px;
  border-radius: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg.user {
  background: #173a5c;
  border: 1px solid #245787;
}

.msg.assistant {
  background: var(--panel-2);
  border: 1px solid var(--border-soft);
}

.msg.tool {
  background: #121720;
  border: 1px solid var(--border-soft);
  border-left: 3px solid var(--warn);
  color: #b7c0cf;
  font-size: 12px;
}

.msg.note {
  background: #18141f;
  border: 1px solid #2d243a;
  border-left: 3px solid #9b7fbd;
  color: #c4b9d4;
  font-size: 12px;
}

.msg .who {
  display: block;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 5px;
}

.toolcall {
  background: #0f1726;
  border-left: 3px solid var(--accent);
  padding: 6px 8px;
  margin-top: 7px;
  border-radius: 5px;
  font-size: 11.5px;
  color: #a9c8ef;
  word-break: break-word;
}

.working {
  color: var(--accent-strong);
  font-size: 12px;
  padding: 6px 0;
}

.empty {
  color: var(--faint);
  font-size: 11.5px;
  line-height: 1.6;
}

.plugin-row {
  border: 1px solid var(--border-soft);
  border-radius: 9px;
  padding: 9px 10px;
  margin-bottom: 8px;
  font-size: 12px;
  background: var(--panel-2);
}

.plugin-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.plugin-head code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-meta {
  color: var(--muted);
  font-size: 10.5px;
  margin-left: auto;
  white-space: nowrap;
}

.plugin-error {
  color: var(--bad);
  font-size: 11px;
  margin-top: 7px;
  white-space: pre-wrap;
  word-break: break-word;
}

.plugin-actions {
  display: flex;
  gap: 7px;
  margin-top: 9px;
}

.plugin-actions button {
  padding: 4px 9px;
  font-size: 11px;
}

.file {
  font-size: 12.5px;
  padding: 5px 7px;
  border-radius: 7px;
  cursor: pointer;
  color: #a9c8ef;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file:hover,
.file.active {
  background: #1b2536;
  color: #eaf2ff;
}

.fileview {
  margin-top: 10px;
  border: 1px solid var(--border-soft);
  border-radius: 9px;
  background: #0d111a;
  overflow: hidden;
}

.fileview-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border-soft);
  color: var(--muted);
  font-size: 10.5px;
}

.fileview pre {
  margin: 0;
  padding: 10px;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font: inherit;
  font-size: 11.5px;
  color: #b8c2d2;
}

.preview-toggle {
  margin-top: 12px;
}

iframe {
  width: 100%;
  height: 360px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #fff;
}

.widget {
  border: 1px dashed var(--border);
  border-radius: 9px;
  padding: 10px;
  margin-bottom: 8px;
  background: var(--panel-2);
}

.widget-head {
  color: var(--muted);
  font-size: 11px;
  margin-bottom: 8px;
}

#syslog {
  max-height: 190px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.65;
  color: var(--faint);
}

.ok {
  color: var(--good);
}

.warn {
  color: var(--warn);
}

.err {
  color: var(--bad);
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  background: var(--faint);
}

.dot.on {
  background: var(--good);
}

.dot.off {
  background: var(--faint);
}

.dot.bad {
  background: var(--bad);
}

.dot.wait {
  background: var(--warn);
}

code {
  color: #e8c979;
}

@media (max-width: 1000px) {
  .app-shell {
    padding: 16px;
  }

  .topbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .top-actions {
    justify-content: flex-start;
  }

  .connector-form {
    grid-template-columns: 1fr;
  }

  .layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 680px) {
  .top-actions,
  .top-actions button {
    width: 100%;
  }

  .model-pill {
    width: 100%;
    justify-content: center;
  }
}
</style>
