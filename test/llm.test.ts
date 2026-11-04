// The LLM paths, with the Anthropic API stubbed: structured output is parsed,
// and invalid prices from the model are rejected by code.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.DB_FILE = ':memory:';

const { structured } = await import('../src/ai/llm.ts');
const { negotiate } = await import('../src/ai/negotiate.ts');
const { mapChannel3Products } = await import('../src/ai/catalog.ts');

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
    return new Response(JSON.stringify({ content: reply(body) }), { status: 200 });
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = real) };
}

test('structured() forces a tool call and returns its input', async () => {
  const s = stubAnthropic((body) => [{ type: 'tool_use', id: 't1', name: body.tool_choice.name, input: { fits: true, reason: 'ok' } }]);
  try {
    const out = await structured<{ fits: boolean }>({ system: 's', prompt: 'p', schema: { type: 'object' } });
    assert.deepEqual(out, { fits: true, reason: 'ok' });
    assert.equal(s.seen[0].tool_choice.type, 'tool');
  } finally {
    s.restore();
  }
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

test('a merchant offer below the floor is rejected and replaced', async () => {
  let turn = 0;
  const s = stubAnthropic((body) => {
    if (body.tool_choice?.type === 'any') return [{ type: 'tool_use', id: 'b', name: 'briefing', input: { notes: 'steady sales' } }];
    turn++;
    // Buyer opens at 150; merchant (turn 2) illegally offers 120 (< floor 160); buyer then accepts 170 (merchant's replacement is checked).
    const plays = [
      { message: 'We offer 150.', action: 'offer', price: 150 },
      { message: 'Fine, 120.', action: 'offer', price: 120 },
      { message: 'Deal.', action: 'accept', price: 0 },
    ];
    return [{ type: 'tool_use', id: `t${turn}`, name: 'submit', input: plays[Math.min(turn - 1, plays.length - 1)] }];
  });
  try {
    const r = await negotiate({
      productTitle: 'Espresso machine',
      members: 7,
      minMembers: 5,
      listPrice: 199,
      tierPrice: 179,
      floor: 160,
      buyerCeiling: 199,
      market: [],
      maxTurns: 6,
    });
    assert.equal(r.engine, 'llm');
    assert.match(r.turns[1].rejected ?? '', /floor/);
    assert.ok(r.turns[1].offer! >= 160);
    assert.ok(r.finalPrice >= 160 && r.finalPrice <= 179, String(r.finalPrice));
    // Prompts fence untrusted text.
    assert.ok(s.seen.some((b) => String(b.messages[0].content).includes('<transcript>')));
  } finally {
    s.restore();
  }
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
