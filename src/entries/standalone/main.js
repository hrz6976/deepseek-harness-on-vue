// Standalone entry. The root app is a bare layout frame — everything else,
// including every UI panel, is a plugin. The frame's only jobs: expose layout
// regions through the layout service (Teleport targets as ELEMENTS, not ids)
// and render one PluginHost per mounted plugin.
import * as Vue from 'vue';
import { services, provideService, useService } from '../../kernel/services.js';
import { bus, useBusOn, useToolGuard, useRequestTransform } from '../../kernel/bus.js';
import { log } from '../../kernel/log.js';
import { plugins, mountPlugin, unmountPlugin, PluginHost } from '../../kernel/host.js';
import { fsPlugin } from '../../plugins/fs.js';
import { toolsPlugin, AgentTool, useTool } from '../../plugins/tools.js';
import { promptPlugin, PromptSection, usePromptSection } from '../../plugins/prompt.js';
import { managerPlugin } from '../../plugins/manager.js';
import { statePlugin } from '../../plugins/state.js';
import { loopPlugin } from '../../plugins/loop.js';
import { compactionPlugin } from '../../plugins/compaction.js';
import { fileEditorPlugin } from '../../plugins/tools/file-editor.js';
import { runJsPlugin } from '../../plugins/tools/run-js.js';
import { createPluginPlugin } from '../../plugins/tools/create-plugin.js';
import { removePluginPlugin } from '../../plugins/tools/remove-plugin.js';
import { readStatePlugin } from '../../plugins/tools/read-state.js';
import { settingsPlugin } from '../../plugins/ui/settings.js';
import { chatPlugin } from '../../plugins/ui/chat.js';
import { filesPlugin } from '../../plugins/ui/files.js';
import { previewPlugin } from '../../plugins/ui/preview.js';
import { syslogPlugin } from '../../plugins/ui/syslog.js';

const { createApp, shallowReactive } = Vue;

const App = {
  name: 'HarnessFrame',
  template: `
    <h1>DeepSeek Harness on Vue</h1>
    <div class="sub">everything is a plugin (fs / tools / prompt / llm / loop / every panel) · mount = register, unmount = dispose · LLM via pi-ai custom DeepSeek provider</div>
    <div class="layout">
      <div :ref="el => setRegion('main', el)"></div>
      <div>
        <div :ref="el => setRegion('side', el)"></div>
        <div class="panel">
          <h2>Plugins ({{ plugins.length }} mounted; dynamic plugin UI renders here)</h2>
          <div v-for="p in plugins" :key="p.name + ':' + p.version" class="plugin-box">
            <div class="pname">🔌 {{ p.name }}
              <span class="badge">{{ p.builtin ? 'built-in' : 'dynamic' }}</span>
              <span v-if="p.hmrError" class="badge hmr">HMR failed, old version running</span>
            </div>
            <PluginHost :plugin="p" />
          </div>
        </div>
      </div>
    </div>`,
  setup() {
    const regions = shallowReactive(new Map());
    // Layout-first: regions register as the frame's elements mount, before/
    // reactively-visible-to any plugin Teleport (they v-if on the target).
    provideService('layout', { regions, target: name => regions.get(name) ?? null });
    const setRegion = (name, el) => { if (el) regions.set(name, el); };
    return { plugins, setRegion };
  },
};

const app = createApp(App);
// Contribution components are global so runtime-compiled plugin templates use
// them with zero imports.
app.component('PluginHost', PluginHost);
app.component('AgentTool', AgentTool);
app.component('PromptSection', PromptSection);
// Injection face for dynamic plugins (PoC-compatible).
app.provide('services', services);
app.provide('bus', bus);
app.provide('log', log);

// The agent-facing runtime surface. Namespaced — NEVER window.Vue: Phase-2
// host pages may own window.Vue, and there must be exactly ONE Vue namespace
// across the shipped/self-modified boundary or reactivity silently breaks.
globalThis.__harness = Object.freeze({
  Vue, services, bus, log,
  useService, useBusOn, useToolGuard, useRequestTransform, useTool, usePromptSection,
  mountPlugin, unmountPlugin,
});

// Built-in plugin set: static ESM imports (bundled, debuggable, real stack
// traces), same component shape as dynamic plugins — only the loading path
// differs. Mount order is irrelevant: dependencies are readiness-driven
// through the reactive service registry. llm is mounted by ui:settings.
mountPlugin('fs', fsPlugin, { builtin: true });
mountPlugin('tools', toolsPlugin, { builtin: true });
mountPlugin('prompt', promptPlugin, { builtin: true });
mountPlugin('manager', managerPlugin, { builtin: true });
mountPlugin('state', statePlugin, { builtin: true });
mountPlugin('loop', loopPlugin, { builtin: true });
mountPlugin('compaction', compactionPlugin, { builtin: true });
mountPlugin('tool:file-editor', fileEditorPlugin, { builtin: true });
mountPlugin('tool:run-js', runJsPlugin, { builtin: true });
mountPlugin('tool:create-plugin', createPluginPlugin, { builtin: true });
mountPlugin('tool:remove-plugin', removePluginPlugin, { builtin: true });
mountPlugin('tool:read-state', readStatePlugin, { builtin: true });
mountPlugin('ui:settings', settingsPlugin, { builtin: true });
mountPlugin('ui:chat', chatPlugin, { builtin: true });
mountPlugin('ui:files', filesPlugin, { builtin: true });
mountPlugin('ui:preview', previewPlugin, { builtin: true });
mountPlugin('ui:syslog', syslogPlugin, { builtin: true });

app.mount('#app');
