// run_js tool plugin: executes JavaScript in a throwaway Web Worker,
// returning console output. 5s timeout.
export const runJsPlugin = {
  name: 'run-js',
  template: `
    <AgentTool name="run_js" :description="description" :parameters="parameters" :run="run" />
    <PromptSection name="run-js" :order="20" text="Use run_js to execute JavaScript when you need to verify logic, compute something, or debug." />
  `,
  setup() {
    const description = 'Execute JavaScript in a browser Web Worker and return console output. For verifying logic, calculations, debugging. 5 second timeout.';
    const parameters = { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] };

    function run({ code }) {
      return new Promise(resolve => {
        const src = 'onmessage = async e => {'
          + 'const out = [];'
          + 'const fmt = x => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return String(x); } };'
          + 'const con = { log: (...a) => out.push(a.map(fmt).join(" ")), error: (...a) => out.push(a.map(fmt).join(" ")), warn: (...a) => out.push(a.map(fmt).join(" ")) };'
          + 'try { const r = new Function("console", e.data)(con); if (r && r.then) await r; }'
          + 'catch (err) { out.push("Uncaught " + err.message); }'
          + 'postMessage(out.join("\\n") || "(no output)");'
          + '}';
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const w = new Worker(url);
        const done = msg => { clearTimeout(timer); w.terminate(); URL.revokeObjectURL(url); resolve(msg); };
        const timer = setTimeout(() => done('Error: execution timed out (5s)'), 5000);
        w.onmessage = e => done(e.data);
        w.onerror = e => done('Error: ' + e.message);
        w.postMessage(String(code ?? ''));
      });
    }
    return { description, parameters, run };
  },
};

export default runJsPlugin;
