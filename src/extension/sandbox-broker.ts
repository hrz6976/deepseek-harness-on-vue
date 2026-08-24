import { createBrokerPlugin, systemPrincipal, type BrokerTransport } from '@/kernel/broker';
import { createCapabilityEnvelope } from '@/shared/broker-schema';
import type { CapabilityPrincipal, CapabilityRequest, CapabilityResponse, CapabilityStreamChunk } from '@/shared/capability-protocol';
import type { JsonValue } from '@/shared/runtime';

interface PendingRequest {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: number;
}

interface PendingStream {
  queue: CapabilityStreamChunk[];
  wake: (() => void) | null;
  acknowledgementTimer: number;
}

export function createSandboxBroker(target: Window) {
  let sequence = 0;
  let token = '';
  let resolveSession!: (host: string) => void;
  const session = new Promise<string>(resolve => { resolveSession = resolve; });
  const pending = new Map<string, PendingRequest>();
  const streams = new Map<string, PendingStream>();

  function request(principal: CapabilityPrincipal, payload: CapabilityRequest): Promise<JsonValue> {
    const requestId = `sandbox_${Date.now()}_${++sequence}`;
    let envelope;
    try { envelope = createCapabilityEnvelope(token, requestId, principal, payload); }
    catch (error) { return Promise.reject(new Error(`Invalid broker request: ${error instanceof Error ? error.message : String(error)}`)); }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Broker request timed out.'));
      }, 30_000);
      pending.set(requestId, { resolve, reject, timer });
      target.postMessage(envelope, '*');
    });
  }

  async function* stream(principal: CapabilityPrincipal, payload: CapabilityRequest, signal?: AbortSignal): AsyncIterable<JsonValue> {
    if (signal?.aborted) return;
    const requestId = `sandbox_stream_${Date.now()}_${++sequence}`;
    const state: PendingStream = { queue: [], wake: null, acknowledgementTimer: 0 };
    let finished = false;
    const cancel = () => {
      if (finished) return;
      finished = true;
      try {
        target.postMessage(createCapabilityEnvelope(token, `${requestId}_cancel`, principal, {
          provider: 'llm', action: 'cancel', input: { requestId },
        }), '*');
      }
      catch { /* the trusted shell may already be gone */ }
      state.wake?.();
    };
    streams.set(requestId, state);
    state.acknowledgementTimer = window.setTimeout(() => {
      state.queue.push({
        channel: 'harness-broker-v1', requestId, stream: true, done: true,
        error: 'The extension service worker did not acknowledge the LLM request.',
      });
      state.wake?.();
    }, 10_000);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      target.postMessage(createCapabilityEnvelope(token, requestId, principal, payload), '*');
      while (true) {
        if (signal?.aborted) return;
        while (state.queue.length) {
          const chunk = state.queue.shift()!;
          if (chunk.error) throw new Error(chunk.error);
          if (chunk.value !== undefined) yield chunk.value;
          if (chunk.done) {
            finished = true;
            return;
          }
        }
        if (signal?.aborted) return;
        await new Promise<void>(resolve => { state.wake = resolve; });
        state.wake = null;
      }
    } finally {
      cancel();
      signal?.removeEventListener('abort', cancel);
      window.clearTimeout(state.acknowledgementTimer);
      streams.delete(requestId);
    }
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
    if (response.stream === true) {
      const state = streams.get(response.requestId);
      if (state) {
        window.clearTimeout(state.acknowledgementTimer);
        state.acknowledgementTimer = 0;
        state.queue.push(response as CapabilityStreamChunk);
        state.wake?.();
      }
      return true;
    }
    const waiter = pending.get(response.requestId);
    if (!waiter) return true;
    pending.delete(response.requestId);
    window.clearTimeout(waiter.timer);
    if (response.ok) waiter.resolve(response.value ?? null);
    else waiter.reject(new Error(response.error ?? 'Broker request failed.'));
    return true;
  }

  const transport: BrokerTransport = { request, stream };
  const shell = systemPrincipal();
  const hello = () => target.postMessage({ channel: 'harness-shell-v1', type: 'broker-session-hello' }, '*');
  const helloTimer = window.setInterval(hello, 250);
  hello();
  return {
    session,
    request: (payload: CapabilityRequest) => request(shell, payload),
    stream: (payload: CapabilityRequest, signal?: AbortSignal) => stream(shell, payload, signal),
    handleMessage,
    plugin: createBrokerPlugin(transport),
  };
}
