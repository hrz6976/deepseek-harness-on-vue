import { Service, type Context } from '@deepseek-ai/cordis';
import { reactive } from 'vue';
import type { ModelConnectionConfig, ModelConnectionService } from '@/shared/runtime';

const LS = { baseURL: 'harness.baseURL', model: 'harness.model', apiKey: 'harness.apiKey', mock: 'harness.mock', auto: 'harness.autoconnect' };

/** Standalone connection ownership survives settings panel removal or replacement. */
export class ModelConnection extends Service implements ModelConnectionService {
  readonly config = reactive({
    baseURL: localStorage.getItem(LS.baseURL) || '/proxy',
    model: localStorage.getItem(LS.model) || 'deepseek-v4-flash',
    apiKey: localStorage.getItem(LS.apiKey) || '',
    mock: localStorage.getItem(LS.mock) === '1',
  });

  constructor(ctx: Context) { super(ctx, 'modelConnection'); }

  async connect(config: ModelConnectionConfig): Promise<void> {
    const result = await this.ctx.manager.mount('llm', { cfg: { ...config } });
    if (result.startsWith('Error:')) throw new Error(result);
    localStorage.setItem(LS.baseURL, config.baseURL);
    localStorage.setItem(LS.model, config.model);
    localStorage.setItem(LS.apiKey, config.apiKey);
    localStorage.setItem(LS.mock, config.mock ? '1' : '0');
    localStorage.setItem(LS.auto, '1');
    Object.assign(this.config, config);
  }

  async disconnect(): Promise<void> {
    if (this.ctx.task.signal) throw new Error('Stop the active run before disconnecting.');
    const result = await this.ctx.manager.unmount('llm');
    if (result.startsWith('Error:')) throw new Error(result);
    localStorage.setItem(LS.auto, '0');
  }

  async restore(): Promise<void> {
    const config = this.config;
    if (!this.ctx.get('llm') && localStorage.getItem(LS.auto) === '1'
      && (config.apiKey || config.mock || config.baseURL.startsWith('/'))) await this.connect(config);
  }
}
