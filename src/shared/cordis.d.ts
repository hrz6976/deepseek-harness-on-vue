import type { ServiceTypes } from './runtime';
import type { HarnessEvents } from './plugin-events';

declare module '@deepseek-ai/cordis' {
  interface Context extends ServiceTypes { }

  interface Events extends HarnessEvents {
    [name: string]: (...args: any[]) => any;
  }
}
