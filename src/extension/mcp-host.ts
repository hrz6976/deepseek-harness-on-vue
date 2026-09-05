import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { CapabilityRequest } from '@/shared/capability-protocol';
import { toJsonValue, type JsonValue } from '@/shared/runtime';
type McpRequest = Extract<CapabilityRequest, { provider: 'mcp' }>;
export class McpHost {
  readonly #clients = new Map<string, Client>();
  async request(request: McpRequest, tabId: number, signal?: AbortSignal): Promise<JsonValue> {
    signal?.throwIfAborted();
    switch (request.action) {
      case 'connect': return this.#connect(request, tabId, signal);
      case 'disconnect': return this.#disconnect(request.input.id, tabId);
      case 'list-tools': return toJsonValue(await this.#require(request.input.id, tabId).listTools(undefined, { signal }));
      case 'call-tool': return toJsonValue(await this.#require(request.input.id, tabId).callTool({ name: request.input.name, ...(request.input.arguments ? { arguments: request.input.arguments } : {}) }, undefined, { signal }));
    }
  }
  async closeTab(tabId: number): Promise<void> {
    const prefix = `${tabId}:`;
    for (const [key, client] of [...this.#clients].filter(([key]) => key.startsWith(prefix))) {
      this.#clients.delete(key);
      try { await client.close(); }
      catch (error) { console.warn(`[harness] failed to close MCP client ${key}`, error); }
    }
  }
  async #connect(request: Extract<McpRequest, { action: 'connect' }>, tabId: number, signal?: AbortSignal): Promise<JsonValue> {
    await this.#disconnect(request.input.id, tabId);
    const url = new URL(request.input.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The browser MCP transport accepts only HTTP(S) endpoints.');
    const client = new Client({ name: 'harness-page-agent', version: '0.1.0' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
    const transport = new StreamableHTTPClientTransport(url, request.input.headers ? { requestInit: { headers: request.input.headers } } : undefined);
    try {
      await client.connect(transport, { signal });
      const tools = (await client.listTools(undefined, { signal })).tools;
      signal?.throwIfAborted();
      this.#clients.set(this.#key(tabId, request.input.id), client);
      return toJsonValue({ connected: true, tools });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
  async #disconnect(id: string, tabId: number): Promise<JsonValue> {
    const key = this.#key(tabId, id);
    const client = this.#clients.get(key);
    if (!client) return null;
    this.#clients.delete(key); await client.close(); return null;
  }
  #require(id: string, tabId: number): Client {
    const client = this.#clients.get(this.#key(tabId, id));
    if (!client) throw new Error(`MCP connection "${id}" is not open.`);
    return client;
  }
  #key(tabId: number, id: string): string { return `${tabId}:${id}`; }
}
