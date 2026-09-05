// Standalone workspace provider. Extension builds use broker-fs, but both
// implementations preserve the calling Cordis Context and enforce the same
// manifest-backed workspace policy.
import type { Context, Plugin } from '@deepseek-ai/cordis';
import { OpfsStore } from '@/kernel/opfs-store';
import { assertWorkspaceMutationAllowed } from '@/kernel/plugin-policy';
import { WorkspaceRuntime } from '@/kernel/workspace-runtime';
import { errorMessage, log } from '@/sdk';

class OpfsRuntime extends WorkspaceRuntime {
  readonly ready: Promise<void>;
  private store: OpfsStore | null = null;

  constructor(ctx: Context) {
    super(ctx);
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    if (!navigator.storage?.getDirectory) {
      log('OPFS unsupported in this browser, falling back to in-memory fs', 'warn');
      return;
    }
    try {
      const store = new OpfsStore({ channel: null });
      const files = await store.list();
      for (const [path, content] of Object.entries(files)) this.setFile(path, { content });
      this.store = store;
      if (this.files.size) log(`restored ${this.files.size} file(s) from OPFS (previous session)`, 'ok');
    } catch (error) {
      log('OPFS init failed: ' + errorMessage(error), 'err');
    }
  }

  async write(path: string, content: string): Promise<void> {
    const principal = this.authorize('write');
    assertWorkspaceMutationAllowed(principal, path);
    const value = String(content ?? '');
    await this.store?.write(path, value);
    this.setFile(path, { content: value });
  }

  async remove(path: string): Promise<void> {
    const principal = this.authorize('write');
    assertWorkspaceMutationAllowed(principal, path);
    await this.store?.remove(path);
    this.removeFile(path);
  }

}

export default {
  name: 'workspace',
  apply(ctx: Context) {
    new OpfsRuntime(ctx);
    ctx.effect(() => () => log('fs plugin unmounted', 'warn'), 'fs.log-dispose');
  },
} satisfies Plugin.Object;
