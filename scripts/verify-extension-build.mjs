import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputRoot = resolve('dist/extension');
const manifest = JSON.parse(await readFile(resolve(outputRoot, 'manifest.json'), 'utf8'));
const sandboxPage = manifest.sandbox?.pages?.[0];
const fallbackPage = manifest.side_panel?.default_path;

assert.equal(typeof sandboxPage, 'string', 'manifest must declare a sandbox page');
assert.equal(fallbackPage, 'src/extension/sidepanel-fallback.html', 'manifest must default to the inert side-panel fallback');
await access(resolve(outputRoot, 'src/extension/sidepanel.html'));
const fallbackHtml = await readFile(resolve(outputRoot, fallbackPage), 'utf8');
assert.doesNotMatch(fallbackHtml, /harness-sandbox/iu, 'fallback page must not boot or retain an agent runtime');
assert.match(fallbackHtml, /<script\b[^>]*type="module"/iu, 'fallback page must include its lightweight tab router');
const sandboxHtml = await readFile(resolve(outputRoot, sandboxPage), 'utf8');
assert.match(sandboxHtml, /<script\s+src="\/sandbox-loader\.js"><\/script>/u,
  'sandbox page must install its startup-error relay before the app entry');
const moduleEntry = sandboxHtml.match(/<script\s+type="module"[^>]+src="([^"]+)"/u)?.[1];
assert.equal(typeof moduleEntry, 'string', 'sandbox page must load a bundled ESM entrypoint');
await access(resolve(outputRoot, 'sandbox-loader.js'));
const sandboxRuntime = await readFile(resolve(outputRoot, moduleEntry.replace(/^\//u, '')), 'utf8');
assert.doesNotMatch(sandboxRuntime, /process\.env\.NODE_ENV/u,
  'sandbox ESM must fold Vue environment guards instead of requiring Node process');

console.log('extension build verified: sandbox runtime is ESM with startup error reporting');
