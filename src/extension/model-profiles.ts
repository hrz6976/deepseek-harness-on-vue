import { Service, type Context } from '@deepseek-ai/cordis';
import { computed, defineComponent, ref } from 'vue';
import { NButton, NIcon, NPopover, NSelect } from 'naive-ui';
import { ChevronDown } from '@vicons/tabler';
import { useService } from '@/kernel/services';
import type { ModelProfilesService } from '@/shared/runtime';
import {
  DEFAULT_SESSION_LLM_CONFIG,
  normalizeSessionLlmConfig,
  type LlmProfileSummary,
  type ReasoningEffort,
  type SessionLlmConfig,
} from '@/shared/task-model';

interface ModelProfileStatus {
  defaultProfileId: string;
  profiles: LlmProfileSummary[];
}

const thinkingOptions = ['off', 'low', 'high', 'max'].map(value => ({
  label: value === 'off' ? '关闭思考' : value[0]!.toUpperCase() + value.slice(1), value,
}));

const ModelProfileControl = defineComponent({
  components: { ChevronDown, NButton, NIcon, NPopover, NSelect },
  template: `
    <n-popover trigger="click" placement="top-end" :show-arrow="false" @update:show="refresh">
      <template #trigger><n-button text size="tiny" :disabled="running" class="session-model-trigger"><span>{{ label }}</span><n-icon class="session-model-chevron"><ChevronDown /></n-icon></n-button></template>
      <div class="session-model-popover">
        <label><span>Provider</span><n-select :value="profileId" :options="profiles" size="small" placeholder="请先配置 Profile" @update:value="selectProfile" /></label>
        <label><span>Model</span><n-select :value="config.model" :options="models" :loading="loadingModels" filterable tag size="small" @update:value="selectModel" /></label>
        <label><span>Thinking</span><n-select :value="thinking" :options="thinkingOptions" size="small" @update:value="selectThinking" /></label>
        <small :class="{ error }">{{ error || 'Provider 与模型应用于所有对话' }}</small>
      </div>
    </n-popover>`,
  setup() {
    const catalog = useService('modelProfiles');
    const task = useService('task');
    const loop = useService('loop');
    const error = ref('');
    const discoveredModels = ref<string[]>([]);
    const loadingModels = ref(false);
    const config = computed(() => normalizeSessionLlmConfig(task.value?.activeTask()?.llm ?? DEFAULT_SESSION_LLM_CONFIG));
    const profileId = computed(() => catalog.value?.effectiveId(config.value.profileId) ?? '');
    const profile = computed(() => catalog.value?.resolve(config.value.profileId));
    const profiles = computed(() => (catalog.value?.profiles.value ?? []).map(({ id, name }) => ({ label: name, value: id })));
    const models = computed(() => [...new Set([...discoveredModels.value, profile.value?.defaultModel, config.value.model].filter(Boolean) as string[])].map(value => ({ label: value, value })));
    const thinking = computed(() => config.value.thinking ? config.value.reasoningEffort : 'off');
    const running = computed(() => loop.value?.running.value ?? false);
    const label = computed(() => `${(profile.value?.name ?? profileId.value) || 'Model'} · ${config.value.model} · ${thinking.value}`);
    const save = (patch: Partial<SessionLlmConfig>) => {
      if (!task.value || running.value) return;
      error.value = '';
      void task.value.setLlmConfig({ ...config.value, ...patch }).catch(reason => { error.value = String(reason); });
    };
    const saveModel = (id: string, model: string) => {
      if (!task.value || running.value) return;
      error.value = '';
      void task.value.setModelSelection(id, model).catch(reason => { error.value = String(reason); });
    };
    const loadModels = async (id = profileId.value) => {
      if (!catalog.value || !id) return;
      loadingModels.value = true;
      try { discoveredModels.value = await catalog.value.models(id); }
      catch (reason) { error.value = String(reason); }
      finally { loadingModels.value = false; }
    };
    const selectProfile = (id: string) => {
      const selected = catalog.value?.resolve(id);
      if (selected) {
        discoveredModels.value = [];
        saveModel(id, selected.defaultModel);
        void loadModels(id);
      }
    };
    const selectModel = (model: string) => saveModel(profileId.value, model);
    const selectThinking = (value: 'off' | ReasoningEffort) => save({ thinking: value !== 'off', ...(value !== 'off' ? { reasoningEffort: value } : {}) });
    const refresh = async (show: boolean) => {
      if (!show || !catalog.value) return;
      try { await catalog.value.refresh(); await loadModels(); }
      catch (reason) { error.value = String(reason); }
    };
    return { config, error, label, loadingModels, models, profileId, profiles, refresh, running, selectModel, selectProfile, selectThinking, thinking, thinkingOptions };
  },
});

class BrokerModelProfilesRuntime extends Service implements ModelProfilesService {
  readonly profiles = ref<LlmProfileSummary[]>([]);
  readonly defaultProfileId = ref('');

  constructor(ctx: Context) {
    super(ctx, 'modelProfiles');
  }

  async refresh(): Promise<void> {
    const status = await this.ctx.broker.request({
      provider: 'llm', action: 'status', input: {},
    }) as unknown as ModelProfileStatus;
    this.profiles.value = status.profiles;
    this.defaultProfileId.value = status.defaultProfileId;
  }

  async models(profileId = ''): Promise<string[]> {
    return await this.ctx.broker.request({
      provider: 'llm', action: 'models', input: { profileId: this.effectiveId(profileId) },
    }) as string[];
  }

  effectiveId(requestedProfileId = ''): string {
    return requestedProfileId.trim() || this.defaultProfileId.value || this.profiles.value[0]?.id || '';
  }

  resolve(requestedProfileId = ''): LlmProfileSummary | null {
    const id = this.effectiveId(requestedProfileId);
    return this.profiles.value.find(profile => profile.id === id) ?? null;
  }
}

export const modelProfilesPlugin = {
  name: 'model-profiles',
  inject: ['broker', 'ui'],
  async apply(ctx: Context) {
    new BrokerModelProfilesRuntime(ctx);
    await ctx.modelProfiles.refresh().catch(() => undefined);
    ctx.ui.register({ name: 'model-control', region: 'composer-controls', component: ModelProfileControl });
  },
};
