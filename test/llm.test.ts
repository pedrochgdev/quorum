// The LLM paths, with the Anthropic API stubbed: structured output is parsed,
// and invalid prices from the model are rejected by code.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.DB_FILE = ':memory:';

const { structured, strictSchema } = await import('../src/ai/llm.ts');
const { negotiate } = await import('../src/ai/negotiate.ts');
const { mapChannel3Products, comparableOffers } = await import('../src/ai/catalog.ts');

type Reply = (body: any) => any;
function stubAnthropic(reply: Reply) {
  const seen: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], 'test-key');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(init.body);
    seen.push(body);
    return new Response(JSON.stringify({ content: reply(body), stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = real) };
}
const json = (o: unknown) => [{ type: 'text', text: JSON.stringify(o) }];

test('structured() asks for a JSON schema and parses the answer', async () => {
  const s = stubAnthropic(() => json({ fits: true, reason: 'ok' }));
  try {
    const out = await structured<{ fits: boolean }>({
      system: 's',
      prompt: 'p',
      schema: { type: 'object', properties: { fits: { type: 'boolean' }, reason: { type: 'string' } }, required: ['fits', 'reason'] },
    });
    assert.deepEqual(out, { fits: true, reason: 'ok' });
    const sent = s.seen[0];
    assert.equal(sent.output_config.format.type, 'json_schema');
    assert.equal(sent.output_config.format.schema.additionalProperties, false);
    // Current Claude models reject sampling parameters and forced tool choice.
    assert.equal(sent.temperature, undefined);
    assert.equal(sent.tool_choice, undefined);
  } finally {
    s.restore();
  }
});

test('strictSchema() closes objects, drops numeric limits and rewrites nullable types', () => {
  const out = strictSchema({
    type: 'object',
    properties: {
      max_price: { type: ['number', 'null'], description: 'max' },
      quantity: { type: 'integer', minimum: 1, maximum: 10 },
      tiers: { type: 'array', items: { type: 'object', properties: { min: { type: 'integer' } }, required: ['min'] } },
    },
    required: ['max_price', 'quantity', 'tiers'],
  }) as any;
  assert.equal(out.additionalProperties, false);
  assert.deepEqual(out.properties.max_price, { description: 'max', anyOf: [{ type: 'number' }, { type: 'null' }] });
  assert.deepEqual(out.properties.quantity, { type: 'integer' });
  assert.equal(out.properties.tiers.items.additionalProperties, false);
});

test('structured() returns null on API errors so callers fall back', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"error":{"message":"overloaded"}}', { status: 529 })) as typeof fetch;
  try {
    assert.equal(await structured({ system: 's', prompt: 'p', schema: {} }), null);
  } finally {
    globalThis.fetch = real;
  }
});

test('a merchant offer below the floor is rejected and replaced; the merchant briefs itself with tools first', async () => {
  let turn = 0;
  let agentStep = 0;
  const s = stubAnthropic((body) => {
    if (body.tools) {
      // Agent loop: first a PayPal tool call, then the final briefing.
      assert.equal(body.tool_choice.type, 'auto');
      agentStep++;
      if (agentStep === 1) return [{ type: 'tool_use', id: 'a1', name: 'list_transactions', input: { days: 30 } }];
      return [{ type: 'tool_use', id: 'a2', name: 'briefing', input: { notes: 'steady sales' } }];
    }
    turn++;
    // Buyer opens at 150; merchant (turn 2) illegally offers 120 (< floor 160); buyer then accepts the replacement.
    const plays = [
      { message: 'We offer 150.', action: 'offer', price: 150 },
      { message: 'Fine, 120.', action: 'offer', price: 120 },
      { message: 'Deal.', action: 'accept', price: 0 },
    ];
    return json(plays[Math.min(turn - 1, plays.length - 1)]);
  });
  const seenTurns: number[] = [];
  const phases: string[] = [];
  let closed = false;
  try {
    const r = await negotiate(
      { productTitle: 'Espresso machine', members: 7, minMembers: 5, listPrice: 199, tierPrice: 179, floor: 160, buyerCeiling: 199, market: [], maxTurns: 6 },
      {
        openToolkit: async () => ({
          source: 'PayPal MCP server',
          close: () => (closed = true),
          tools: [{ name: 'list_transactions', description: 'd', input_schema: { type: 'object', properties: {} }, run: async () => ({ paypal_transactions: 12 }) }],
        }),
        onPhase: (p) => phases.push(p),
        onTurn: (turns) => seenTurns.push(turns.length),
      },
    );
    assert.equal(r.engine, 'llm');
    assert.match(r.turns[1].rejected ?? '', /floor/);
    assert.ok(r.turns[1].offer! >= 160);
    assert.ok(r.finalPrice >= 160 && r.finalPrice <= 179, String(r.finalPrice));
    assert.deepEqual(r.turns[1].tools?.map((t) => t.name), ['list_transactions']);
    assert.equal(r.turns[1].toolSource, 'PayPal MCP server');
    assert.deepEqual(phases, ['briefing', 'running']);
    assert.deepEqual(seenTurns, [1, 2, 3], 'each turn is reported as it happens');
    assert.ok(closed, 'the toolkit is closed after the briefing');
    // Prompts fence untrusted text, and tool results go back in one user message.
    assert.ok(s.seen.some((b) => String(b.messages[0].content).includes('<transcript>')));
    const afterTool = s.seen.find((b) => b.tools && b.messages.length === 3);
    assert.equal(afterTool.messages[2].content[0].type, 'tool_result');
  } finally {
    s.restore();
  }
});

test('comparable offers keep only prices near the product and drop duplicates', () => {
  const offers = [
    { title: 'Cheap accessory', price: 19, merchant: 'a' },
    { title: 'Similar machine', price: 175, merchant: 'b' },
    { title: 'Similar machine', price: 175, merchant: 'b' },
    { title: 'Another', price: 210, merchant: 'c' },
    { title: 'Pro model', price: 899, merchant: 'd' },
  ];
  assert.deepEqual(comparableOffers(offers, 199).map((o) => o.price), [175, 210]);
});

test('Channel3 search results map to market offers (cheapest offer wins)', () => {
  const offers = mapChannel3Products({
    products: [
      {
        id: '2yh8WH5',
        title: 'Compact Espresso Machine',
        images: [{ url: 'https://img.example/1.jpg' }],
        offers: [
          { domain: 'shop-a.example', price: { amount: 189, currency: 'USD' }, availability: 'InStock', url: 'https://buy.example/a' },
          { domain: 'shop-b.example', price: { amount: 175, currency: 'USD' }, availability: 'InStock', url: 'https://buy.example/b' },
        ],
      },
      { id: 'x', title: 'No price product', offers: [] },
    ],
  });
  assert.equal(offers.length, 1);
  assert.deepEqual(offers[0], { title: 'Compact Espresso Machine', price: 175, merchant: 'shop-b.example', url: 'https://buy.example/b', image: 'https://img.example/1.jpg' });
});
