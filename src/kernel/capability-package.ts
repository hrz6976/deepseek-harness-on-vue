import type { CapabilityManifest } from '@/shared/capability-protocol';
import type { FsService, PluginEntry } from '@/shared/runtime';
import { validateCapabilityManifest } from './capabilities';

export const CAPABILITY_PACKAGE_ROOT = '.harness/capabilities/';
export const PLUGIN_DIR = '.plugins/';
export const capabilityPackagePath = (id: string) => `${CAPABILITY_PACKAGE_ROOT}${id}/package.json`;
export interface CapabilityPackage { manifest: CapabilityManifest; source: string; shippedSource?: string }

/** A single package revision keeps active source and install metadata consistent. */
export function readCapabilityPackage(fs: FsService, id: string): CapabilityPackage | null {
  const record = fs.read(capabilityPackagePath(id));
  if (record) {
    const value = JSON.parse(record) as CapabilityPackage;
    if (typeof value.source !== 'string') throw new Error(`Invalid source for capability "${id}"`);
    return { ...value, manifest: validateCapabilityManifest(value.manifest, id) };
  }
  const root = `${CAPABILITY_PACKAGE_ROOT}${id}/`;
  const legacy = fs.read(`${root}manifest.json`);
  if (!legacy) return null;
  const manifest = validateCapabilityManifest(JSON.parse(legacy), id);
  const source = fs.read(`${root}index.js`) ?? '';
  return { manifest, source, ...(manifest.description === 'Shipped Harness capability.' && manifest.version === '0.1.0' ? { shippedSource: source } : {}) };
}
export async function persistCapabilityPackage(fs: FsService, entry: PluginEntry, source: string, shippedSource?: string): Promise<void> {
  const manifest = validateCapabilityManifest(entry.manifest, entry.manifest.id);
  await fs.write(capabilityPackagePath(manifest.id), JSON.stringify({ manifest, source, ...(shippedSource === undefined ? {} : { shippedSource }) }));
}

export function installedCapabilityIds(fs: FsService): string[] {
  return [...new Set(fs.list().flatMap(path => {
    const match = /^\.plugins\/([^/]+)\.js$|^\.harness\/capabilities\/([^/]+)\/package\.json$/u.exec(path);
    return match ? [match[1] ?? match[2]!] : [];
  }))];
}
