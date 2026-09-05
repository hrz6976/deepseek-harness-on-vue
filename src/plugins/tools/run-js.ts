import type { Context, Plugin } from '@deepseek-ai/cordis';
import { z } from 'zod';

function run({ code }: { code: string }, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.resolve('Error: execution cancelled');
  return new Promise(resolve => {
    const source = 'onmessage = async e => {'
      + 'const out = [];'
      + 'const fmt = x => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return String(x); } };'
      + 'const con = { log: (...a) => out.push(a.map(fmt).join(" ")), error: (...a) => out.push(a.map(fmt).join(" ")), warn: (...a) => out.push(a.map(fmt).join(" ")) };'
      + 'try { const r = new Function("console", e.data)(con); if (r && r.then) await r; }'
      + 'catch (err) { out.push("Uncaught " + err.message); }'
      + 'postMessage(out.join("\\n") || "(no output)");'
      + '}';
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const cancel = () => done('Error: execution cancelled');
    const done = (message: string) => { signal?.removeEventListener('abort', cancel); clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve(message); };
    const timer = setTimeout(() => done('Error: execution timed out (5s)'), 5000);
    worker.onmessage = event => done(String(event.data));
    worker.onerror = event => done(`Error: ${event.message}`);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.postMessage(String(code ?? ''));
  });
}

export default {
  name: 'run-js',
  inject: ['tools', 'prompt'],
  apply(ctx: Context): void {
    ctx.tools.register({
      name: 'run_js',
      description: 'Execute JavaScript in a browser Web Worker and return console output. For verifying logic, calculations, and debugging. Five second timeout.',
      parameters: z.object({ code: z.string() }),
      run: args => run(args, ctx.get('task')?.signal),
    });
    ctx.prompt.register({ name: 'run-js', order: 20, text: 'Use run_js to execute JavaScript when you need to verify logic, compute something, or debug.' });
  },
} satisfies Plugin.Object;
