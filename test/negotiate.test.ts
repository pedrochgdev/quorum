import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = '';
const { dealBounds, heuristicNegotiation, validateOffer, merchantReservation } = await import('../src/ai/negotiate.ts');

const base = {
  productTitle: 'Compact espresso machine',
  members: 7,
  minMembers: 5,
  listPrice: 199,
  tierPrice: 179,
  floor: 160,
  buyerCeiling: 199,
  market: [],
  maxTurns: 6,
};

test('validateOffer enforces the merchant floor and the group ceiling', () => {
  assert.match(validateOffer('merchant', 150, base)!, /floor/);
  assert.match(validateOffer('merchant', 185, base)!, /above/);
  assert.match(validateOffer('buyer', 190, base)!, /authorized/);
  assert.equal(validateOffer('merchant', 170, base), null);
  assert.equal(validateOffer('buyer', 120, base), null); // buyers may open low
});

test('more members above the goal → merchant concedes more', () => {
  const small = merchantReservation({ ...base, members: 5 });
  const big = merchantReservation({ ...base, members: 10 });
  assert.ok(big < small, `${big} < ${small}`);
});

test('heuristic negotiation always lands inside the deal bounds', () => {
  // Randomized property check over many plausible inputs.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 2000; i++) {
    const list = 20 + Math.round(rnd() * 500);
    const floor = Math.round(list * (0.5 + rnd() * 0.4));
    const tier = Math.max(floor, Math.round(list * (0.75 + rnd() * 0.25)));
    const min = 2 + Math.floor(rnd() * 8);
    const input = {
      ...base,
      listPrice: list,
      floor,
      tierPrice: tier,
      minMembers: min,
      members: min + Math.floor(rnd() * 10),
      buyerCeiling: Math.max(tier, Math.round(list * (0.9 + rnd() * 0.1))),
      market: rnd() > 0.5 ? [{ title: 'alt', price: Math.round(list * (0.7 + rnd() * 0.4)), merchant: 'shop' }] : [],
      maxTurns: 2 + Math.floor(rnd() * 6),
    };
    const r = heuristicNegotiation(input);
    const { lo, hi } = dealBounds(input);
    assert.ok(r.finalPrice >= lo && r.finalPrice <= hi, `final ${r.finalPrice} outside [${lo}, ${hi}] for ${JSON.stringify(input)}`);
    assert.ok(r.turns.length <= input.maxTurns + 1);
    for (const t of r.turns) if (t.speaker === 'merchant_agent') assert.equal(validateOffer('merchant', t.offer!, input), null);
  }
});

test('the buyer agent cites the market alternative when it has one', () => {
  const r = heuristicNegotiation({ ...base, market: [{ title: 'Other machine', price: 175, merchant: 'shop.example' }] });
  assert.match(r.turns[0].message, /\$175/);
  assert.ok(r.finalPrice < 179);
});
