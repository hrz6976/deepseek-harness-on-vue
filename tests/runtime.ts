import type { Fiber, Plugin } from '@deepseek-ai/cordis';
import { cordis } from '../src/kernel/cordis';
import { capabilities } from '../src/kernel/capabilities';
import { plugins, unmountPlugin } from '../src/kernel/host';
import { services } from '../src/kernel/services';

const fibers: Fiber[] = [];

export async function applyTestPlugin(plugin: Plugin, config?: unknown): Promise<Fiber> {
  const fiber = cordis.plugin(plugin, config) as Fiber;
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
  for (const entry of [...plugins].reverse()) await unmountPlugin(entry.name);
  for (const fiber of fibers.splice(0).reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
  services.clear();
  capabilities.clear();
}
