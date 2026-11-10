// Checkout and settlement. This is the only code that moves money, and it has
// no AI in it: the agents propose prices, this module validates and executes.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { all, get, run } from './db.ts';
import { logAgent, recordEvent } from './events.ts';
import { publish } from './live.ts';
import {
  commitmentsFor,
  getCommitment,
  getIntent,
  getMerchant,
  getProduct,
  getQuorum,
  listQuorums,
  tiersOf,
  type Commitment,
  type MarketOffer,
  type NegotiationTurn,
  type Product,
  type Quorum,
} from './models.ts';
import { copy, notify } from './notify.ts';
import { authorizationAmount, priceFor } from './pricing.ts';
import { checkoutProvider, mockPayPal, providerFor, PayPalError } from './paypal/index.ts';
import { openMerchantToolkit } from './paypal/merchant-tools.ts';
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

const groupLink = (quorumId: string) => `${config.baseUrl}/q/${quorumId}`;

/** A closed group still accepts late buyers at the final price for a while. */
export function lateJoinOpen(q: Quorum, product: Product): boolean {
  return q.status === 'closed' && q.final_price !== null && !!q.late_until && Date.parse(q.late_until) > Date.now() && product.stock > 0;
}

/** Step 1: create the commitment and a PayPal order with intent AUTHORIZE. */
export async function startCheckout(
  quorumId: string,
  input: {
    email: string;
    intentId?: string | null;
    referrerId?: string | null;
    provider?: 'paypal' | 'mock';
    maxPrice?: number | null; // spending limit set by the buyer or the agent acting for them
    lang?: string;
  },
) {
  const q = getQuorum(quorumId);
  if (!q) throw new CheckoutError('Group not found', 404);
  const product = getProduct(q.product_id)!;
  const late = lateJoinOpen(q, product);
  const open = q.status === 'open' && Date.parse(q.closes_at) > Date.now();
  if (!open && !late) throw new CheckoutError('This group is no longer open', 409);
  const tiers = tiersOf(product);
  const intent = input.intentId ? getIntent(input.intentId) : undefined;
  const limits = [intent?.max_price, input.maxPrice].filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0);
  const buyerMax = limits.length ? Math.min(...limits) : null;
  // A late buyer authorizes exactly the final price; everyone else authorizes the list price (capped by their max).
  const amount = late ? (buyerMax !== null && buyerMax < q.final_price! ? null : q.final_price!) : authorizationAmount(tiers, buyerMax);
  if (amount === null) throw new CheckoutError('Your maximum price is below this group\'s price', 422);
  const existing = get<Commitment>(
    "SELECT * FROM commitments WHERE quorum_id = ? AND lower(email) = lower(?) AND status IN ('authorized','captured')", q.id, input.email,
  );
  if (existing) throw new CheckoutError('You are already in this group', 409);
  const referrer = input.referrerId ? getCommitment(input.referrerId) : undefined;
  const merchant = getMerchant(q.merchant_id);

  const provider = input.provider === 'mock' ? mockPayPal : checkoutProvider();
  const id = newId('cmt');
  const token = randomBytes(18).toString('base64url');
  const t = nowIso();
  run(
    `INSERT INTO commitments (id, quorum_id, intent_id, email, display_name, provider, authorized_amount, status, referrer_id, created_at, updated_at, token, late, lang)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, q.id, intent?.id ?? null, input.email.trim(), displayName(input.email), provider.name, amount, 'created',
    referrer && referrer.quorum_id === q.id ? referrer.id : null, t, t, token, late ? 1 : 0, input.lang === 'es' ? 'es' : 'en',
  );
  const order = await provider.createOrder({
    amount,
    currency: config.paypal.currency,
    customId: id,
    referenceId: q.id,
    description: `Quorum group: ${product.title}`,
    requestId: `order-${id}`,
    payeeEmail: config.paypal.payeeRouting ? merchant?.paypal_email : null,
  });
  run('UPDATE commitments SET paypal_order_id = ?, updated_at = ? WHERE id = ?', order.id, nowIso(), id);
  return { commitmentId: id, token, orderId: order.id, amount, approveUrl: order.approveUrl, provider: provider.name, late };
}

/** Step 2: after the buyer approves in PayPal, authorize the order (no money moves yet). */
export async function completeAuthorization(quorumId: string, orderId: string) {
  const c = get<Commitment>('SELECT * FROM commitments WHERE paypal_order_id = ? AND quorum_id = ?', orderId, quorumId);
  if (!c) throw new CheckoutError('Commitment not found for this order', 404);
  if (c.status === 'authorized' || c.status === 'captured') return c;
  if (c.status !== 'created') throw new CheckoutError('This checkout was cancelled', 409);
  const q = getQuorum(quorumId)!;
  const product = getProduct(q.product_id)!;
  if (c.late ? !lateJoinOpen(q, product) : q.status !== 'open') throw new CheckoutError('This group closed before your authorization', 409);
  const auth = await providerFor(c.provider).authorizeOrder(orderId, `auth-${c.id}`);
  run(
    `UPDATE commitments SET status = 'authorized', authorization_id = ?, authorized_amount = ?, authorized_at = ?, updated_at = ? WHERE id = ?`,
    auth.authorizationId, auth.amount || c.authorized_amount, nowIso(), nowIso(), c.id,
  );
  if (c.intent_id) run("UPDATE intents SET status = 'committed' WHERE id = ?", c.intent_id);
  recordEvent('quorum.member_authorized', 'quorum', q.id, { commitment: c.id, amount: auth.amount, late: Boolean(c.late) });
  if (c.late) {
    await captureLateJoin(getCommitment(c.id)!, q, product);
  } else {
    const m = copy(c.lang, 'joined', { product: product.title, amount: money(auth.amount || c.authorized_amount), link: groupLink(q.id) });
    notify(c.email, 'joined', m.subject, m.body, q.id);
  }
  publish(q.id);
  return getCommitment(c.id)!;
}

/** Demo helper: add a simulated buyer (mock PayPal) to a group. */
export async function addSimulatedBuyer(quorumId: string, email: string, referrerId: string | null = null) {
  const start = await startCheckout(quorumId, { email, referrerId, provider: 'mock' });
  mockPayPal.approve(start.orderId, email);
  return completeAuthorization(quorumId, start.orderId);
}

const sameToken = (a: string | null, b: string) => {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The buyer (or the agent holding their token) can read their own commitment. */
export function commitmentForToken(commitmentId: string, token: string): Commitment {
  const c = getCommitment(commitmentId);
  if (!c || !sameToken(c.token, token)) throw new CheckoutError('Commitment not found or token is wrong', 403);
  return c;
}

/** Leave an open group: PayPal voids the authorization and the hold is released. */
export async function withdrawCommitment(commitmentId: string, token: string) {
  const c = commitmentForToken(commitmentId, token);
  const q = getQuorum(c.quorum_id)!;
  if (c.status === 'voided') return c;
  if (c.status === 'created') {
    run("UPDATE commitments SET status = 'voided', failure_reason = 'checkout cancelled', updated_at = ? WHERE id = ?", nowIso(), c.id);
    return getCommitment(c.id)!;
  }
  if (c.status !== 'authorized') throw new CheckoutError('This payment was already settled', 409);
  // Atomic claim so a withdrawal never races the settlement loop.
  const claimed = run(
    "UPDATE commitments SET status = 'voided', failure_reason = 'withdrawn by buyer', updated_at = ? WHERE id = ? AND status = 'authorized' AND (SELECT status FROM quorums WHERE id = ?) = 'open'",
    nowIso(), c.id, q.id,
  );
  if (Number(claimed.changes) !== 1) throw new CheckoutError('The group is already closing; you can no longer leave', 409);
  try {
    await providerFor(c.provider).voidAuthorization(c.authorization_id!, `void-${c.id}`);
  } catch (err) {
    // The hold could not be released right now: put the member back rather than leave money held for nothing.
    run("UPDATE commitments SET status = 'authorized', failure_reason = NULL, updated_at = ? WHERE id = ?", nowIso(), c.id);
    throw err;
  }
  if (c.intent_id) run("UPDATE intents SET status = 'grouped' WHERE id = ?", c.intent_id);
  recordEvent('quorum.member_withdrew', 'quorum', q.id, { commitment: c.id });
  const product = getProduct(q.product_id)!;
  const m = copy(c.lang, 'left', { product: product.title, amount: money(c.authorized_amount), link: groupLink(q.id) });
  notify(c.email, 'left', m.subject, m.body, q.id);
  publish(q.id);
  return getCommitment(c.id)!;
}

export type SettleOutcome = { quorumId: string; status: string; finalPrice?: number | null; captured?: number; voided?: number; failed?: number };

// Groups being settled right now in this process. A negotiation can take longer than the
// settlement loop's interval, and the loop must not start a second one for the same group.
const settling = new Set<string>();

/** Close a group: negotiate and capture if the goal was reached, otherwise void everything. */
export async function settleQuorum(quorumId: string, opts: { force?: boolean } = {}): Promise<SettleOutcome> {
  if (settling.has(quorumId)) return { quorumId, status: getQuorum(quorumId)?.status ?? 'unknown' };
  settling.add(quorumId);
  try {
    return await settleQuorumOnce(quorumId, opts);
  } finally {
    settling.delete(quorumId);
  }
}

async function settleQuorumOnce(quorumId: string, opts: { force?: boolean }): Promise<SettleOutcome> {
  const q = getQuorum(quorumId);
  if (!q) throw new CheckoutError('Group not found', 404);
  if (q.status === 'closed' || q.status === 'failed') return { quorumId, status: q.status, finalPrice: q.final_price };
  if (q.status === 'open') {
    if (!opts.force && Date.parse(q.closes_at) > Date.now()) return { quorumId, status: 'open' };
    // Atomic claim so two settle runs never process the same group.
    const claimed = run("UPDATE quorums SET status = 'negotiating' WHERE id = ? AND status = 'open'", q.id);
    if (Number(claimed.changes) !== 1) return { quorumId, status: getQuorum(q.id)!.status };
    publish(q.id);
  }

  const product = getProduct(q.product_id)!;
  const tiers = tiersOf(product);
  const members = commitmentsFor(q.id).filter((c) => c.status === 'authorized');
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
      const m = copy(c.lang, 'failed', { product: product.title, amount: money(c.authorized_amount), link: groupLink(q.id) });
      notify(c.email, 'failed', m.subject, m.body, q.id);
    }
    const summary = `Did not reach the goal (${count} of ${q.min_members}). All ${voided} authorizations were voided; nobody was charged.`;
    run("UPDATE quorums SET status = 'failed', closed_at = ?, summary = ? WHERE id = ?", nowIso(), summary, q.id);
    recordEvent('quorum.failed', 'engine', q.id, { count, voided });
    publish(q.id);
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
    // The transcript is stored turn by turn, so pages can follow the negotiation live.
    const negId = newId('neg');
    run('DELETE FROM negotiations WHERE quorum_id = ? AND status IN (?, ?)', q.id, 'briefing', 'running'); // a previous run that crashed mid-way
    run(
      'INSERT INTO negotiations (id, quorum_id, turns_json, final_price, status, engine, created_at) VALUES (?,?,?,?,?,?,?)',
      negId, q.id, '[]', null, 'running', 'pending', nowIso(),
    );
    const result = await negotiate(input, {
      openToolkit: () => openMerchantToolkit(getProduct(product.id)!),
      onPhase: (phase) => {
        run('UPDATE negotiations SET status = ? WHERE id = ?', phase, negId);
        publish(q.id);
      },
      onTurn: (turns: NegotiationTurn[]) => {
        run('UPDATE negotiations SET turns_json = ? WHERE id = ?', JSON.stringify(turns), negId);
        publish(q.id);
      },
    });
    const { lo, hi } = dealBounds(input);
    finalPrice = round2(clamp(result.finalPrice, lo, hi)); // defense in depth: limits enforced again here
    run(
      'UPDATE negotiations SET turns_json = ?, final_price = ?, status = ?, engine = ? WHERE id = ?',
      JSON.stringify(result.turns), finalPrice, 'agreed', result.engine, negId,
    );
    logAgent('negotiation', q.id, `agreed ${finalPrice}`, `Tier price ${tierPrice}, floor kept private, ${result.turns.length} turns`, result.engine);
    run("UPDATE quorums SET final_price = ?, negotiated_price = ?, status = 'settling' WHERE id = ?", finalPrice, finalPrice, q.id);
    publish(q.id);
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
        const m = copy(c.lang, 'closed', {
          product: product.title, members: String(count), amount: money(c.authorized_amount), paid: money(cap.amount), link: groupLink(q.id),
        });
        notify(c.email, 'closed', m.subject, m.body, q.id);
      } else {
        run("UPDATE commitments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", `capture ${cap.status}`, nowIso(), c.id);
        failed++;
      }
    } catch (err) {
      run("UPDATE commitments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", (err as Error).message.slice(0, 300), nowIso(), c.id);
      failed++;
    }
    publish(q.id);
  }

  run('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?', captured - already.length, product.id);
  await payReferralRewards(q.id);
  const saved = round2(product.list_price - finalPrice);
  const summary =
    `Closed with ${captured} buyers at ${money(finalPrice)} each (${money(saved)} below the ${money(product.list_price)} list price).` +
    (failed ? ` ${failed} payment${failed === 1 ? '' : 's'} could not be captured.` : '');
  const lateUntil = config.quorum.lateJoinHours > 0 ? new Date(Date.now() + config.quorum.lateJoinHours * 3600_000).toISOString() : null;
  run("UPDATE quorums SET status = 'closed', closed_at = ?, summary = ?, late_until = ? WHERE id = ?", nowIso(), summary, lateUntil, q.id);
  recordEvent('quorum.closed', 'engine', q.id, { captured, failed, finalPrice });
  publish(q.id);
  return { quorumId, status: 'closed', finalPrice, captured, failed };
}

/** A late buyer has no waiting period: authorize and capture the final price in one go. */
async function captureLateJoin(c: Commitment, q: Quorum, product: Product) {
  const provider = providerFor(c.provider);
  const amount = round2(Math.min(q.final_price!, c.authorized_amount));
  let cap;
  try {
    cap = await provider.captureAuthorization(c.authorization_id!, amount, config.paypal.currency, `cap-${c.id}`);
  } catch (err) {
    run("UPDATE commitments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", (err as Error).message.slice(0, 300), nowIso(), c.id);
    throw new CheckoutError('PayPal could not capture this payment; you were not charged', 402);
  }
  if (cap.status !== 'COMPLETED' && cap.status !== 'PENDING') {
    run("UPDATE commitments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", `capture ${cap.status}`, nowIso(), c.id);
    throw new CheckoutError('PayPal declined this payment; you were not charged', 402);
  }
  run("UPDATE commitments SET status = 'captured', captured_amount = ?, capture_id = ?, updated_at = ? WHERE id = ?", cap.amount, cap.captureId, nowIso(), c.id);
  run('UPDATE products SET stock = MAX(0, stock - 1) WHERE id = ?', product.id);
  recordEvent('quorum.late_join', 'engine', q.id, { commitment: c.id, amount: cap.amount });
  const paid = commitmentsFor(q.id).filter((x) => x.status === 'captured').length;
  const m = copy(c.lang, 'closed', { product: product.title, members: String(paid), amount: money(c.authorized_amount), paid: money(cap.amount), link: groupLink(q.id) });
  notify(c.email, 'closed', m.subject, m.body, q.id);
  await applyPriceDrop(q.id);
}

/**
 * Price-drop guarantee. When late buyers push a closed group into a cheaper
 * public tier, everyone already charged gets the difference back through
 * PayPal's refund API. The new price never goes below the merchant's floor.
 */
export async function applyPriceDrop(quorumId: string): Promise<{ price: number; refunds: number; total: number } | null> {
  const q = getQuorum(quorumId);
  if (!q || q.status !== 'closed' || q.final_price === null) return null;
  const product = getProduct(q.product_id)!;
  const paid = commitmentsFor(q.id).filter((c) => c.status === 'captured' && c.capture_id);
  const target = round2(Math.max(product.floor_price, priceFor(tiersOf(product), paid.length)));
  if (target >= q.final_price) return null;
  let refunds = 0;
  let total = 0;
  for (const c of paid) {
    const due = round2((c.captured_amount ?? 0) - c.refunded_amount - target);
    if (due < 0.01) continue;
    try {
      // The request id includes the target price, so a retry of the same drop never refunds twice.
      await providerFor(c.provider).refundCapture(c.capture_id!, due, config.paypal.currency, `refund-${c.id}-${Math.round(target * 100)}`);
      run('UPDATE commitments SET refunded_amount = refunded_amount + ?, updated_at = ? WHERE id = ?', due, nowIso(), c.id);
      refunds++;
      total = round2(total + due);
      const m = copy(c.lang, 'refund', { product: product.title, refund: money(due), paid: money(target), link: groupLink(q.id) });
      notify(c.email, 'refund', m.subject, m.body, q.id);
    } catch (err) {
      recordEvent('refund.failed', 'engine', c.id, { error: (err as Error).message, due });
    }
  }
  const summary =
    `Closed with ${paid.length} buyers at ${money(target)} each (${money(round2(product.list_price - target))} below the ${money(product.list_price)} list price). ` +
    `Late buyers unlocked the ${paid.length}-buyer price, so ${refunds} earlier ${refunds === 1 ? 'buyer was' : 'buyers were'} refunded the difference.`;
  run('UPDATE quorums SET final_price = ?, summary = ? WHERE id = ?', target, summary, q.id);
  recordEvent('quorum.price_drop', 'engine', q.id, { from: q.final_price, to: target, refunds, total });
  logAgent('settlement', q.id, `price dropped to ${target}`, `${paid.length} buyers reached a cheaper public tier; ${refunds} refunds totalling ${money(total)} sent through PayPal`, 'rule');
  publish(q.id);
  return { price: target, refunds, total };
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
