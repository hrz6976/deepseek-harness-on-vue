import type { ServiceTypes } from './runtime';

declare module '@deepseek-ai/cordis' {
  interface Context extends ServiceTypes {}

  interface Events {
    [name: string]: (...args: any[]) => any;
  }
}
