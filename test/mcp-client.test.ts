// The MCP client that talks to PayPal's remote MCP server, against a local
// server speaking the same HTTP + SSE transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DB_FILE = ':memory:';
const { McpSseClient } = await import('../src/paypal/mcp-client.ts');

function startStub() {
  let stream: ServerResponse | null = null;
  const seen: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer tok') return void res.writeHead(401).end();
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      stream = res;
      // Split the event across writes: the parser must handle partial chunks.
      res.write('event: endpoint\ndata: /sse/mes');
      setTimeout(() => res.write('sage?sessionId=abc\n\n'), 10);
      return;
    }
    if (req.method === 'POST' && req.url === '/sse/message?sessionId=abc') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const msg = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(msg);
      res.writeHead(202).end();
      if (msg.id === undefined) return;
      let result: unknown = {};
      if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } };
      if (msg.method === 'tools/list') result = { tools: [{ name: 'list_products', description: 'd', inputSchema: { type: 'object' } }] };
      if (msg.method === 'tools/call') {
        result = msg.params.name === 'boom'
          ? { isError: true, content: [{ type: 'text', text: 'not allowed' }] }
          : { content: [{ type: 'text', text: JSON.stringify({ products: [{ id: 'PROD-1' }], echo: msg.params.arguments }) }] };
      }
      stream!.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\r\n\r\n`);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise<{ url: string; seen: any[]; close: () => void }>((ok) =>
    server.listen(0, () => ok({ url: `http://localhost:${(server.address() as AddressInfo).port}/sse`, seen, close: () => { stream?.end(); server.close(); } })),
  );
}

test('MCP client: handshake, tools/list and tools/call over HTTP + SSE', async () => {
  const stub = await startStub();
  const client = new McpSseClient(stub.url, async () => 'tok');
  try {
    await client.connect();
    assert.deepEqual(stub.seen.map((m) => m.method), ['initialize', 'notifications/initialized']);
    assert.deepEqual((await client.listTools()).map((t) => t.name), ['list_products']);
    const out = (await client.callTool('list_products', { page_size: 5 })) as any;
    assert.equal(out.products[0].id, 'PROD-1');
    assert.deepEqual(out.echo, { page_size: 5 });
    await assert.rejects(client.callTool('boom', {}), /not allowed/);
  } finally {
    client.close();
    stub.close();
  }
});

test('MCP client: a wrong token fails the connection instead of hanging', async () => {
  const stub = await startStub();
  const client = new McpSseClient(stub.url, async () => 'nope');
  try {
    await assert.rejects(client.connect(), /401/);
  } finally {
    client.close();
    stub.close();
  }
});
