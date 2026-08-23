import type { Fiber, Plugin } from '@deepseek-ai/cordis';
import { runtime } from '@/kernel/cordis';
import { capabilities } from '@/kernel/capabilities';
import { unmountPlugin } from '@/kernel/host';

const fibers: Fiber[] = [];

export async function applyTestPlugin(plugin: Plugin, config?: unknown): Promise<Fiber> {
  const fiber = runtime.plugin(plugin, config) as Fiber;
  fibers.push(fiber);
  await fiber;
  return fiber;
}

export async function provideTestService(name: string, value: unknown): Promise<Fiber> {
  return applyTestPlugin({
    name: `test-${name}-${crypto.randomUUID()}`,
    apply(ctx) { ctx.provide(name, value); },
  });
}

export async function cleanupTestRuntime(): Promise<void> {
  for (const entry of [...capabilities.values()].reverse()) await unmountPlugin(entry.manifest.id);
  for (const fiber of fibers.splice(0).reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
  capabilities.clear();
}
