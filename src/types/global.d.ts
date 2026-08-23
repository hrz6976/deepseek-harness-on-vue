import type { HarnessRuntimeGlobal } from '@/shared/runtime';

declare global {
  var __harness: HarnessRuntimeGlobal;
}

export {};
