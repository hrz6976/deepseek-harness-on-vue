import { Service, type Context, type Plugin } from '@deepseek-ai/cordis';
import { ref } from 'vue';
import type { ModelProfilesService } from '@/shared/runtime';
import type { LlmProfileSummary } from '@/shared/task-model';
import ModelProfileControl from './model-profile-control';

interface ModelProfileStatus {
  defaultProfileId: string;
  profiles: LlmProfileSummary[];
}

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

export default {
  name: 'model-profiles',
  inject: ['broker', 'ui'],
  async apply(ctx: Context) {
    new BrokerModelProfilesRuntime(ctx);
    await ctx.modelProfiles.refresh().catch(() => undefined);
    ctx.ui.register({ name: 'model-control', region: 'composer-controls', component: ModelProfileControl });
  },
} satisfies Plugin.Object;
