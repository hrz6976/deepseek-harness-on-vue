import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformWithOxc } from 'vite';
import { rewriteImports } from '@/kernel/compile';
import { legacyCapabilityManifest } from '@/kernel/capabilities';
import {
  assertWorkspaceMutationAllowed, lockedPluginNameFromPath, pluginPolicy,
} from '@/kernel/plugin-policy';
import { systemPluginNameFromPath, systemPluginNames } from '@/kernel/system-plugin-names';

test('reserved system plugin paths cannot be mistaken for editable capabilities', () => {
  assert.equal(systemPluginNameFromPath('.plugins/loop.js'), 'loop');
  assert.equal(systemPluginNameFromPath('.plugins/page.js'), null);
  assert.equal(systemPluginNameFromPath('nested/.plugins/loop.js'), null);
});

test('trusted plugin policy locks protected drafts and packages below the tool layer', () => {
  assert.equal(lockedPluginNameFromPath('.plugins/page.js'), 'page');
  assert.equal(lockedPluginNameFromPath('/.plugins//page.js/'), 'page');
  assert.equal(lockedPluginNameFromPath('.plugins/page.js/child'), 'page');
  assert.equal(lockedPluginNameFromPath('.harness/capabilities/compaction/index.js'), 'compaction');
  assert.equal(lockedPluginNameFromPath('.harness//capabilities/mcp//manifest.json'), 'mcp');
  assert.equal(lockedPluginNameFromPath('.plugins/run-js.js'), null);
  assert.deepEqual(pluginPolicy('loop'), { source: 'kernel', reload: 'idle' });
  assert.deepEqual(pluginPolicy('run-js'), { source: 'editable', reload: 'turn' });

  const capability = {
    kind: 'capability', id: 'writer', fiberId: 'writer:1', scope: 'global',
    providers: ['workspace'], permissions: ['workspace.write'],
  } as const;
  assert.throws(() => assertWorkspaceMutationAllowed(capability, '.plugins/page.js'), /source\/package is locked/);
  assert.throws(() => assertWorkspaceMutationAllowed(capability, '.harness/capabilities/mcp/manifest.json'), /internal state is manager-owned/);
  assert.throws(() => assertWorkspaceMutationAllowed(capability, '.harness/tasks/index.json'), /internal state is manager-owned/);
  assert.throws(() => assertWorkspaceMutationAllowed(capability, '/.plugins/'), /storage root is locked/);
  assert.doesNotThrow(() => assertWorkspaceMutationAllowed(capability, '.plugins/run-js.js'));
  assert.doesNotThrow(() => assertWorkspaceMutationAllowed({ ...capability, kind: 'system' }, '.plugins/page.js'));
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

  const protectedPermissions = new Set([
    'capability.manage', 'workspace.write', 'llm.use', 'page.modify', 'page.interact', 'page.eval',
    'site-skill.manage', 'mcp.connect', 'mcp.use',
    'web.read',
  ]);
  for (const name of compiled) {
    const sensitive = legacyCapabilityManifest(name, true).permissions
      .some(permission => protectedPermissions.has(permission.id));
    if (sensitive) assert.equal(pluginPolicy(name).source, 'protected', `${name} has privileged shipped permissions`);
  }
});
