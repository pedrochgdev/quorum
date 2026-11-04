// Checkout and settlement. This is the only code that moves money, and it has
// no AI in it: the agents propose prices, this module validates and executes.
import { config } from './config.ts';
import { all, get, run } from './db.ts';
import { logAgent, recordEvent } from './events.ts';
import {
  commitmentsFor,
  getCommitment,
  getIntent,
  getProduct,
  getQuorum,
  listQuorums,
  tiersOf,
  type Commitment,
  type MarketOffer,
} from './models.ts';
import { authorizationAmount, priceFor } from './pricing.ts';
import { checkoutProvider, mockPayPal, providerFor, PayPalError } from './paypal/index.ts';
import { merchantTools } from './paypal/merchant-tools.ts';
import { dealBounds, negotiate } from './ai/negotiate.ts';
import { clamp, money, newId, nowIso, round2, safeJson } from './util.ts';

const HONOR_PERIOD_MS = 3 * 86400_000; // funds guaranteed for 3 days after (re)authorization
const AUTH_VALID_MS = 29 * 86400_000; // an authorization can be reauthorized within 29 days

export class CheckoutError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const displayName = (email: string) => {
  const local = email.split('@')[0].replace(/\+.*$/, '').replace(/[._-]+/g, ' ').trim();
  const first = local.split(' ')[0] || 'Buyer';
  return first.charAt(0).toUpperCase() + first.slice(1, 14);
};

/** Step 1: create the commitment and a PayPal order with intent AUTHORIZE. */
export async function startCheckout(
  quorumId: string,
  input: { email: string; intentId?: string | null; referrerId?: string | null; provider?: 'paypal' | 'mock' },
) {
  const q = getQuorum(quorumId);
  if (!q) throw new CheckoutError('Group not found', 404);
  if (q.status !== 'open' || Date.parse(q.closes_at) <= Date.now()) throw new CheckoutError('This group is no longer open', 409);
  const product = getProduct(q.product_id)!;
  const tiers = tiersOf(product);
  const intent = input.intentId ? getIntent(input.intentId) : undefined;
  const amount = authorizationAmount(tiers, intent?.max_price ?? null);
  if (amount === null) throw new CheckoutError('Your maximum price is below this group\'s price', 422);
  const existing = get<Commitment>(
    "SELECT * FROM commitments WHERE quorum_id = ? AND lower(email) = lower(?) AND status IN ('authorized','captured')", q.id, input.email,
  );
  if (existing) throw new CheckoutError('You are already in this group', 409);
  const referrer = input.referrerId ? getCommitment(input.referrerId) : undefined;

  const provider = input.provider === 'mock' ? mockPayPal : checkoutProvider();
  const id = newId('cmt');
  const t = nowIso();
  run(
    `INSERT INTO commitments (id, quorum_id, intent_id, email, display_name, provider, authorized_amount, status, referrer_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, q.id, intent?.id ?? null, input.email.trim(), displayName(input.email), provider.name, amount, 'created',
    referrer && referrer.quorum_id === q.id ? referrer.id : null, t, t,
  );
  const order = await provider.createOrder({
    amount,
    currency: config.paypal.currency,
    customId: id,
    referenceId: q.id,
    description: `Quorum group: ${product.title}`,
    requestId: `order-${id}`,
  });
  run('UPDATE commitments SET paypal_order_id = ?, updated_at = ? WHERE id = ?', order.id, nowIso(), id);
  return { commitmentId: id, orderId: order.id, amount, approveUrl: order.approveUrl, provider: provider.name };
}

/** Step 2: after the buyer approves in PayPal, authorize the order (no money moves yet). */
export async function completeAuthorization(quorumId: string, orderId: string) {
  const c = get<Commitment>('SELECT * FROM commitments WHERE paypal_order_id = ? AND quorum_id = ?', orderId, quorumId);
  if (!c) throw new CheckoutError('Commitment not found for this order', 404);
  if (c.status === 'authorized' || c.status === 'captured') return c;
  const q = getQuorum(quorumId)!;
  if (q.status !== 'open') throw new CheckoutError('This group closed before your authorization', 409);
  const auth = await providerFor(c.provider).authorizeOrder(orderId, `auth-${c.id}`);
  run(
    `UPDATE commitments SET status = 'authorized', authorization_id = ?, authorized_amount = ?, authorized_at = ?, updated_at = ? WHERE id = ?`,
    auth.authorizationId, auth.amount || c.authorized_amount, nowIso(), nowIso(), c.id,
  );
  if (c.intent_id) run("UPDATE intents SET status = 'committed' WHERE id = ?", c.intent_id);
  recordEvent('quorum.member_authorized', 'quorum', q.id, { commitment: c.id, amount: auth.amount });
  return getCommitment(c.id)!;
}

/** Demo helper: add a simulated buyer (mock PayPal) to a group. */
export async function addSimulatedBuyer(quorumId: string, email: string, referrerId: string | null = null) {
  const start = await startCheckout(quorumId, { email, referrerId, provider: 'mock' });
  mockPayPal.approve(start.orderId, email);
  return completeAuthorization(quorumId, start.orderId);
}

export type SettleOutcome = { quorumId: string; status: string; finalPrice?: number | null; captured?: number; voided?: number; failed?: number };

/** Close a group: negotiate and capture if the goal was reached, otherwise void everything. */
export async function settleQuorum(quorumId: string, opts: { force?: boolean } = {}): Promise<SettleOutcome> {
  const q = getQuorum(quorumId);
  if (!q) throw new CheckoutError('Group not found', 404);
  if (q.status === 'closed' || q.status === 'failed') return { quorumId, status: q.status, finalPrice: q.final_price };
  if (q.status === 'open') {
    if (!opts.force && Date.parse(q.closes_at) > Date.now()) return { quorumId, status: 'open' };
    // Atomic claim so two settle runs never process the same group.
    const claimed = run("UPDATE quorums SET status = 'negotiating' WHERE id = ? AND status = 'open'", q.id);
    if (Number(claimed.changes) !== 1) return { quorumId, status: getQuorum(q.id)!.status };
  }

  const product = getProduct(q.product_id)!;
  const tiers = tiersOf(product);
  let members = commitmentsFor(q.id).filter((c) => c.status === 'authorized');
  const already = commitmentsFor(q.id).filter((c) => c.status === 'captured');
  const count = members.length + already.length;

  // Abandoned checkouts never reached PayPal authorization; mark them so they do not linger.
  run("UPDATE commitments SET status = 'voided', failure_reason = 'checkout not completed', updated_at = ? WHERE quorum_id = ? AND status = 'created'", nowIso(), q.id);

  if (count < q.min_members && !already.length) {
    let voided = 0;
    for (const c of members) {
      try {
        await providerFor(c.provider).voidAuthorization(c.authorization_id!, `void-${c.id}`);
        run("UPDATE commitments SET status = 'voided', updated_at = ? WHERE id = ?", nowIso(), c.id);
        voided++;
      } catch (err) {
        run("UPDATE commitments SET status = 'voided', failure_reason = ?, updated_at = ? WHERE id = ?", (err as Error).message, nowIso(), c.id);
      }
    }
    const summary = `Did not reach the goal (${count} of ${q.min_members}). All ${voided} authorizations were voided; nobody was charged.`;
    run("UPDATE quorums SET status = 'failed', closed_at = ?, summary = ? WHERE id = ?", nowIso(), summary, q.id);
    recordEvent('quorum.failed', 'engine', q.id, { count, voided });
    return { quorumId, status: 'failed', voided };
  }

  // Goal reached: negotiate once (resumable), then capture at the agreed price.
  let finalPrice = getQuorum(q.id)!.final_price;
  if (finalPrice === null) {
    const tierPrice = priceFor(tiers, count);
    const ceiling = Math.min(...[...members, ...already].map((c) => c.authorized_amount));
    const input = {
      productTitle: product.title,
      members: count,
      minMembers: q.min_members,
      listPrice: product.list_price,
      tierPrice,
      floor: product.floor_price,
      buyerCeiling: ceiling,
      market: safeJson<MarketOffer[]>(q.market_json, []),
      maxTurns: config.quorum.maxNegotiationTurns,
    };
    const result = await negotiate(input, merchantTools(product));
    const { lo, hi } = dealBounds(input);
    finalPrice = round2(clamp(result.finalPrice, lo, hi)); // defense in depth: limits enforced again here
    run(
      'INSERT INTO negotiations (id, quorum_id, turns_json, final_price, status, engine, created_at) VALUES (?,?,?,?,?,?,?)',
      newId('neg'), q.id, JSON.stringify(result.turns), finalPrice, 'agreed', result.engine, nowIso(),
    );
    logAgent('negotiation', q.id, `agreed ${finalPrice}`, `Tier price ${tierPrice}, floor kept private, ${result.turns.length} turns`, result.engine);
    run("UPDATE quorums SET final_price = ?, status = 'settling' WHERE id = ?", finalPrice, q.id);
  }

  let captured = already.length;
  let failed = 0;
  for (const c of members) {
    const provider = providerFor(c.provider);
    try {
      let authId = c.authorization_id!;
      const authorizedAt = Date.parse(c.authorized_at ?? c.created_at);
      if (c.provider === 'paypal' && Date.now() - authorizedAt > HONOR_PERIOD_MS && Date.now() - authorizedAt < AUTH_VALID_MS) {
        const re = await provider.reauthorize(authId, c.authorized_amount, config.paypal.currency, `reauth-${c.id}-${authId}`);
        authId = re.authorizationId;
        run('UPDATE commitments SET authorization_id = ?, authorized_at = ?, updated_at = ? WHERE id = ?', authId, nowIso(), nowIso(), c.id);
      }
      const current = await provider.getAuthorization(authId);
      if (!['CREATED', 'PARTIALLY_CAPTURED', 'PENDING'].includes(current.status)) {
        throw new PayPalError(`Authorization is ${current.status}`, 422, {});
      }
      const amount = round2(Math.min(finalPrice, c.authorized_amount));
      const cap = await provider.captureAuthorization(authId, amount, config.paypal.currency, `cap-${c.id}`);
      if (cap.status === 'COMPLETED' || cap.status === 'PENDING') {
        run(
          "UPDATE commitments SET status = 'captured', captured_amount = ?, capture_id = ?, updated_at = ? WHERE id = ?",
          cap.amount, cap.captureId, nowIso(), c.id,
        );
        captured++;
      } else {
        run("UPDATE commitments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", `capture ${cap.status}`, nowIso(), c.id);
        failed++;
      }
    } catch (err) {
      run("UPDATE commitments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", (err as Error).message.slice(0, 300), nowIso(), c.id);
      failed++;
    }
  }

  run('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?', captured, product.id);
  await payReferralRewards(q.id);
  const saved = round2(product.list_price - finalPrice);
  const summary =
    `Closed with ${captured} buyers at ${money(finalPrice)} each (${money(saved)} below the ${money(product.list_price)} list price).` +
    (failed ? ` ${failed} payment${failed === 1 ? '' : 's'} could not be captured.` : '');
  run("UPDATE quorums SET status = 'closed', closed_at = ?, summary = ? WHERE id = ?", nowIso(), summary, q.id);
  recordEvent('quorum.closed', 'engine', q.id, { captured, failed, finalPrice });
  return { quorumId, status: 'closed', finalPrice, captured, failed };
}

/** Optional: reward members whose invites turned into paid members (Payouts API). */
async function payReferralRewards(quorumId: string) {
  const reward = config.quorum.referralReward;
  if (!reward || reward <= 0) return;
  const rows = all<{ referrer_id: string; n: number }>(
    "SELECT referrer_id, COUNT(*) AS n FROM commitments WHERE quorum_id = ? AND status = 'captured' AND referrer_id IS NOT NULL GROUP BY referrer_id",
    quorumId,
  );
  for (const r of rows) {
    const referrer = getCommitment(r.referrer_id);
    if (!referrer || referrer.status !== 'captured') continue;
    const already = get('SELECT id FROM payouts WHERE quorum_id = ? AND commitment_id = ?', quorumId, referrer.id);
    if (already) continue;
    const amount = round2(reward * r.n);
    try {
      const out = await providerFor(referrer.provider).createPayout(
        [{ email: referrer.email, amount, note: `Thanks for bringing ${r.n} people to your Quorum group`, senderItemId: `ref-${referrer.id}` }],
        config.paypal.currency,
        `payout-${quorumId}-${referrer.id}`,
      );
      run('INSERT INTO payouts (id, quorum_id, commitment_id, amount, batch_id, status, created_at) VALUES (?,?,?,?,?,?,?)',
        newId('pay'), quorumId, referrer.id, amount, out.batchId, out.status, nowIso());
    } catch (err) {
      run('INSERT INTO payouts (id, quorum_id, commitment_id, amount, batch_id, status, created_at) VALUES (?,?,?,?,?,?,?)',
        newId('pay'), quorumId, referrer.id, amount, null, `FAILED: ${(err as Error).message.slice(0, 120)}`, nowIso());
    }
  }
}

/** Keep long-running groups' funds guaranteed: reauthorize after the 3-day honor period. */
export async function reauthorizeSweep() {
  const now = Date.now();
  for (const q of listQuorums('open')) {
    for (const c of commitmentsFor(q.id)) {
      if (c.status !== 'authorized' || c.provider !== 'paypal' || !c.authorized_at) continue;
      const age = now - Date.parse(c.authorized_at);
      const created = now - Date.parse(c.created_at);
      if (age <= HONOR_PERIOD_MS || created >= AUTH_VALID_MS) continue;
      try {
        const re = await providerFor(c.provider).reauthorize(c.authorization_id!, c.authorized_amount, config.paypal.currency, `reauth-${c.id}-${c.authorization_id}`);
        run('UPDATE commitments SET authorization_id = ?, authorized_at = ?, updated_at = ? WHERE id = ?', re.authorizationId, nowIso(), nowIso(), c.id);
      } catch (err) {
        recordEvent('reauthorize.failed', 'engine', c.id, { error: (err as Error).message });
      }
    }
  }
}

let running = false;
/** Settle every group that is due (or stuck mid-settlement). Safe to call repeatedly. */
export async function settleDue(): Promise<SettleOutcome[]> {
  if (running) return [];
  running = true;
  try {
    const due = all<{ id: string }>(
      "SELECT id FROM quorums WHERE (status = 'open' AND closes_at <= ?) OR status IN ('negotiating','settling')",
      nowIso(),
    );
    const out: SettleOutcome[] = [];
    for (const { id } of due) {
      try {
        // Resume groups stuck in negotiating/settling by forcing past the open check.
        out.push(await settleQuorum(id, { force: true }));
      } catch (err) {
        console.error('[engine] settle failed for', id, err);
      }
    }
    await reauthorizeSweep();
    return out;
  } finally {
    running = false;
  }
}
