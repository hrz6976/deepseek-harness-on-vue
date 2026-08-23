import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { systemPluginNameFromPath } from '@/sdk';

export const name = 'file-editor';
export const inject = ['fs', 'tools', 'prompt'];

export function apply(ctx: Context): void {
  const description = 'Operate the virtual filesystem: list all files; view a file; write (create or fully overwrite) a file; str_replace replaces old_str with new_str inside a file';
  const parameters = z.object({
    command: z.enum(['list', 'view', 'write', 'str_replace']),
    path: z.string().describe('File path, e.g. index.html.').default(''),
    content: z.string().describe('Full content for write.').default(''),
    old_str: z.string().default(''),
    new_str: z.string().default(''),
  });
  const guidance = [
    'Manage files with file_editor: list to see what exists, write to create, view to check contents, str_replace for local edits.',
    'View a file before modifying it.',
    'If the user asks for a web page/game/tool, put ALL code in a single index.html (inline <style> and <script>) so it can be previewed directly.',
    'Non-system files under .plugins/ are editable Cordis capability plugins. Editing one compiles a replacement before its old Fiber is disposed. Framework services are bundled and cannot be overwritten from the workspace.',
  ].join('\n');

  ctx.tools.register({
    name: 'file_editor', description, parameters,
    async run({ command, path, content, old_str, new_str }) {
      if (command === 'list') return ctx.fs.list().join('\n') || '(empty)';
      if (command === 'view') { const value = ctx.fs.read(path); return value === null ? `Error: ${path} does not exist` : value; }
      if (command === 'write') {
        const systemName = systemPluginNameFromPath(path);
        if (systemName) return `Error: ${systemName} is a bundled system plugin and cannot be overwritten from the workspace`;
        await ctx.fs.write(path, content);
        return `wrote ${path} (${content.length} chars)`;
      }
      if (command === 'str_replace') {
        const systemName = systemPluginNameFromPath(path);
        if (systemName) return `Error: ${systemName} is a bundled system plugin and cannot be overwritten from the workspace`;
        const value = ctx.fs.read(path);
        if (value === null) return `Error: ${path} does not exist`;
        if (!value.includes(old_str)) return `Error: old_str not found in ${path}`;
        await ctx.fs.write(path, value.replace(old_str, new_str));
        return `edited ${path}`;
      }
      return `Error: unknown command ${command}`;
    },
  });
  ctx.prompt.register({ name: 'file-editor', order: 10, text: guidance });
}

export default { name, inject, apply };
