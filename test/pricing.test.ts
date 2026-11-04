import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizationAmount, growthMath, minMembers, nextTier, normalizeTiers, priceFor } from '../src/pricing.ts';

const tiers = normalizeTiers([{ min: 5, price: 179 }, { min: 8, price: 169 }], 199);

test('normalizeTiers adds the list price tier and sorts', () => {
  assert.deepEqual(tiers, [
    { min: 1, price: 199 },
    { min: 5, price: 179 },
    { min: 8, price: 169 },
  ]);
});

test('prices never rise with volume', () => {
  const t = normalizeTiers([{ min: 3, price: 90 }, { min: 6, price: 95 }], 100);
  assert.equal(t[2].price, 90);
});

test('priceFor and minMembers follow the tiers', () => {
  assert.equal(minMembers(tiers), 5);
  assert.equal(priceFor(tiers, 1), 199);
  assert.equal(priceFor(tiers, 4), 199);
  assert.equal(priceFor(tiers, 5), 179);
  assert.equal(priceFor(tiers, 9), 169);
  assert.deepEqual(nextTier(tiers, 5), { min: 8, price: 169 });
  assert.equal(nextTier(tiers, 8), null);
});

test('growthMath tells members what the next person is worth', () => {
  const g = growthMath(tiers, 6);
  assert.equal(g.needed, 2);
  assert.equal(g.savingPerPerson, 10);
  assert.equal(g.unlockPrice, 169);
});

test('authorizationAmount: list price, capped by buyer max, refused below the group price', () => {
  assert.equal(authorizationAmount(tiers, null), 199);
  assert.equal(authorizationAmount(tiers, 185), 185);
  assert.equal(authorizationAmount(tiers, 179), 179);
  assert.equal(authorizationAmount(tiers, 150), null);
});
