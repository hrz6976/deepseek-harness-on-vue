import { assertPrincipalAuthorized } from '@/shared/capability-policy';
import type { CapabilityPrincipal, CapabilityProvider, CapabilityRequest } from '@/shared/capability-protocol';
import type { JsonValue } from '@/shared/runtime';

interface CapabilityHostContext {
  tabId: number;
  principal: CapabilityPrincipal;
}

type ProviderRequest<P extends CapabilityProvider> = Extract<CapabilityRequest, { provider: P }>;

interface TrustedCapabilityProvider<P extends CapabilityProvider> {
  request?(request: ProviderRequest<P>, context: CapabilityHostContext): JsonValue | Promise<JsonValue>;
  stream?(request: ProviderRequest<P>, context: CapabilityHostContext): AsyncIterable<JsonValue>;
}

/**
 * Trusted dispatch table for sandbox capability requests. Registering a
 * provider grants no authority to sandbox plugins: every request has already
 * crossed the shared schema boundary, and only extension-owned handlers can
 * be installed here.
 */
export class TrustedCapabilityHost {
  readonly #providers = new Map<CapabilityProvider, TrustedCapabilityProvider<CapabilityProvider>>();

  register<P extends CapabilityProvider>(provider: P, handler: TrustedCapabilityProvider<P>): void {
    if (this.#providers.has(provider)) throw new Error(`Capability provider "${provider}" is already registered.`);
    this.#providers.set(provider, handler as unknown as TrustedCapabilityProvider<CapabilityProvider>);
  }

  has(provider: CapabilityProvider): boolean {
    return this.#providers.has(provider);
  }

  async request(request: CapabilityRequest, context: CapabilityHostContext): Promise<JsonValue> {
    assertPrincipalAuthorized(context.principal, request);
    const provider = this.#providers.get(request.provider);
    if (!provider?.request) throw new Error(`Capability provider "${request.provider}" does not support request action "${request.action}".`);
    return await provider.request(request, context);
  }

  stream(request: CapabilityRequest, context: CapabilityHostContext): AsyncIterable<JsonValue> {
    assertPrincipalAuthorized(context.principal, request);
    const provider = this.#providers.get(request.provider);
    if (!provider?.stream) throw new Error(`Capability provider "${request.provider}" does not support streaming action "${request.action}".`);
    return provider.stream(request, context);
  }
}
