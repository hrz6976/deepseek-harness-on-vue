// Dynamic plugin loading: ESM source string -> Cordis Plugin.
// Primary path: Blob URL import (real ESM). Fallback: new Function, for
// Safari quirks / stricter contexts where blob: import is unavailable.
//
// THE PLUGIN SOURCE DIALECT is deliberately small so both paths accept the
// same source:
//   - Cordis default function/class/{ apply } exports, or named
//     `name` / `inject` / `Config` / `apply` exports
//   - imports: SINGLE-LINE static forms only, at the top of the file, from
//     public registry specifiers only (see kernel/modules.js): named
//     `import { a, b as c } from 'x'`, namespace `import * as ns from 'x'`,
//     default `import d from 'x'`. Side-effect imports, multi-line imports,
//     `export { ... }` lists, and cross-plugin specifiers are all rejected.
//   - no top-level await
// Imports are TRANSLATED, not resolved: rewriteImports turns them into
// destructuring reads of globalThis.__harness.modules — a blob-loaded module
// can reach nothing else. Only the leading block of the file (imports,
// comments, blank lines) is scanned, so `import` text inside template
// literals further down is never touched.
import type { Plugin } from '@deepseek-ai/cordis';
import { modules, preparePluginModules } from './modules';
import { normalizePlugin } from './plugin-runtime';

function normalizeSpecifier(raw: string): string {
  if (raw === '@/sdk' || raw === '@/sdk/index' || raw === '@/sdk/index.js') return '@harness/sdk';
  return raw;
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
  const names = [...source.matchAll(/export\s+(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/g)]
    .map(match => match[1]!);
  const translated = source
    .replace(/export\s+default\s/, 'module.exports.default = ')
    .replace(/export\s+(const|let|var|function|async\s+function|class)/g, '$1');
  return `${translated}\nObject.assign(module.exports, { ${names.join(', ')} });`;
}

async function importPluginSource(source: string): Promise<Record<string, unknown>> {
  try {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { return await import(/* @vite-ignore */ url); }
    finally { URL.revokeObjectURL(url); }
  } catch (e) {
    if (e instanceof SyntaxError) throw e; // real parse error: same source won't fare better below
    const mod = { exports: {} };
    new Function('module', 'exports', translateESM(source))(mod, mod.exports);
    return mod.exports as Record<string, unknown>;
  }
}

// Compile-probe: module top-level errors throw HERE, which is what lets
// create/HMR roll back before touching the running instance. apply-time
// errors become Fiber failures at mount. The sourceURL keeps DevTools
// stack frames named (plugins have no esbuild sourcemap).
export async function compilePlugin(name: string, source: string): Promise<Plugin> {
  await preparePluginModules(source);
  const translated = rewriteImports(source) + `\n//# sourceURL=harness-plugin://${name}`;
  return normalizePlugin(await importPluginSource(translated), name);
}
