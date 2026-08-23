import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformWithOxc } from 'vite';
import { rewriteImports } from '@/kernel/compile';
import { systemPluginNameFromPath, systemPluginNames } from '@/kernel/system-plugin-names';

test('reserved system plugin paths cannot be mistaken for editable capabilities', () => {
  assert.equal(systemPluginNameFromPath('.plugins/loop.js'), 'loop');
  assert.equal(systemPluginNameFromPath('.plugins/page.js'), null);
  assert.equal(systemPluginNameFromPath('nested/.plugins/loop.js'), null);
});

test('every shipped TypeScript plugin survives the build transform and import registry', async () => {
  const roots = ['src/plugins', 'src/plugins/tools', 'src/plugins/ui'];
  const files = (await Promise.all(roots.map(async root => {
    const directory = resolve(root);
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !systemPluginNames.has(basename(entry.name, '.ts')))
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

  assert.equal(compiled.includes('tools'), false);
  assert.equal(compiled.includes('loop'), false);
  assert.ok(compiled.includes('page'));
});
