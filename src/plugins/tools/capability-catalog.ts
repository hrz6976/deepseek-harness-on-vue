import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type { JsonObject, JsonValue } from '@/shared/runtime';
import { isSiteUserScript, type SiteSkill } from '@/sdk';

export const name = 'capability-catalog';
export const inject = ['tools', 'prompt', 'manager', 'task'];

const capabilityKindSchema = z.enum([
  'capability', 'tool-group', 'tool', 'provider', 'workflow', 'event-source', 'panel', 'site-skill',
]);
const loadableKindSchema = z.enum(['capability', 'tool-group', 'site-skill']);
const summaryKinds = capabilityKindSchema.options.filter(kind => kind !== 'tool');

interface SearchRecord extends JsonObject {
  kind: z.infer<typeof capabilityKindSchema>;
  id: string;
  title: string;
  description: string;
}

export function apply(ctx: Context): void {
  ctx.tools.register({
    name: 'capability_search',
    description: 'Search typed Harness capabilities without loading every tool into the model prompt. Finds Tool, Provider, Workflow, EventSource, Panel, SiteSkill, tool-group, and plugin capability records.',
    parameters: z.object({
      query: z.string().max(500).default(''),
      kinds: z.array(capabilityKindSchema).max(8).optional(),
      limit: z.number().int().positive().max(100).default(30),
    }),
    async run({ query, kinds, limit }) {
      const wanted = new Set(kinds ?? (query.trim() ? capabilityKindSchema.options : summaryKinds));
      const records: SearchRecord[] = [];
      const packages = ctx.manager.catalog();
      const toolGroups = ctx.tools.catalog();
      const groupByTool = new Map(toolGroups.flatMap(group => group.tools.map(tool => [tool, group] as const)));

      if (wanted.has('capability')) {
        for (const entry of packages) records.push({
          kind: 'capability', id: entry.id, title: entry.title, description: entry.description,
          scope: entry.scope, version: entry.version, status: entry.status, attached: entry.attached,
          providers: entry.providers, permissions: entry.permissions, health: entry.health, issues: entry.issues,
        });
      }

      // Loadable groups are the actionable discovery result, so keep them
      // ahead of the usually much longer list of individual tools. Otherwise
      // a bounded catalog response can describe hidden tools while truncating
      // the only record that tells the agent how to make them available.
      if (wanted.has('tool-group')) {
        for (const group of toolGroups) records.push({
          kind: 'tool-group', id: group.id, title: group.title, description: group.description,
          scope: group.scope, tags: group.tags ?? [], tools: group.tools, loaded: group.loaded,
          loadWith: { kind: 'tool-group', id: group.id },
        });
      }

      for (const entry of packages) {
        for (const [kind, names] of [
          ['tool', entry.contributes.tools],
          ['workflow', entry.contributes.workflows],
          ['event-source', entry.contributes.events],
          ['panel', entry.contributes.panels],
        ] as const) {
          if (!wanted.has(kind)) continue;
          for (const contribution of names) {
            const group = kind === 'tool' ? groupByTool.get(contribution) : undefined;
            records.push({
              kind, id: `${entry.id}:${contribution}`, title: contribution,
              description: `${kind} contributed by ${entry.title}.`, capabilityId: entry.id, scope: entry.scope,
              ...(group
                ? { loaded: group.loaded, toolGroupId: group.id, loadWith: { kind: 'tool-group', id: group.id } }
                : kind === 'tool' ? { loaded: true } : {}),
            });
          }
        }
      }

      if (wanted.has('provider')) {
        const providers = new Set(packages.flatMap(entry => entry.providers));
        for (const provider of providers) records.push({
          kind: 'provider', id: provider, title: provider, description: `Trusted ${provider} provider boundary.`,
        });
      }

      if (wanted.has('site-skill')) {
        const broker = ctx.reflect.get('broker') as import('../../shared/runtime').BrokerService | undefined;
        const value = broker ? await broker.request({ provider: 'site-skill', action: 'list', input: {} }) : [];
        for (const skill of readSiteSkills(value)) records.push({
          kind: 'site-skill', id: skill.id, title: skill.name,
          description: `${isSiteUserScript(skill) ? 'User script' : 'Declarative page capability'} for ${skill.matches.join(', ')}.`,
          enabled: skill.enabled, matches: skill.matches,
          ...(isSiteUserScript(skill)
            ? { type: 'userscript', runAt: skill.runAt }
            : { type: 'recipe', operationCount: skill.operations?.length ?? 0, liveRuleCount: skill.liveRules?.length ?? 0 }),
        });
      }

      const needle = query.trim().toLocaleLowerCase();
      return JSON.stringify(records
        .filter(record => !needle || JSON.stringify(record).toLocaleLowerCase().includes(needle))
        .slice(0, limit));
    },
  });

  ctx.tools.register({
    name: 'capability_load',
    description: 'Load a discovered tool group for the current scope, attach a task capability, or apply an enabled Site Skill. Newly loaded AgentTools appear on the next model turn.',
    parameters: z.object({ kind: loadableKindSchema, id: z.string().min(1).max(300) }),
    async run({ kind, id }) {
      if (kind === 'tool-group') {
        const loaded = ctx.tools.load(id);
        return loaded ? `loaded tool group ${id}; its AgentTools will be visible on the next turn` : `Error: tool group ${id} was not found or has no active scope`;
      }
      if (kind === 'site-skill') {
        const broker = ctx.reflect.get('broker') as import('../../shared/runtime').BrokerService | undefined;
        if (!broker) return 'Error: this Harness runtime has no trusted Site Skill provider';
        return JSON.stringify(await broker.request({ provider: 'site-skill', action: 'apply', input: { id } }));
      }
      let entry = ctx.manager.catalog().find(candidate => candidate.id === id);
      if (!entry) return `Error: capability ${id} was not found`;
      if (entry.status !== 'active' && entry.status !== 'pending') {
        const mounted = await ctx.manager.mount(entry.id);
        if (mounted.startsWith('Error:')) return mounted;
        entry = ctx.manager.catalog().find(candidate => candidate.id === id) ?? entry;
      }
      if (entry.scope === 'task') await ctx.task.attachCapability(entry.id);
      const contributedTools = new Set(entry.contributes.tools);
      const groups = ctx.tools.catalog().filter(group => group.tools.some(tool => contributedTools.has(tool)));
      const loadedToolGroups: string[] = [];
      const unavailableToolGroups: string[] = [];
      for (const group of groups) {
        (ctx.tools.load(group.id) ? loadedToolGroups : unavailableToolGroups).push(group.id);
      }
      return JSON.stringify({
        capability: entry.id,
        scope: entry.scope,
        loaded: true,
        loadedToolGroups,
        unavailableToolGroups,
        note: loadedToolGroups.length ? 'The group tools are visible on the next model turn.' : 'This capability has no unloaded tool groups.',
      });
    },
  });

  ctx.tools.register({
    name: 'capability_unload',
    description: 'Unload a task-scoped tool group or detach a task capability. This does not delete plugin source or persisted Site Skills.',
    parameters: z.object({ kind: z.enum(['capability', 'tool-group']), id: z.string().min(1).max(300) }),
    async run({ kind, id }) {
      if (kind === 'tool-group') return JSON.stringify({ id, unloaded: ctx.tools.unload(id) });
      const entry = ctx.manager.catalog().find(candidate => candidate.id === id);
      if (!entry) return `Error: capability ${id} was not found`;
      if (entry.scope !== 'task') return `Error: ${entry.id} has ${entry.scope} scope and cannot be detached from one task`;
      await ctx.task.detachCapability(entry.id);
      return `detached capability ${entry.id} from the active task`;
    },
  });

  ctx.prompt.register({
    name: 'capability-discovery', order: 5,
    text: 'Capabilities are typed and discoverable. Keep the prompt small: an empty capability_search returns capability, provider, and grouped summaries without enumerating every Tool. Use a focused query to search individual tools, or explicitly request kinds:["tool"] when enumeration is required. Search results include loadWith for unavailable tools. Loading a capability also loads its contributed on-demand tool groups; loading a tool-group loads only that group. Newly loaded tools appear on the next model turn. Loaded task tool groups are isolated from other tasks.',
  });
}

function readSiteSkills(value: JsonValue): SiteSkill[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(candidate => candidate
    && typeof candidate === 'object' && !Array.isArray(candidate)
    && typeof candidate.id === 'string' && typeof candidate.name === 'string'
    && Array.isArray(candidate.matches)
    ? [candidate as unknown as SiteSkill]
    : []);
}
