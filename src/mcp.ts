// Quorum as an MCP server (Streamable HTTP transport, JSON responses), so an
// external agent such as Claude or ChatGPT can add its user to a group:
//   POST /mcp  with JSON-RPC 2.0 messages.
// Tools: add_intent, list_open_quorums, get_quorum. Agents never get to move
// money: joining still requires the person to approve the PayPal authorization
// at the returned link.
import { config } from './config.ts';
import { readJson, route, sendJson } from './http.ts';
import { getQuorum, listQuorums, quorumView } from './models.ts';
import { submitIntent } from './ai/intent.ts';
import { isEmail } from './util.ts';

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'add_intent',
    description:
      'Submit what the user wants to buy, in natural language. Quorum groups it with people who want the same thing. Returns the group to join and a link where the user approves a PayPal authorization (nothing is charged unless the group forms).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What the user wants, including max price and deadline if known' },
        email: { type: 'string', description: 'Optional email to notify the user' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_open_quorums',
    description: 'List open buying groups with their current price, goal and time left.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_quorum',
    description: 'Get one buying group by id: price tiers, members, status and negotiation result.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

const brief = (v: ReturnType<typeof quorumView>) => ({
  id: v.id,
  product: v.product.title,
  merchant: v.merchant.name,
  status: v.status,
  members: v.members,
  goal: v.minMembers,
  listPrice: v.product.listPrice,
  currentPrice: v.currentPrice,
  finalPrice: v.finalPrice,
  tiers: v.tiers,
  closesAt: v.closesAt,
  joinUrl: `${config.baseUrl}/q/${v.id}`,
});

async function callTool(name: string, args: any) {
  switch (name) {
    case 'add_intent': {
      const text = String(args?.text ?? '').trim();
      if (text.length < 3 || text.length > 500) throw new Error('text must be 3-500 characters');
      const r = await submitIntent(text, isEmail(args?.email) ? args.email : null);
      return {
        outcome: r.outcome,
        explanation: r.explanation,
        quorum: r.quorumId ? brief(quorumView(getQuorum(r.quorumId)!)) : null,
        approveUrl: r.quorumId ? `${config.baseUrl}/q/${r.quorumId}?intent=${r.intent.id}` : null,
        note: r.quorumId
          ? 'Ask the user to open approveUrl and approve the PayPal authorization. Nothing is charged unless the group forms.'
          : 'No group yet; the request is on the merchant demand board.',
      };
    }
    case 'list_open_quorums':
      return { quorums: listQuorums('open').map((q) => brief(quorumView(q))) };
    case 'get_quorum': {
      const q = getQuorum(String(args?.id ?? ''));
      if (!q) throw new Error('quorum not found');
      const v = quorumView(q);
      return { ...brief(v), negotiation: v.negotiation, summary: v.summary };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

async function handle(msg: any): Promise<any | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'quorum', version: '0.1.0' },
        instructions: 'Quorum turns purchase intents into group orders. Use add_intent, then send the user the approveUrl.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        const out = await callTool(msg.params?.name, msg.params?.arguments ?? {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: (err as Error).message }], isError: true });
      }
    default:
      return isNotification ? null : fail(-32601, `Method not found: ${msg.method}`);
  }
}

export function registerMcp() {
  route('POST', '/mcp', async (ctx) => {
    const body = await readJson(ctx.req);
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter(Boolean);
      if (!out.length) return void ctx.res.writeHead(202).end();
      return sendJson(ctx.res, 200, out);
    }
    const out = await handle(body);
    if (!out) return void ctx.res.writeHead(202).end();
    sendJson(ctx.res, 200, out);
  });
  route('GET', '/mcp', ({ res }) => {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
  });
}
