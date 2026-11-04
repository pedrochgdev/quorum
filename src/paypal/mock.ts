// Simulated PayPal with the same contract as the REST client.
// Used when no sandbox credentials are configured, and for seeded demo buyers.
// Rules mirror PayPal: capture ≤ authorized amount, one final capture, void only open auths.
// A payer email containing "+decline" makes the capture fail, to test the failure path.
import { get, run } from '../db.ts';
import { newId, nowIso, round2 } from '../util.ts';
import { PayPalError, type PayPalProvider, type PayoutItem } from './types.ts';
import { recordEvent } from '../events.ts';

type MockRow = { id: string; kind: string; parent_id: string | null; amount: number; status: string; payer_email: string | null };

const row = (id: string) => get<MockRow>('SELECT * FROM mock_paypal WHERE id = ?', id);

function insert(kind: string, id: string, parent: string | null, amount: number, status: string, payer: string | null) {
  const t = nowIso();
  run(
    'INSERT INTO mock_paypal (id, kind, parent_id, amount, status, payer_email, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    id, kind, parent, amount, status, payer, t, t,
  );
}
const setStatus = (id: string, status: string) =>
  run('UPDATE mock_paypal SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);

// Idempotency store for the mock, keyed by request id.
const seen = new Map<string, unknown>();
function once<T>(requestId: string, fn: () => T): T {
  if (seen.has(requestId)) return seen.get(requestId) as T;
  const out = fn();
  seen.set(requestId, out);
  return out;
}

export class MockPayPal implements PayPalProvider {
  readonly name = 'mock' as const;

  async createOrder(input: { amount: number; requestId: string; referenceId: string }) {
    return once(`order:${input.requestId}`, () => {
      const id = newId('MOCKORDER').toUpperCase();
      insert('order', id, input.referenceId, round2(input.amount), 'CREATED', null);
      return { id, status: 'CREATED', approveUrl: `/mock-paypal/checkout?order=${id}` };
    });
  }

  /** Called by the simulated checkout page (stands in for the buyer approving in PayPal). */
  approve(orderId: string, payerEmail: string) {
    const o = row(orderId);
    if (!o || o.kind !== 'order') throw new PayPalError('Order not found', 404, { name: 'RESOURCE_NOT_FOUND' });
    if (o.status !== 'CREATED') return;
    run('UPDATE mock_paypal SET status = ?, payer_email = ?, updated_at = ? WHERE id = ?', 'APPROVED', payerEmail, nowIso(), orderId);
    recordEvent('CHECKOUT.ORDER.APPROVED', 'mock', orderId, { id: orderId });
  }

  async authorizeOrder(orderId: string, requestId: string) {
    return once(`auth:${requestId}`, () => {
      const o = row(orderId);
      if (!o || o.kind !== 'order') throw new PayPalError('Order not found', 404, { name: 'RESOURCE_NOT_FOUND' });
      if (o.status !== 'APPROVED') throw new PayPalError('Order not approved by payer', 422, { details: [{ issue: 'ORDER_NOT_APPROVED' }] });
      const authId = newId('MOCKAUTH').toUpperCase();
      insert('authorization', authId, orderId, o.amount, 'CREATED', o.payer_email);
      setStatus(orderId, 'COMPLETED');
      recordEvent('PAYMENT.AUTHORIZATION.CREATED', 'mock', authId, { id: authId, amount: o.amount });
      return { authorizationId: authId, status: 'CREATED', amount: o.amount, payerEmail: o.payer_email ?? undefined };
    });
  }

  async getAuthorization(authorizationId: string) {
    const a = row(authorizationId);
    if (!a) throw new PayPalError('Authorization not found', 404, { name: 'RESOURCE_NOT_FOUND' });
    return { authorizationId: a.id, status: a.status, amount: a.amount };
  }

  async captureAuthorization(authorizationId: string, amount: number, _currency: string, requestId: string) {
    return once(`capture:${requestId}`, () => {
      const a = row(authorizationId);
      if (!a) throw new PayPalError('Authorization not found', 404, { name: 'RESOURCE_NOT_FOUND' });
      if (a.status !== 'CREATED') throw new PayPalError(`Authorization is ${a.status}`, 422, { details: [{ issue: 'AUTHORIZATION_ALREADY_CAPTURED' }] });
      if (round2(amount) > a.amount) throw new PayPalError('Capture exceeds authorized amount', 422, { details: [{ issue: 'MAX_CAPTURE_AMOUNT_EXCEEDED' }] });
      const capId = newId('MOCKCAP').toUpperCase();
      if (a.payer_email?.includes('+decline')) {
        insert('capture', capId, authorizationId, round2(amount), 'DECLINED', a.payer_email);
        setStatus(authorizationId, 'DENIED');
        recordEvent('PAYMENT.CAPTURE.DENIED', 'mock', capId, { id: capId, authorization: authorizationId });
        return { captureId: capId, status: 'DECLINED', amount: round2(amount) };
      }
      insert('capture', capId, authorizationId, round2(amount), 'COMPLETED', a.payer_email);
      setStatus(authorizationId, 'CAPTURED');
      recordEvent('PAYMENT.CAPTURE.COMPLETED', 'mock', capId, { id: capId, authorization: authorizationId, amount: round2(amount) });
      return { captureId: capId, status: 'COMPLETED', amount: round2(amount) };
    });
  }

  async voidAuthorization(authorizationId: string, requestId: string) {
    return once(`void:${requestId}`, () => {
      const a = row(authorizationId);
      if (!a) throw new PayPalError('Authorization not found', 404, { name: 'RESOURCE_NOT_FOUND' });
      if (a.status !== 'CREATED') throw new PayPalError(`Authorization is ${a.status}`, 422, { details: [{ issue: 'PREVIOUSLY_VOIDED' }] });
      setStatus(authorizationId, 'VOIDED');
      recordEvent('PAYMENT.AUTHORIZATION.VOIDED', 'mock', authorizationId, { id: authorizationId });
      return { status: 'VOIDED' };
    });
  }

  async reauthorize(authorizationId: string, amount: number, _currency: string, requestId: string) {
    return once(`reauth:${requestId}`, () => {
      const a = row(authorizationId);
      if (!a || a.status !== 'CREATED') throw new PayPalError('Authorization not reauthorizable', 422, {});
      const id = newId('MOCKAUTH').toUpperCase();
      insert('authorization', id, a.parent_id, round2(amount), 'CREATED', a.payer_email);
      setStatus(authorizationId, 'VOIDED');
      return { authorizationId: id, status: 'CREATED', amount: round2(amount) };
    });
  }

  async refundCapture(captureId: string, amount: number, _currency: string, requestId: string) {
    return once(`refund:${requestId}`, () => {
      const id = newId('MOCKREF').toUpperCase();
      insert('refund', id, captureId, round2(amount), 'COMPLETED', null);
      return { refundId: id, status: 'COMPLETED' };
    });
  }

  async createPayout(items: PayoutItem[], _currency: string, requestId: string) {
    return once(`payout:${requestId}`, () => {
      const id = newId('MOCKPAYOUT').toUpperCase();
      for (const i of items) insert('payout_item', newId('MOCKPI').toUpperCase(), id, i.amount, 'SUCCESS', i.email);
      return { batchId: id, status: 'SUCCESS' };
    });
  }
}
