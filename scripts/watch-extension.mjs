import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const inputs = [
  'src',
  'public',
  'vite.config.ts',
  'tsconfig.json',
].map(path => resolve(projectRoot, path));

let child;
let debounceTimer;
let rebuildQueued = false;
let scanning = false;
let stopping = false;

function build() {
  if (stopping) return;
  if (child) {
    rebuildQueued = true;
    return;
  }

  console.log('[harness] building extension...');
  child = spawn('npm', ['run', 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  child.once('exit', code => {
    child = undefined;
    if (stopping) return;
    console.log(code === 0
      ? '[harness] build complete; reload the unpacked extension in Chrome.'
      : `[harness] build failed with exit code ${code}.`);
    if (rebuildQueued) {
      rebuildQueued = false;
      build();
    }
  });
}

async function snapshot(path, files = new Map()) {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) {
    files.set(path, `${metadata.mtimeMs}:${metadata.size}`);
    return files;
  }
  const entries = await readdir(path, { withFileTypes: true });
  await Promise.all(entries.map(entry => snapshot(resolve(path, entry.name), files)));
  return files;
}

let previousSnapshot = await snapshotInputs();

async function snapshotInputs() {
  const files = new Map();
  for (const path of inputs) await snapshot(path, files);
  return files;
}

function changed(before, after) {
  if (before.size !== after.size) return true;
  for (const [path, signature] of after) {
    if (before.get(path) !== signature) return true;
  }
  return false;
}

const pollTimer = setInterval(async () => {
  if (stopping || scanning) return;
  scanning = true;
  try {
    const nextSnapshot = await snapshotInputs();
    if (changed(previousSnapshot, nextSnapshot)) {
      previousSnapshot = nextSnapshot;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(build, 100);
    }
  } catch (error) {
    console.warn('[harness] could not scan extension sources', error);
  } finally {
    scanning = false;
  }
}, 500);

function stop(signal) {
  stopping = true;
  clearTimeout(debounceTimer);
  clearInterval(pollTimer);
  child?.kill(signal);
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

console.log('[harness] watching extension sources...');
build();
