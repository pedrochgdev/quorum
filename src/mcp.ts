// Quorum as an MCP server (Streamable HTTP transport, JSON responses), so an
// external agent such as Claude or ChatGPT can add its user to a group:
//   POST /mcp  with JSON-RPC 2.0 messages.
// An agent can run the whole buyer flow: find or create demand (add_intent),
// start the PayPal authorization (join_quorum), confirm it, check it and leave
// (leave_quorum voids the hold). Agents never get to move money on their own:
// the person still approves the PayPal authorization at the returned link, and
// max_price is a spending limit the engine enforces.
import { config } from './config.ts';
import { readJson, route, sendJson } from './http.ts';
import { commitmentForToken, completeAuthorization, startCheckout, withdrawCommitment } from './engine.ts';
import { getQuorum, listQuorums, quorumView, type Commitment } from './models.ts';
import { demandBoard, submitIntent } from './ai/intent.ts';
import { isEmail } from './util.ts';

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'add_intent',
    description:
      'Submit what the user wants to buy, in natural language (English or Spanish). Quorum groups it with people who want the same thing. Returns the matching group, or puts the request on the merchant demand board.',
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
    description: 'Get one buying group by id: price tiers, members, status, negotiation result and how the price was reached.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'join_quorum',
    description:
      'Start joining a group for the user. Creates a PayPal order with intent AUTHORIZE and returns approveUrl: the user must open it and approve. Nothing is charged unless the group forms. max_price is a spending limit you set for the user: Quorum never authorizes or captures more than it. Keep the returned commitment_id and token; they are needed to check status or leave.',
    inputSchema: {
      type: 'object',
      properties: {
        quorum_id: { type: 'string' },
        email: { type: 'string', description: "The user's email" },
        max_price: { type: 'number', description: 'Optional spending limit per unit, in the group currency' },
        intent_id: { type: 'string', description: 'Optional intent id returned by add_intent' },
      },
      required: ['quorum_id', 'email'],
    },
  },
  {
    name: 'confirm_authorization',
    description: 'After the user approved the PayPal order from join_quorum, confirm it so the user counts as a member. Safe to call more than once.',
    inputSchema: { type: 'object', properties: { quorum_id: { type: 'string' }, order_id: { type: 'string' } }, required: ['quorum_id', 'order_id'] },
  },
  {
    name: 'get_commitment',
    description: "Check the user's own commitment: authorized, captured (and how much), refunded, or released.",
    inputSchema: { type: 'object', properties: { commitment_id: { type: 'string' }, token: { type: 'string' } }, required: ['commitment_id', 'token'] },
  },
  {
    name: 'leave_quorum',
    description: 'Leave an open group for the user. PayPal voids the authorization and the hold is released. Not possible once the group is closing.',
    inputSchema: { type: 'object', properties: { commitment_id: { type: 'string' }, token: { type: 'string' } }, required: ['commitment_id', 'token'] },
  },
  {
    name: 'list_demand',
    description: 'For merchant agents: unmet demand grouped by the intent agent (what people want that no product covers yet), with how many asked and their median maximum price.',
    inputSchema: { type: 'object', properties: {} },
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
  lateJoin: v.lateJoin,
  joinUrl: `${config.baseUrl}/q/${v.id}`,
});

const absolute = (url: string | undefined) => (url && url.startsWith('/') ? `${config.baseUrl}${url}` : url ?? null);

const commitmentBrief = (c: Commitment) => ({
  commitment_id: c.id,
  quorum_id: c.quorum_id,
  status: c.status,
  authorized: c.authorized_amount,
  captured: c.captured_amount,
  refunded: c.refunded_amount,
  paid: c.captured_amount === null ? null : Math.round((c.captured_amount - c.refunded_amount) * 100) / 100,
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
        intent_id: r.intent.id,
        quorum: r.quorumId ? brief(quorumView(getQuorum(r.quorumId)!)) : null,
        approveUrl: r.quorumId ? `${config.baseUrl}/q/${r.quorumId}?intent=${r.intent.id}` : null,
        note: r.quorumId
          ? 'Call join_quorum to start the PayPal authorization for the user, or send them approveUrl. Nothing is charged unless the group forms.'
          : 'No group yet; the request is on the merchant demand board.',
      };
    }
    case 'list_open_quorums':
      return { quorums: listQuorums('open').map((q) => brief(quorumView(q))) };
    case 'get_quorum': {
      const q = getQuorum(String(args?.id ?? ''));
      if (!q) throw new Error('quorum not found');
      const v = quorumView(q);
      return { ...brief(v), negotiation: v.negotiation, priceExplain: v.priceExplain, summary: v.summary };
    }
    case 'join_quorum': {
      if (!isEmail(args?.email)) throw new Error('a valid email is required');
      const maxPrice = args?.max_price === undefined || args?.max_price === null ? null : Number(args.max_price);
      if (maxPrice !== null && !(maxPrice > 0)) throw new Error('max_price must be a positive number');
      const out = await startCheckout(String(args?.quorum_id ?? ''), {
        email: args.email,
        intentId: args?.intent_id ? String(args.intent_id) : null,
        maxPrice,
      });
      return {
        commitment_id: out.commitmentId,
        token: out.token,
        order_id: out.orderId,
        authorize_amount: out.amount,
        approveUrl: absolute(out.approveUrl),
        note: 'Ask the user to open approveUrl and approve. Then call confirm_authorization. Agents never move money: only the person can approve the PayPal authorization.',
      };
    }
    case 'confirm_authorization': {
      const c = await completeAuthorization(String(args?.quorum_id ?? ''), String(args?.order_id ?? ''));
      return commitmentBrief(c);
    }
    case 'get_commitment':
      return commitmentBrief(commitmentForToken(String(args?.commitment_id ?? ''), String(args?.token ?? '')));
    case 'leave_quorum':
      return commitmentBrief(await withdrawCommitment(String(args?.commitment_id ?? ''), String(args?.token ?? '')));
    case 'list_demand':
      return {
        demand: demandBoard().map((d) => ({ label: d.label, category: d.category, requests: d.count, medianMaxPrice: d.medianMax, earliestDeadline: d.earliestDeadline, samples: d.samples })),
        note: `Merchants open a group for a cluster at ${config.baseUrl}/merchant`,
      };
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
        serverInfo: { name: 'quorum', version: '0.2.0' },
        instructions: 'Quorum turns purchase intents into group orders. Use add_intent to find a group, join_quorum to start the PayPal authorization (send the user approveUrl), confirm_authorization after they approve, and leave_quorum to release the hold.',
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
