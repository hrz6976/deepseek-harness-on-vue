// file_editor tool plugin. The template IS the manifest: mounting this
// component registers the tool and its prompt guidance; unmounting reclaims
// both. Prose lives in props/data, never slot text.
import { getService } from '../../kernel/services';

export const fileEditorPlugin = {
  name: 'file-editor',
  template: `
    <AgentTool name="file_editor" :description="description" :parameters="parameters" :run="run" />
    <PromptSection name="file-editor" :order="10" :text="guidance" />
  `,
  setup() {
    const description = 'Operate the virtual filesystem: list all files; view a file; write (create or fully overwrite) a file; str_replace replaces old_str with new_str inside a file';
    const parameters = {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['list', 'view', 'write', 'str_replace'] },
        path: { type: 'string', description: 'file path, e.g. index.html' },
        content: { type: 'string', description: 'full content for write' },
        old_str: { type: 'string' }, new_str: { type: 'string' },
      },
      required: ['command'],
    };
    const guidance = [
      'Manage files with file_editor: list to see what exists, write to create, view to check contents, str_replace for local edits.',
      'View a file before modifying it.',
      'If the user asks for a web page/game/tool, put ALL code in a single index.html (inline <style> and <script>) so it can be previewed directly.',
      'Files under .plugins/ are the running plugins — core and agent-created alike. Editing one hot-reloads it (a broken edit is rejected and the old version keeps running). New tool schemas/code are visible on the NEXT turn of the current run; only loop itself waits for the run to end.',
    ].join('\n');

    async function run({ command, path = '', content = '', old_str = '', new_str = '' }: {
      command: 'list' | 'view' | 'write' | 'str_replace';
      path?: string;
      content?: string;
      old_str?: string;
      new_str?: string;
    }) {
      const fs = getService('fs');
      if (!fs) return 'Error: fs service not ready';
      if (command === 'list') return fs.list().join('\n') || '(empty)';
      if (command === 'view') { const c = fs.read(path); return c === null ? `Error: ${path} does not exist` : c; }
      if (command === 'write') { await fs.write(path, content); return `wrote ${path} (${(content ?? '').length} chars)`; }
      if (command === 'str_replace') {
        const c = fs.read(path);
        if (c === null) return `Error: ${path} does not exist`;
        if (!c.includes(old_str)) return `Error: old_str not found in ${path}`;
        await fs.write(path, c.replace(old_str, new_str ?? ''));
        return `edited ${path}`;
      }
      return `Error: unknown command ${command}`;
    }
    return { description, parameters, guidance, run };
  },
};

export default fileEditorPlugin;
