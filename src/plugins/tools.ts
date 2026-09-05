import { Service, type Context, type Plugin } from '@deepseek-ai/cordis';
import { CfWorkerJsonSchemaValidator, type CfWorkerSchemaDraft } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { shallowReactive } from 'vue';
import { z, type ZodType } from 'zod';
import { capabilityForContext, recordCapabilityContribution } from '@/kernel/capabilities';
import type {
  JsonObject,
  JsonSchema,
  NamedToolDefinition,
  NamedSchemaToolDefinition,
  ToolCatalogEntry,
  ToolAvailability,
  ToolSchema,
  ToolsSnapshot,
} from '@/shared/runtime';
import { errorMessage } from '@/shared/runtime';

interface RuntimeToolDefinition {
  description: string;
  schema: JsonSchema;
  availability?: ToolAvailability;
  parse(args: JsonObject): { success: true; data: JsonObject } | { success: false; error: string };
  run(args: JsonObject): unknown | Promise<unknown>;
}

interface ToolEntry {
  definition: RuntimeToolDefinition;
  owner: string;
}

// MCP tools keep their native JSON Schema dialect. Reuse the official SDK's
// browser-safe validator rather than translating remote schemas into Zod.
const schemaValidators = new Map<CfWorkerSchemaDraft, CfWorkerJsonSchemaValidator>();

function validatorFor(schema: JsonSchema): CfWorkerJsonSchemaValidator {
  const declared = typeof schema.$schema === 'string' ? schema.$schema : '';
  const draft: CfWorkerSchemaDraft = /draft-07/iu.test(declared) ? '7' : '2020-12';
  let validator = schemaValidators.get(draft);
  if (!validator) {
    validator = new CfWorkerJsonSchemaValidator({ draft, shortcircuit: false });
    schemaValidators.set(draft, validator);
  }
  return validator;
}

function callWith(map: ReadonlyMap<string, RuntimeToolDefinition>) {
  return async (name: string, args: JsonObject): Promise<unknown> => {
    const tool = map.get(name);
    if (!tool) return `Error: tool ${name} does not exist (available: ${[...map.keys()].join(', ') || 'none'})`;
    try {
      const parsed = tool.parse(args ?? {});
      if (!parsed.success) return `Error: invalid arguments for ${name}\n${parsed.error}`;
      return await tool.run(parsed.data);
    } catch (error: unknown) {
      return `Error: ${errorMessage(error)}`;
    }
  };
}

function toToolJsonSchema(parameters: ZodType): JsonSchema {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(parameters, { target: 'draft-7' });
  return schema as JsonSchema;
}

const schemasOf = (map: ReadonlyMap<string, RuntimeToolDefinition>): ToolSchema[] => [...map.entries()]
  .map(([name, tool]) => ({ name, description: tool.description, parameters: tool.schema }));

/** Registration and dispatch are one Cordis service, called as ctx.tools.*. */
export class ToolsRuntime extends Service {
  readonly entries = shallowReactive(new Map<string, ToolEntry>());
  private readonly loadedGroups = new Set<string>();

  constructor(ctx: Context) {
    super(ctx, 'tools');
  }

  register<Parameters extends ZodType>(definition: NamedToolDefinition<Parameters>): () => Promise<void> {
    const { name, description, parameters, availability, run } = definition;
    return this.registerRuntime(name, {
      description,
      schema: toToolJsonSchema(parameters),
      ...(availability ? { availability } : {}),
      parse(args) {
        const parsed = parameters.safeParse(args);
        return parsed.success
          ? { success: true, data: parsed.data as JsonObject }
          : { success: false, error: z.prettifyError(parsed.error) };
      },
      run: args => run(args as never),
    });
  }

  registerSchema(definition: NamedSchemaToolDefinition): () => Promise<void> {
    const { name, description, parameters, availability, run } = definition;
    const validate = validatorFor(parameters).getValidator<JsonObject>(parameters as JsonSchemaType);
    return this.registerRuntime(name, {
      description,
      schema: parameters,
      ...(availability ? { availability } : {}),
      parse(args) {
        const result = validate(args);
        return result.valid
          ? { success: true, data: result.data }
          : { success: false, error: result.errorMessage };
      },
      run,
    });
  }

  private registerRuntime(name: string, definition: RuntimeToolDefinition): () => Promise<void> {
    if (!name?.trim()) throw new Error('a tool contribution needs a string name');
    if (typeof definition.run !== 'function') throw new Error(`tool "${name}" needs a run function`);

    const owner = capabilityForContext(this.ctx)?.manifest.id ?? this.ctx.fiber.name;
    const previous = this.entries.get(name);
    if (previous && previous.owner !== owner) {
      throw new Error(`duplicate tool "${name}": already contributed by plugin [${previous.owner}]`);
    }
    const entry: ToolEntry = {
      definition,
      owner,
    };

    return this.ctx.effect(() => {
      this.entries.set(name, entry);
      const disposeContribution = recordCapabilityContribution(owner, 'tools', name);
      return () => {
        if (this.entries.get(name) !== entry) return;
        this.entries.delete(name);
        disposeContribution();
      };
    }, `tools.register(${JSON.stringify(name)})`);
  }

  private definitions(): Map<string, RuntimeToolDefinition> {
    return new Map([...this.entries]
      .filter(([, entry]) => this.isAvailable(entry.definition))
      .map(([name, entry]) => [name, entry.definition]));
  }

  private isAvailable(definition: RuntimeToolDefinition): boolean {
    if (!definition.availability) return true;
    return this.loadedGroups.has(this.groupKey(definition.availability));
  }

  private groupKey(group: ToolAvailability): string {
    const task = this.ctx.get('task');
    if (group.scope === 'task') return `task:${task?.activeTaskId.value ?? 'none'}:${group.id}`;
    if (group.scope === 'site') {
      const active = task?.activeTask();
      const page = active && task?.contexts.find(context => context.taskId === active.id && context.kind === 'page');
      let origin = 'none';
      try { if (page?.locator) origin = new URL(page.locator).origin; } catch { /* invalid locators have no site scope */ }
      return `site:${origin}:${group.id}`;
    }
    return `${group.scope}:${group.id}`;
  }

  schemas(): ToolSchema[] {
    return schemasOf(this.definitions());
  }

  call(name: string, args: JsonObject): Promise<unknown> {
    return callWith(this.definitions())(name, args);
  }

  snapshot(): ToolsSnapshot {
    const frozen = this.definitions();
    return { schemas: schemasOf(frozen), call: callWith(frozen) };
  }

  catalog(): ToolCatalogEntry[] {
    const groups = new Map<string, ToolCatalogEntry>();
    for (const [toolName, entry] of this.entries) {
      if (!entry.definition.availability) continue;
      const group = entry.definition.availability;
      const current = groups.get(group.id) ?? { ...group, tags: [...(group.tags ?? [])], tools: [], loaded: this.isAvailable(entry.definition) };
      current.tools.push(toolName);
      current.loaded ||= this.isAvailable(entry.definition);
      groups.set(group.id, current);
    }
    return [...groups.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  load(id: string): boolean {
    const definition = [...this.entries.values()].map(entry => entry.definition)
      .find(candidate => candidate.availability?.id === id)?.availability;
    if (!definition) return false;
    if (definition.scope === 'task' || definition.scope === 'site') {
      const task = this.ctx.get('task');
      if (!task?.activeTaskId.value || this.groupKey(definition).includes(':none:')) return false;
    }
    this.loadedGroups.add(this.groupKey(definition));
    return true;
  }

  unload(id: string): boolean {
    const definition = [...this.entries.values()].map(entry => entry.definition)
      .find(candidate => candidate.availability?.id === id)?.availability;
    return definition ? this.loadedGroups.delete(this.groupKey(definition)) : false;
  }
}

export default {
  name: 'tools',
  apply(ctx) { new ToolsRuntime(ctx); },
} satisfies Plugin.Object;
