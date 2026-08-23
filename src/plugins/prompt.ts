import { Service, type Context } from '@deepseek-ai/cordis';
import { shallowReactive } from 'vue';
import { capabilityIsActive, recordCapabilityContribution } from '@/kernel/capabilities';
import type { PromptSectionDefinition } from '@/shared/runtime';

interface PromptEntry {
  definition: Omit<PromptSectionDefinition, 'name'>;
  owner: string;
  token: object;
}

/** Ordered prompt contribution registry, called as ctx.prompt.register(). */
export class PromptRuntime extends Service {
  readonly sections = shallowReactive(new Map<string, PromptEntry>());

  constructor(ctx: Context) {
    super(ctx, 'prompt');
  }

  register(definition: PromptSectionDefinition): () => Promise<void> {
    const { name, order = 50, text } = definition;
    if (!name?.trim()) throw new Error('a prompt contribution needs a string name');
    if (typeof text !== 'string' && typeof text !== 'function') {
      throw new Error(`prompt section "${name}" needs string or function text`);
    }

    const owner = this.ctx.fiber.name;
    const previous = this.sections.get(name);
    if (previous && previous.owner !== owner) {
      throw new Error(`duplicate prompt section "${name}": already contributed by plugin [${previous.owner}]`);
    }
    const token = {};
    const entry: PromptEntry = { definition: { order, text }, owner, token };

    return this.ctx.effect(() => {
      this.sections.set(name, entry);
      const disposeContribution = recordCapabilityContribution(owner, 'prompts', name);
      return () => {
        if (this.sections.get(name)?.token === token) this.sections.delete(name);
        disposeContribution();
      };
    }, `prompt.register(${JSON.stringify(name)})`);
  }

  assemble(): string {
    return [...this.sections]
      .filter(([, entry]) => capabilityIsActive(entry.owner))
      .map(([name, entry]) => ({ name, order: entry.definition.order ?? 50, text: entry.definition.text }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map(section => typeof section.text === 'function' ? section.text() : section.text)
      .filter(text => text && String(text).trim())
      .join('\n\n');
  }
}

export const promptPlugin = {
  name: 'prompt',
  apply(ctx: Context) {
    new PromptRuntime(ctx);
  },
};

export default promptPlugin;
