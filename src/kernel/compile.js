// Dynamic plugin loading: ESM source string -> component definition.
// Primary path: Blob URL import (real ESM). Fallback: new Function, for
// Safari quirks / stricter contexts where blob: import is unavailable.
//
// THE PLUGIN DIALECT (v2) IS PINNED so both paths accept the same source:
//   - exactly one `export default { ... }` (component object); named
//     `export const/function` allowed (ignored at load, useful for tests)
//   - imports: SINGLE-LINE static forms only, at the top of the file, from
//     registry specifiers only (see kernel/modules.js): named
//     `import { a, b as c } from 'x'`, namespace `import * as ns from 'x'`,
//     default `import d from 'x'`. Side-effect imports, multi-line imports,
//     `export { ... }` lists, and cross-plugin specifiers are all rejected.
//   - no top-level await
// Imports are TRANSLATED, not resolved: rewriteImports turns them into
// destructuring reads of globalThis.__harness.modules — a blob-loaded module
// can reach nothing else. Only the leading block of the file (imports,
// comments, blank lines) is scanned, so `import` text inside template
// literals further down is never touched.
import { markRaw } from 'vue';
import { modules } from './modules.js';

function normalizeSpecifier(raw) {
  const kernel = raw.match(/(?:^|\/)kernel\/([\w-]+)\.js$/);
  return kernel ? `kernel/${kernel[1]}` : raw;
}

const FORMS = [
  { re: /^import\s*\{([^}]*)\}\s*from\s*(['"])(.+?)\2\s*;?\s*$/, // named (with optional aliases)
    emit: (m, ref) => `const {${m[1].replace(/\s+as\s+/g, ': ')}} = ${ref};` },
  { re: /^import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])(.+?)\2\s*;?\s*$/, // namespace
    emit: (m, ref) => `const ${m[1]} = ${ref};` },
  { re: /^import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])(.+?)\2\s*;?\s*$/, // default
    emit: (m, ref) => `const ${m[1]} = ${ref}.default ?? ${ref};` },
];

export function rewriteImports(source) {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('//')) continue;
    if (!line.startsWith('import')) break; // end of the leading import block
    const form = FORMS.map(f => ({ f, m: line.match(f.re) })).find(x => x.m);
    if (!form)
      throw new Error(`unsupported import on line ${i + 1}: "${line}" — the plugin dialect allows only single-line named/namespace/default imports`);
    const key = normalizeSpecifier(form.m[3]);
    if (!(key in modules))
      throw new Error(`unknown import "${form.m[3]}" on line ${i + 1} — plugins may import only: ${Object.keys(modules).join(', ')}. Cross-plugin imports are not supported; share through services instead`);
    lines[i] = form.f.emit(form.m, `globalThis.__harness.modules[${JSON.stringify(key)}]`);
  }
  return lines.join('\n');
}

export function translateESM(source) {
  return source
    .replace(/export\s+default\s/, 'module.exports = ')
    .replace(/export\s+(const|let|var|function|async function)/g, '$1');
}

export async function importPluginSource(source) {
  try {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { return await import(/* @vite-ignore */ url); }
    finally { URL.revokeObjectURL(url); }
  } catch (e) {
    if (e instanceof SyntaxError) throw e; // real parse error: same source won't fare better below
    const mod = { exports: {} };
    new Function('module', 'exports', translateESM(source))(mod, mod.exports);
    return { default: mod.exports };
  }
}

export function normalizePluginDef(raw, name) {
  let def = raw?.default ?? raw;
  if (typeof def === 'function') def = { setup: def }; // bare setup function form
  if (!def || (typeof def.setup !== 'function' && !def.render && !def.template))
    throw new Error('a plugin must export default a component object (with setup / template / render)');
  def.name = def.name || name;
  return def;
}

// Compile-probe: module top-level errors throw HERE, which is what lets
// create/HMR roll back before touching the running instance. setup-time
// errors cannot be probed; PluginHost's onErrorCaptured catches those at
// mount and shows the failed card instead. The sourceURL keeps DevTools
// stack frames named (plugins have no esbuild sourcemap).
export async function compilePlugin(name, source) {
  const translated = rewriteImports(source) + `\n//# sourceURL=harness-plugin://${name}`;
  return markRaw(normalizePluginDef(await importPluginSource(translated), name));
}
