import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type { ArtifactKind, ArtifactStatus } from '@/shared/task-model';

const ARTIFACT_KINDS = ['change-set', 'file', 'site-skill', 'workflow', 'dynamic-ui', 'dataset', 'report', 'capability'] as const satisfies readonly ArtifactKind[];
const ARTIFACT_STATUSES = ['draft', 'ready', 'verified', 'failed', 'archived'] as const satisfies readonly ArtifactStatus[];

export const name = 'artifacts';
export const inject = ['task', 'fs', 'tools', 'prompt'];

export function apply(ctx: Context): void {
  const emptyParameters = z.object({});
  const createParameters = z.object({
    kind: z.enum(ARTIFACT_KINDS),
    title: z.string().min(1),
    status: z.enum(ARTIFACT_STATUSES).default('ready'),
    contentPath: z.string().min(1).describe('Workspace path when the artifact content already lives in a file.').optional(),
    content: z.json().describe('Small JSON content. Put large text or binary content in the workspace and use contentPath.').optional(),
    verificationSummary: z.string().optional(),
  });
  const fileParameters = z.object({
    path: z.string().min(1),
    title: z.string().optional(),
  });

  ctx.tools.register({
    name: 'artifact_create',
    description: 'Create a durable, versioned task artifact. Use this for reports, datasets, workflows, generated UI/capabilities, files, and page ChangeSets instead of leaving valuable results only in chat.',
    parameters: createParameters,
    async run({ kind, title, status, contentPath, content, verificationSummary }) {
      if (contentPath && ctx.fs.read(contentPath) == null) return `Error: workspace file ${contentPath} does not exist`;
      const artifact = await ctx.task.createArtifact({
        kind, title, status, source: { type: 'agent' },
        ...(contentPath ? { contentPath } : {}),
        ...(content !== undefined ? { content } : {}),
        verification: verificationSummary
          ? { status: status === 'verified' ? 'passed' : 'unverified', summary: verificationSummary, checkedAt: Date.now() }
          : { status: 'unverified' },
      });
      await ctx.task.appendEvent('artifact/created', { artifactId: artifact.id, kind: artifact.kind, title: artifact.title });
      return JSON.stringify(artifact);
    },
  });
  ctx.tools.register({
    name: 'artifact_list', description: 'List durable artifacts attached to the active task.', parameters: emptyParameters,
    run() {
      const active = ctx.task.activeTask();
      return JSON.stringify(active ? ctx.task.artifacts.filter(artifact => artifact.taskId === active.id) : []);
    },
  });
  ctx.tools.register({
    name: 'context_list', description: 'List page, file, selection, and MCP contexts attached to the active task.', parameters: emptyParameters,
    run() {
      const active = ctx.task.activeTask();
      return JSON.stringify(active ? ctx.task.contexts.filter(context => context.taskId === active.id) : []);
    },
  });
  ctx.tools.register({
    name: 'context_attach_file', description: 'Attach an existing workspace file to the active task as reusable context.', parameters: fileParameters,
    async run({ path, title }) {
      const content = ctx.fs.read(path);
      if (content == null) return `Error: workspace file ${path} does not exist`;
      const context = await ctx.task.addContext({
        kind: 'file', title: title?.trim() || path.split('/').at(-1) || path, locator: path, metadata: { size: content.length },
      });
      await ctx.task.appendEvent('context/attached', { contextId: context.id, kind: 'file', locator: path });
      return JSON.stringify(context);
    },
  });
  ctx.prompt.register({
    name: 'task-artifacts', order: 8,
    text: 'Tasks, contexts, and artifacts are first-class. Attach relevant workspace files with context_attach_file. Persist valuable outputs with artifact_create; keep large content in workspace files and point to contentPath. A page patch is a change-set, a persisted page procedure is a site-skill, and runtime code with tools or UI is a capability.',
  });
}

export default { name, inject, apply };
