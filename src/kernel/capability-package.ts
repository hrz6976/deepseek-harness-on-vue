import type { CapabilityManifest } from '@/shared/capability-protocol';
import type { FsService, PluginEntry } from '@/shared/runtime';
import { validateCapabilityManifest } from './capabilities';

export const CAPABILITY_PACKAGE_ROOT = '.harness/capabilities/';

export function capabilityManifestPath(id: string): string { return `${CAPABILITY_PACKAGE_ROOT}${id}/manifest.json`; }
export function capabilityIndexPath(id: string): string { return `${CAPABILITY_PACKAGE_ROOT}${id}/index.js`; }
export function capabilityVersionPath(id: string, version: string): string { return `${CAPABILITY_PACKAGE_ROOT}${id}/versions/${version}.js`; }

export function readCapabilityManifest(fs: FsService, id: string, builtin: boolean): { manifest: CapabilityManifest; source: 'generated' | 'declared' } | null {
  const source = fs.read(capabilityManifestPath(id));
  if (!source) return null;
  let parsed: CapabilityManifest;
  try {
    parsed = validateCapabilityManifest(JSON.parse(source) as CapabilityManifest, id);
  }
  catch (error) { throw new Error(`invalid stored manifest for capability "${id}": ${error instanceof Error ? error.message : String(error)}`); }
  return { manifest: parsed, source: isCompatibilityManifest(parsed, builtin) ? 'generated' : 'declared' };
}

export async function persistCapabilityPackage(fs: FsService, entry: PluginEntry, source: string): Promise<void> {
  const manifest = validateCapabilityManifest(entry.manifest, entry.name);
  await Promise.all([
    fs.write(capabilityManifestPath(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`),
    fs.write(capabilityIndexPath(manifest.id), source),
    fs.write(capabilityVersionPath(manifest.id, manifest.version), source),
  ]);
}

function isCompatibilityManifest(manifest: CapabilityManifest, builtin: boolean): boolean {
  return manifest.description === (builtin ? 'Shipped Harness capability.' : 'Agent-created Harness capability.');
}
