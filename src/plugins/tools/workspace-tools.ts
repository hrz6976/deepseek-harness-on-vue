import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { systemPluginNameFromPath } from '@/sdk';

export const name = 'workspace-tools';
export const inject = ['fs', 'tools', 'prompt'];

const WORKSPACE_GROUP = {
  id: 'workspace.advanced',
  title: 'Workspace Search and Diff',
  description: 'Bounded multi-file listing, reading, literal search, proposed-content diff, replace, write, and remove over the virtual workspace.',
  scope: 'task',
  tags: ['workspace', 'search', 'diff', 'files'],
} as const;

export function apply(ctx: Context): void {
  ctx.tools.register({
    name: 'workspace_list',
    description: 'List bounded workspace paths, optionally under a prefix. Internal Harness metadata is hidden unless explicitly requested.',
    availability: WORKSPACE_GROUP,
    parameters: z.object({
      prefix: z.string().max(1_000).default(''),
      includeInternal: z.boolean().default(false),
      limit: z.number().int().positive().max(5_000).default(500),
    }),
    run({ prefix, includeInternal, limit }) {
      const paths = ctx.fs.list().filter(path => path.startsWith(prefix)
        && (includeInternal || (!path.startsWith('.harness/') && !path.startsWith('.plugins/'))));
      return JSON.stringify({ paths: paths.slice(0, limit), total: paths.length, truncated: paths.length > limit });
    },
  });

  ctx.tools.register({
    name: 'workspace_read',
    description: 'Read one workspace file or a bounded 1-based line range.',
    availability: WORKSPACE_GROUP,
    parameters: z.object({
      path: z.string().min(1).max(1_000),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    }),
    run({ path, startLine, endLine }) {
      const source = ctx.fs.read(path);
      if (source == null) return `Error: ${path} does not exist`;
      if (!startLine && !endLine) return source;
      const lines = source.split('\n');
      const start = Math.max((startLine ?? 1) - 1, 0);
      const end = Math.min(endLine ?? lines.length, lines.length);
      return lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
    },
  });

  ctx.tools.register({
    name: 'workspace_search',
    description: 'Search literal text across workspace files with bounded results. Returns path, line, column, and a short preview.',
    availability: WORKSPACE_GROUP,
    parameters: z.object({
      query: z.string().min(1).max(10_000),
      prefix: z.string().max(1_000).default(''),
      caseSensitive: z.boolean().default(false),
      includeInternal: z.boolean().default(false),
      maxMatches: z.number().int().positive().max(2_000).default(200),
    }),
    run({ query, prefix, caseSensitive, includeInternal, maxMatches }) {
      const needle = caseSensitive ? query : query.toLocaleLowerCase();
      const matches: Array<{ path: string; line: number; column: number; preview: string }> = [];
      for (const path of ctx.fs.list()) {
        if (!path.startsWith(prefix) || (!includeInternal && (path.startsWith('.harness/') || path.startsWith('.plugins/')))) continue;
        const lines = (ctx.fs.read(path) ?? '').split('\n');
        for (let index = 0; index < lines.length; index++) {
          const haystack = caseSensitive ? lines[index]! : lines[index]!.toLocaleLowerCase();
          const column = haystack.indexOf(needle);
          if (column < 0) continue;
          matches.push({ path, line: index + 1, column: column + 1, preview: lines[index]!.trim().slice(0, 300) });
          if (matches.length >= maxMatches) return JSON.stringify({ matches, truncated: true });
        }
      }
      return JSON.stringify({ matches, truncated: false });
    },
  });

  ctx.tools.register({
    name: 'workspace_diff',
    description: 'Preview a compact line diff between an existing workspace file and proposed full content without writing it.',
    availability: WORKSPACE_GROUP,
    parameters: z.object({ path: z.string().min(1).max(1_000), content: z.string().max(10_000_000) }),
    run({ path, content }) {
      const before = ctx.fs.read(path);
      if (before == null) return proposedContentDiff('', content, path, true);
      return proposedContentDiff(before, content, path, false);
    },
  });

  ctx.tools.register({
    name: 'workspace_write',
    description: 'Create or fully replace a workspace file. The trusted provider applies optimistic revision checks against other open Harness panels.',
    availability: WORKSPACE_GROUP,
    parameters: z.object({ path: z.string().min(1).max(1_000), content: z.string().max(10_000_000) }),
    async run({ path, content }) {
      const systemName = systemPluginNameFromPath(path);
      if (systemName) return `Error: ${systemName} is a bundled system plugin and cannot be overwritten from the workspace`;
      await ctx.fs.write(path, content);
      return `wrote ${path} (${content.length} chars)`;
    },
  });

  ctx.tools.register({
    name: 'workspace_replace',
    description: 'Replace one exact string in a workspace file, failing when it is absent or ambiguous unless replaceAll is set.',
    availability: WORKSPACE_GROUP,
    parameters: z.object({
      path: z.string().min(1).max(1_000), oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().default(false),
    }),
    async run({ path, oldText, newText, replaceAll }) {
      const systemName = systemPluginNameFromPath(path);
      if (systemName) return `Error: ${systemName} is a bundled system plugin and cannot be overwritten from the workspace`;
      const source = ctx.fs.read(path);
      if (source == null) return `Error: ${path} does not exist`;
      const occurrences = source.split(oldText).length - 1;
      if (!occurrences) return `Error: oldText was not found in ${path}`;
      if (occurrences > 1 && !replaceAll) return `Error: oldText occurs ${occurrences} times in ${path}; make it unique or set replaceAll`;
      const next = replaceAll ? source.split(oldText).join(newText) : source.replace(oldText, newText);
      await ctx.fs.write(path, next);
      return `edited ${path} (${replaceAll ? occurrences : 1} replacement${occurrences === 1 ? '' : 's'})`;
    },
  });

  ctx.tools.register({
    name: 'workspace_remove',
    description: 'Remove one workspace file. Use only when deletion is part of the user request or clearly necessary for the current task.',
    availability: WORKSPACE_GROUP,
    parameters: z.object({ path: z.string().min(1).max(1_000) }),
    async run({ path }) {
      if (ctx.fs.read(path) == null) return `Error: ${path} does not exist`;
      await ctx.fs.remove(path);
      return `removed ${path}`;
    },
  });

  ctx.prompt.register({
    name: 'workspace-discovery', order: 18,
    text: 'For multi-file work, search, or diff-first edits, load workspace.advanced through capability_load. Workspace execution is intentionally not advertised: this browser runtime currently has no trusted command/build provider, so do not claim tests or builds ran unless a real provider result says so.',
  });
}

function proposedContentDiff(before: string, after: string, path: string, created: boolean): string {
  if (before === after) return `(no changes to ${path})`;
  const left = before.split('\n');
  const right = after.split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  const removed = left.slice(prefix, left.length - suffix);
  const added = right.slice(prefix, right.length - suffix);
  const contextBefore = left.slice(Math.max(0, prefix - 3), prefix);
  const contextAfter = left.slice(left.length - suffix, Math.min(left.length, left.length - suffix + 3));
  return [
    `--- ${created ? '/dev/null' : path}`,
    `+++ ${path}`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...contextBefore.map(line => ` ${line}`),
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
    ...contextAfter.map(line => ` ${line}`),
  ].join('\n');
}
