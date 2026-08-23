import type { UiService } from '@/kernel/ui';
import type { PromptRuntime } from '@/plugins/prompt';
import type { ToolsRuntime } from '@/plugins/tools';
import type { ServiceTypes } from './runtime';

declare module '@deepseek-ai/cordis' {
  interface Context {
    ui: UiService;
    tools: ToolsRuntime;
    prompt: PromptRuntime;
    fs: ServiceTypes['fs'];
    broker: ServiceTypes['broker'];
    llm: ServiceTypes['llm'];
    loop: ServiceTypes['loop'];
    manager: ServiceTypes['manager'];
    state: ServiceTypes['state'];
    layout: ServiceTypes['layout'];
    compaction: ServiceTypes['compaction'];
    task: ServiceTypes['task'];
  }

  interface Events {
    [name: string]: (...args: any[]) => any;
  }
}
