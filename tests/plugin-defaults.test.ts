import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformWithOxc } from 'vite';
import { compilePlugin, rewriteImports } from '../src/kernel/compile';
import { modules } from '../src/kernel/modules';

const runtimeGlobal = globalThis as typeof globalThis & { __harness?: { modules: typeof modules } };
runtimeGlobal.__harness = { modules };

test('every shipped TypeScript plugin survives the build transform and import registry', async () => {
  const roots = ['src/plugins', 'src/plugins/tools', 'src/plugins/ui'];
  const files = (await Promise.all(roots.map(async root => {
    const directory = resolve(root);
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && entry.name !== 'fs.ts')
      .map(entry => resolve(directory, entry.name));
  }))).flat();

  const compiled: string[] = [];
  for (const file of files) {
    const result = await transformWithOxc(await readFile(file, 'utf8'), file, {
      lang: 'ts',
      sourceType: 'module',
      target: 'es2022',
      sourcemap: false,
    });
    const name = basename(file, '.ts');
    try {
      rewriteImports(result.code);
    } catch (error) {
      throw new Error(`${file} failed shipped-plugin import rewriting: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    compiled.push(name);
  }

  assert.ok(compiled.includes('tools'));
  assert.ok(compiled.includes('loop'));
});

test('the shipped llm plugin survives its runtime compilation path', async () => {
  const file = resolve('src/plugins/llm.ts');
  const result = await transformWithOxc(await readFile(file, 'utf8'), file, {
    lang: 'ts',
    sourceType: 'module',
    target: 'es2022',
    sourcemap: false,
  });
  const def = await compilePlugin('llm', result.code);
  assert.equal(def.name, 'llm');
});
