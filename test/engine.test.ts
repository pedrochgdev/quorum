// The money paths added after the first release, on the simulated PayPal ledger:
// leaving a group (void), joining late, and the price-drop refund.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
process.env.PAYPAL_MODE = 'mock';
process.env.ANTHROPIC_API_KEY = '';
process.env.CHANNEL3_API_KEY = '';
process.env.LATE_JOIN_HOURS = '24';

const { openDb, get, all } = await import('../src/db.ts');
const { createMerchant, createProduct, createQuorum, getProduct, getQuorum, quorumView } = await import('../src/models.ts');
const { addSimulatedBuyer, applyPriceDrop, commitmentForToken, settleQuorum, startCheckout, completeAuthorization, withdrawCommitment } = await import('../src/engine.ts');
const { mockPayPal } = await import('../src/paypal/index.ts');
const { repairDraft } = await import('../src/ai/offer.ts');
openDb(':memory:');

const merchant = createMerchant('Test Merchant');
function group(tiers = [{ min: 3, price: 90 }, { min: 5, price: 80 }], floor = 70) {
  const p = createProduct({ merchantId: merchant.id, title: `Thing ${Math.random()}`, category: 'other', listPrice: 100, floorPrice: floor, stock: 10, tiers });
  return createQuorum(getProduct(p.id)!, 1, 'test');
}
const mockStatus = (id: string) => get<{ status: string }>('SELECT status FROM mock_paypal WHERE id = ?', id)!.status;

test('a buyer can leave an open group: the authorization is voided, and only with their token', async () => {
  const q = group();
  const start = await startCheckout(q.id, { email: 'ana@example.com', provider: 'mock' });
  mockPayPal.approve(start.orderId, 'ana@example.com');
  const c = await completeAuthorization(q.id, start.orderId);
  assert.equal(quorumView(getQuorum(q.id)!).members, 1);

  await assert.rejects(withdrawCommitment(c.id, 'wrong-token'), /token/);
  assert.throws(() => commitmentForToken(c.id, ''), /token/);
  const out = await withdrawCommitment(c.id, start.token);
  assert.equal(out.status, 'voided');
  assert.equal(mockStatus(c.authorization_id!), 'VOIDED');
  assert.equal(quorumView(getQuorum(q.id)!).members, 0);
  // The view never leaks tokens.
  assert.ok(!JSON.stringify(quorumView(getQuorum(q.id)!)).includes(start.token));
  // They can come back.
  const again = await startCheckout(q.id, { email: 'ana@example.com', provider: 'mock' });
  assert.ok(again.orderId);
});

test('nobody can leave once the group is closing', async () => {
  const q = group();
  const start = await startCheckout(q.id, { email: 'leo@example.com', provider: 'mock' });
  mockPayPal.approve(start.orderId, 'leo@example.com');
  const c = await completeAuthorization(q.id, start.orderId);
  for (const e of ['b@example.com', 'c@example.com']) await addSimulatedBuyer(q.id, e);
  await settleQuorum(q.id, { force: true });
  await assert.rejects(withdrawCommitment(c.id, start.token), /settled/);
});

test('a spending limit caps the authorization, and a limit below the group price is refused', async () => {
  const q = group();
  const capped = await startCheckout(q.id, { email: 'cap@example.com', provider: 'mock', maxPrice: 95 });
  assert.equal(capped.amount, 95);
  await assert.rejects(startCheckout(q.id, { email: 'low@example.com', provider: 'mock', maxPrice: 60 }), /maximum price/);
});

test('late buyers join a closed group at the final price; reaching a cheaper tier refunds everyone', async () => {
  const q = group([{ min: 3, price: 90 }, { min: 5, price: 80 }], 78);
  for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) await addSimulatedBuyer(q.id, e);
  const closed = await settleQuorum(q.id, { force: true });
  assert.equal(closed.status, 'closed');
  const price = closed.finalPrice!;
  assert.ok(price >= 78 && price <= 90, String(price));

  let v = quorumView(getQuorum(q.id)!);
  assert.equal(v.lateJoin.open, true);
  assert.equal(v.lateJoin.price, price);
  // At 5 buyers the public price falls from 90 to 80, so the deal falls by 10 too, but never below the floor (78).
  const target = Math.max(78, price - 10);
  assert.deepEqual(v.lateJoin.nextDrop, target < price ? { needed: 2, price: target, refundEach: Math.round((price - target) * 100) / 100 } : null);

  // First late buyer: authorizes exactly the final price and is captured at once. No tier change yet.
  const late1 = await startCheckout(q.id, { email: 'late1@example.com', provider: 'mock' });
  assert.equal(late1.amount, price);
  assert.equal(late1.late, true);
  mockPayPal.approve(late1.orderId, 'late1@example.com');
  const c1 = await completeAuthorization(q.id, late1.orderId);
  assert.equal(c1.status, 'captured');
  assert.equal(c1.captured_amount, price);
  assert.equal(getQuorum(q.id)!.final_price, price);

  // Second late buyer makes 5: the cheaper tier applies and all five end up paying the same lower price.
  await addSimulatedBuyer(q.id, 'late2@example.com');
  v = quorumView(getQuorum(q.id)!);
  assert.equal(v.finalPrice, target);
  assert.equal(v.negotiatedPrice, price);
  const paid = v.commitments.filter((c) => c.status === 'captured');
  assert.equal(paid.length, 5);
  assert.ok(paid.every((c) => c.paid === target), JSON.stringify(paid.map((c) => c.paid)));
  if (target < price) {
    // The buyer who triggered the drop was charged the new price directly; the four before them were refunded.
    const refunds = all<{ amount: number }>("SELECT amount FROM mock_paypal WHERE kind = 'refund'");
    assert.equal(refunds.length, 4);
    assert.equal(v.priceExplain.refundedTotal, Math.round((price - target) * 4 * 100) / 100);
    assert.equal(paid.find((c) => c.name === 'Late2')!.refunded, 0);
  }
  // Running the drop again refunds nothing more.
  assert.equal(await applyPriceDrop(q.id), null);
  assert.equal(getProduct(getQuorum(q.id)!.product_id)!.stock, 5);
});

test('a price drop never goes below the merchant floor', async () => {
  const q = group([{ min: 2, price: 95 }, { min: 3, price: 60 }], 88);
  for (const e of ['a@example.com', 'b@example.com']) await addSimulatedBuyer(q.id, e);
  const closed = await settleQuorum(q.id, { force: true });
  await addSimulatedBuyer(q.id, 'late@example.com');
  const v = quorumView(getQuorum(q.id)!);
  assert.ok(v.finalPrice! >= 88, `final ${v.finalPrice} must respect the floor 88 (was ${closed.finalPrice})`);
  assert.ok(v.commitments.filter((c) => c.status === 'captured').every((c) => c.paid! >= 88));
});

test('the pricing agent draft is repaired to obey the pricing rules', () => {
  const cluster = { count: 3, medianMax: 280 };
  // A model draft with everything wrong: goal too large and too expensive, tiers rising, floor above tiers, list below goal.
  const fixed = repairDraft({ listPrice: 250, floorPrice: 400, tiers: [{ min: 10, price: 320 }, { min: 12, price: 330 }] }, cluster);
  assert.ok(fixed.tiers[0].min <= 3, 'goal reachable by waiting demand');
  assert.ok(fixed.tiers[0].price <= 280, 'goal price within the median maximum');
  assert.ok(fixed.tiers[1].price < fixed.tiers[0].price && fixed.tiers[1].min > fixed.tiers[0].min, 'tiers fall as volume grows');
  assert.ok(fixed.listPrice > fixed.tiers[0].price, 'list above the goal price');
  assert.ok(fixed.floorPrice <= fixed.tiers[1].price, 'floor at or below the cheapest tier');
  // Garbage in still produces a usable offer.
  const empty = repairDraft({ listPrice: NaN, floorPrice: NaN, tiers: [] }, { count: 1, medianMax: null });
  assert.ok(empty.tiers.length === 1 && empty.tiers[0].min === 2 && empty.listPrice > empty.tiers[0].price && empty.floorPrice <= empty.tiers[0].price);
});
