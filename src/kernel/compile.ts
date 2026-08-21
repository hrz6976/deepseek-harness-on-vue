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
import type { Component } from 'vue';
import { modules } from './modules';

function normalizeSpecifier(raw: string): string {
  const kernel = raw.match(/(?:^|\/)kernel\/([\w-]+)(?:\.js)?$/);
  if (kernel) return `kernel/${kernel[1]}`;
  const shared = raw.match(/(?:^|\/)shared\/([\w-]+)(?:\.js)?$/);
  return shared ? `shared/${shared[1]}` : raw;
}

interface ImportForm { re: RegExp; emit(match: RegExpMatchArray, ref: string): string }
const FORMS: ImportForm[] = [
  { re: /^import\s*\{([^}]*)\}\s*from\s*(['"])(.+?)\2\s*;?\s*$/, // named (with optional aliases)
    emit: (m, ref) => `const {${m[1]!.replace(/\s+as\s+/g, ': ')}} = ${ref};` },
  { re: /^import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])(.+?)\2\s*;?\s*$/, // namespace
    emit: (m, ref) => `const ${m[1]} = ${ref};` },
  { re: /^import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])(.+?)\2\s*;?\s*$/, // default
    emit: (m, ref) => `const ${m[1]} = ${ref}.default ?? ${ref};` },
];

export function rewriteImports(source: string): string {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('//')) continue;
    if (!line.startsWith('import')) break; // end of the leading import block
    const form = FORMS.map(f => ({ f, match: line.match(f.re) })).find(
      (candidate): candidate is { f: ImportForm; match: RegExpMatchArray } => candidate.match !== null,
    );
    if (!form)
      throw new Error(`unsupported import on line ${i + 1}: "${line}" — the plugin dialect allows only single-line named/namespace/default imports`);
    const specifier = form.match[3]!;
    const key = normalizeSpecifier(specifier);
    if (!(key in modules))
      throw new Error(`unknown import "${specifier}" on line ${i + 1} — plugins may import only: ${Object.keys(modules).join(', ')}. Cross-plugin imports are not supported; share through services instead`);
    lines[i] = form.f.emit(form.match, `globalThis.__harness.modules[${JSON.stringify(key)}]`);
  }
  return lines.join('\n');
}

export function translateESM(source: string): string {
  return source
    .replace(/export\s+default\s/, 'module.exports = ')
    .replace(/export\s+(const|let|var|function|async function)/g, '$1');
}

export async function importPluginSource(source: string): Promise<{ default?: unknown }> {
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

export function normalizePluginDef(raw: unknown, name: string): Component {
  const moduleValue = raw as { default?: unknown } | null;
  let candidate: unknown = moduleValue?.default ?? raw;
  if (typeof candidate === 'function') candidate = { setup: candidate }; // bare setup function form
  if (!candidate || typeof candidate !== 'object')
    throw new Error('a plugin must export default a component object (with setup / template / render)');
  const def = candidate as Component & { name?: string; setup?: unknown; render?: unknown; template?: unknown };
  if (typeof def.setup !== 'function' && !def.render && !def.template)
    throw new Error('a plugin must export default a component object (with setup / template / render)');
  def.name = def.name || name;
  return def;
}

// Compile-probe: module top-level errors throw HERE, which is what lets
// create/HMR roll back before touching the running instance. setup-time
// errors cannot be probed; PluginHost's onErrorCaptured catches those at
// mount and shows the failed card instead. The sourceURL keeps DevTools
// stack frames named (plugins have no esbuild sourcemap).
export async function compilePlugin(name: string, source: string): Promise<Component> {
  const translated = rewriteImports(source) + `\n//# sourceURL=harness-plugin://${name}`;
  return markRaw(normalizePluginDef(await importPluginSource(translated), name));
}
