import { createBrokerPlugin, systemPrincipal } from '@/kernel/broker';
import { createCapabilityEnvelope } from '@/shared/broker-schema';
import type { CapabilityPrincipal, CapabilityRequest, CapabilityResponse, CapabilityStreamChunk } from '@/shared/capability-protocol';
import type { JsonValue } from '@/shared/runtime';

export function createSandboxBroker(target: Window) {
  let token = '';
  let sequence = 0;
  let resolveSession!: (host: string) => void;
  const session = new Promise<string>(resolve => { resolveSession = resolve; });
  const pending = new Map<string, (chunk: CapabilityStreamChunk) => void>();

  async function* exchange(principal: CapabilityPrincipal, payload: CapabilityRequest, signal?: AbortSignal): AsyncIterable<JsonValue> {
    if (signal?.aborted) return;
    const requestId = `sandbox_${++sequence}`;
    const streaming = payload.provider === 'llm' && payload.action === 'complete';
    const envelope = createCapabilityEnvelope(token, requestId, principal, payload);
    envelope.deadline = Date.now() + (streaming ? 300_000 : 30_000);
    const chunks: CapabilityStreamChunk[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const receive = (chunk: CapabilityStreamChunk) => { chunks.push(chunk); wake?.(); };
    const cancel = () => {
      target.postMessage({ channel: 'harness-broker-v1', session: token, requestId, cancel: true }, '*');
      wake?.();
    };
    const timer = window.setTimeout(() => {
      receive({ channel: 'harness-broker-v1', requestId, stream: true, done: true, error: 'Broker request timed out.' });
      cancel();
    }, envelope.deadline - Date.now());
    pending.set(requestId, receive);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      target.postMessage(envelope, '*');
      while (!signal?.aborted) {
        while (chunks.length) {
          const chunk = chunks.shift()!;
          if (chunk.error) throw new Error(chunk.error);
          if (chunk.done) finished = true;
          if (chunk.value !== undefined) yield chunk.value;
          if (finished) return;
        }
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally {
      if (!finished && !signal?.aborted) cancel();
      signal?.removeEventListener('abort', cancel);
      window.clearTimeout(timer);
      pending.delete(requestId);
    }
  }
  async function request(principal: CapabilityPrincipal, payload: CapabilityRequest, signal?: AbortSignal): Promise<JsonValue> {
    for await (const value of exchange(principal, payload, signal)) return value;
    signal?.throwIfAborted();
    return null;
  }
  function handleMessage(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const message = data as { channel?: unknown; type?: unknown; token?: unknown; host?: unknown };
    if (message.channel === 'harness-shell-v1' && message.type === 'broker-session') {
      if (!token && typeof message.token === 'string' && message.token.length >= 32) {
        token = message.token;
        window.clearInterval(helloTimer);
        resolveSession(typeof message.host === 'string' ? message.host : '');
      }
      return true;
    }
    const response = data as Partial<CapabilityResponse & CapabilityStreamChunk>;
    if (response.channel !== 'harness-broker-v1' || typeof response.requestId !== 'string') return false;
    pending.get(response.requestId)?.(response.stream ? response as CapabilityStreamChunk : {
      channel: 'harness-broker-v1', requestId: response.requestId, stream: true, done: true,
      ...(response.ok ? { value: response.value ?? null } : { error: response.error ?? 'Broker request failed.' }),
    });
    return true;
  }
  const shell = systemPrincipal();
  const hello = () => target.postMessage({ channel: 'harness-shell-v1', type: 'broker-session-hello' }, '*');
  const helloTimer = window.setInterval(hello, 250);
  hello();
  return {
    session, handleMessage,
    request: (payload: CapabilityRequest, signal?: AbortSignal) => request(shell, payload, signal),
    stream: (payload: CapabilityRequest, signal?: AbortSignal) => exchange(shell, payload, signal),
    plugin: createBrokerPlugin({ request, stream: exchange }),
  };
}
