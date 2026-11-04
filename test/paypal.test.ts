// PayPal: simulated ledger rules, and the exact REST requests the real client sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
process.env.PAYPAL_MODE = 'sandbox';
process.env.PAYPAL_CLIENT_ID = 'test-client';
process.env.PAYPAL_CLIENT_SECRET = 'test-secret';

const { openDb } = await import('../src/db.ts');
const { MockPayPal } = await import('../src/paypal/mock.ts');
const { RestPayPal } = await import('../src/paypal/rest.ts');
openDb(':memory:');

test('mock PayPal follows authorization rules', async () => {
  const pp = new MockPayPal();
  const order = await pp.createOrder({ amount: 199, requestId: 'r1', referenceId: 'q1' } as any);
  await assert.rejects(pp.authorizeOrder(order.id, 'a1'), /not approved/);
  pp.approve(order.id, 'buyer@example.com');
  const auth = await pp.authorizeOrder(order.id, 'a1');
  assert.equal(auth.amount, 199);
  await assert.rejects(pp.captureAuthorization(auth.authorizationId, 200, 'USD', 'c0'), /exceeds/);
  const cap = await pp.captureAuthorization(auth.authorizationId, 169, 'USD', 'c1');
  assert.equal(cap.status, 'COMPLETED');
  assert.equal(cap.amount, 169);
  // Same request id → same result (idempotent), new id → refused (already captured).
  assert.deepEqual(await pp.captureAuthorization(auth.authorizationId, 169, 'USD', 'c1'), cap);
  await assert.rejects(pp.captureAuthorization(auth.authorizationId, 169, 'USD', 'c2'), /CAPTURED/);
  await assert.rejects(pp.voidAuthorization(auth.authorizationId, 'v1'), /CAPTURED/);
});

test('mock PayPal: +decline emails fail at capture', async () => {
  const pp = new MockPayPal();
  const order = await pp.createOrder({ amount: 50, requestId: 'r2', referenceId: 'q1' } as any);
  pp.approve(order.id, 'x+decline@example.com');
  const auth = await pp.authorizeOrder(order.id, 'a2');
  const cap = await pp.captureAuthorization(auth.authorizationId, 40, 'USD', 'c3');
  assert.equal(cap.status, 'DECLINED');
});

test('REST client sends AUTHORIZE orders, partial final captures and idempotency keys', async () => {
  const calls: { url: string; init: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, init });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'tok', expires_in: 3600 });
    if (url.endsWith('/v2/checkout/orders')) return json({ id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }] });
    if (url.endsWith('/authorize')) return json({ id: 'ORDER1', status: 'COMPLETED', payer: { email_address: 'b@x.com' }, purchase_units: [{ payments: { authorizations: [{ id: 'AUTH1', status: 'CREATED', amount: { value: '199.00' } }] } }] });
    if (url.endsWith('/capture')) return json({ id: 'CAP1', status: 'COMPLETED', amount: { value: '169.00' } });
    if (url.endsWith('/void')) return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  try {
    const pp = new RestPayPal();
    const order = await pp.createOrder({ amount: 199, currency: 'USD', customId: 'cmt_1', referenceId: 'q_1', description: 'Quorum group', requestId: 'order-cmt_1' });
    assert.equal(order.approveUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1');
    const create = calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
    assert.ok(create.url.startsWith('https://api-m.sandbox.paypal.com'));
    const body = JSON.parse(create.init.body);
    assert.equal(body.intent, 'AUTHORIZE');
    assert.equal(body.purchase_units[0].amount.value, '199.00');
    assert.equal(body.purchase_units[0].custom_id, 'cmt_1');
    assert.equal(create.init.headers['PayPal-Request-Id'], 'order-cmt_1');

    const auth = await pp.authorizeOrder('ORDER1', 'auth-cmt_1');
    assert.deepEqual([auth.authorizationId, auth.amount], ['AUTH1', 199]);

    const cap = await pp.captureAuthorization('AUTH1', 169, 'USD', 'cap-cmt_1');
    assert.equal(cap.amount, 169);
    const capCall = calls.find((c) => c.url.endsWith('/v2/payments/authorizations/AUTH1/capture'))!;
    const capBody = JSON.parse(capCall.init.body);
    assert.equal(capBody.amount.value, '169.00');
    assert.equal(capBody.final_capture, true);
    assert.equal(capCall.init.headers['PayPal-Request-Id'], 'cap-cmt_1');

    await pp.voidAuthorization('AUTH1', 'void-cmt_1');
    assert.ok(calls.some((c) => c.url.endsWith('/v2/payments/authorizations/AUTH1/void')));
    // One OAuth call, token reused.
    assert.equal(calls.filter((c) => c.url.endsWith('/oauth2/token')).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
