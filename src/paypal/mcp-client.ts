// Minimal MCP client for PayPal's official remote MCP server
// (https://mcp.sandbox.paypal.com/sse, https://mcp.paypal.com/sse).
// Transport: HTTP + SSE. We open the event stream, PayPal announces a
// message endpoint, and JSON-RPC responses arrive back on the stream.
// No dependencies: fetch + a small SSE parser.
import { config } from '../config.ts';
import { accessToken } from './rest.ts';

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export const paypalMcpUrl = () =>
  process.env.PAYPAL_MCP_URL || (config.paypal.mode === 'live' ? 'https://mcp.paypal.com/sse' : 'https://mcp.sandbox.paypal.com/sse');

export class McpSseClient {
  private url: string;
  private token: () => Promise<string>;
  private endpoint: string | null = null;
  private abort = new AbortController();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(url: string, token: () => Promise<string>) {
    this.url = url;
    this.token = token;
  }

  /** Open the stream, wait for the endpoint, and run the MCP handshake. */
  async connect(timeoutMs = 10_000) {
    const res = await fetch(this.url, {
      headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'text/event-stream' },
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`MCP stream failed (${res.status})`);
    let ready!: () => void;
    let failed!: (e: Error) => void;
    const gotEndpoint = new Promise<void>((ok, no) => ((ready = ok), (failed = no)));
    const timer = setTimeout(() => failed(new Error('MCP endpoint event timed out')), timeoutMs);
    void this.pump(res.body, ready).catch((err) => {
      failed(err as Error);
      this.failAll(err as Error);
    });
    try {
      await gotEndpoint;
    } finally {
      clearTimeout(timer);
    }
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'quorum', version: '0.2.0' },
    });
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  private async pump(body: ReadableStream<Uint8Array>, onEndpoint: () => void) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        const payload = data.join('\n');
        if (event === 'endpoint') {
          this.endpoint = new URL(payload, this.url).toString();
          onEndpoint();
        } else if (payload) {
          this.dispatch(payload);
        }
      }
    }
    this.failAll(new Error('MCP stream closed'));
  }

  private dispatch(payload: string) {
    let msg: any;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    const p = typeof msg?.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
    else p.resolve(msg.result);
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private async send(message: unknown) {
    if (!this.endpoint) throw new Error('MCP client is not connected');
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`MCP POST failed (${res.status})`);
    await res.arrayBuffer().catch(() => undefined);
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 20_000): Promise<T> {
    const id = this.nextId++;
    const out = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ jsonrpc: '2.0', id, method, params }).catch((err) => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err as Error);
    });
    return out;
  }

  async listTools(): Promise<McpTool[]> {
    const r = await this.request<{ tools?: McpTool[] }>('tools/list', {});
    return r.tools ?? [];
  }

  /** Call a tool and return its text content (parsed as JSON when possible). */
  async callTool(name: string, args: unknown): Promise<unknown> {
    const r = await this.request<{ content?: { type: string; text?: string }[]; isError?: boolean }>('tools/call', {
      name,
      arguments: args ?? {},
    });
    const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (r.isError) throw new Error(text.slice(0, 300) || `PayPal MCP tool ${name} failed`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.failAll(new Error('MCP client closed'));
  }
}

/** Open a session against PayPal's MCP server with the app's own access token. */
export async function connectPayPalMcp(): Promise<McpSseClient> {
  const client = new McpSseClient(paypalMcpUrl(), accessToken);
  try {
    await client.connect();
    return client;
  } catch (err) {
    client.close();
    throw err;
  }
}
