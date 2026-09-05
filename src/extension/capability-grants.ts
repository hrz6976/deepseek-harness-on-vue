import { BUILTIN_CAPABILITIES, SYSTEM_PLUGINS } from '@/kernel/builtin-plugins';
import type { CapabilityManifest, CapabilityPrincipal } from '@/shared/capability-protocol';
import { permissionIds, type PrincipalGrant } from '@/shared/capability-policy';

/** Host-owned grants are the authority; incoming claims only select an installed identity.
 * Plugins share a JS realm: this is a session trust boundary, not isolation between plugins.
 */
export class CapabilityGrants {
  private readonly installed: Map<string, CapabilityManifest>;
  constructor(initial: Record<string, CapabilityManifest> = {}) { this.installed = new Map(Object.entries(initial)); }

  resolve(claim: CapabilityPrincipal): CapabilityPrincipal {
    let grant: PrincipalGrant | undefined;
    let scope = claim.scope;
    if (claim.kind === 'system') {
      if (claim.id.startsWith('kernel:') && Object.hasOwn(SYSTEM_PLUGINS, claim.id.slice(7))) grant = SYSTEM_PLUGINS[claim.id.slice(7)]?.grant;
      scope = 'global';
    } else {
      const builtin = Object.hasOwn(BUILTIN_CAPABILITIES, claim.id) ? BUILTIN_CAPABILITIES[claim.id] : undefined;
      const manifest = this.installed.get(claim.id);
      if (builtin) { grant = { providers: builtin.providers, permissions: permissionIds(builtin.permissions) }; scope = 'global'; }
      else if (manifest) { grant = { providers: manifest.requires.providers ?? [], permissions: permissionIds(manifest.permissions) }; scope = manifest.scope; }
    }
    if (!grant) throw new Error(`Capability "${claim.id}" has no trusted host grant.`);
    return { ...claim, scope, providers: [...grant.providers], permissions: [...grant.permissions] };
  }

  async authorize(manifest: CapabilityManifest, approve: () => Promise<boolean>, save: (value: CapabilityManifest) => Promise<void>): Promise<void> {
    if (Object.hasOwn(BUILTIN_CAPABILITIES, manifest.id) || Object.hasOwn(SYSTEM_PLUGINS, manifest.id)) throw new Error('Bundled grants cannot be replaced.');
    if (manifest.permissions.some(item => item.id === '*') || manifest.requires.providers?.includes('runtime')) throw new Error('Custom capabilities cannot request system authority.');
    const previous = this.installed.get(manifest.id);
    const added = manifest.permissions.some(item => !previous?.permissions.some(old => old.id === item.id))
      || manifest.requires.providers?.some(provider => !previous?.requires.providers?.includes(provider))
      || (previous && previous.scope !== manifest.scope);
    if (added && !await approve()) throw new Error('Capability permissions were declined.');
    await save(manifest);
    this.installed.set(manifest.id, manifest);
  }
}
