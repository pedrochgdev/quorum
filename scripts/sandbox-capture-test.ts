// The critical PayPal sandbox check Quorum depends on:
// authorize $200, then capture only $170 with final_capture=true.
//
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run sandbox:capture-test
//
// It first tries a sandbox test card (no browser needed). If card processing is
// not enabled on your sandbox app, it falls back to a PayPal-wallet order and
// prints a link: approve it with a sandbox *personal* account and the script
// continues on its own.
import { config } from '../src/config.ts';
import { paypalBaseUrl, paypalFetch } from '../src/paypal/rest.ts';
import { PayPalError } from '../src/paypal/types.ts';

if (!config.paypal.clientId || !config.paypal.clientSecret || config.paypal.mode === 'live') {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for a SANDBOX app (PAYPAL_MODE must not be live).');
  process.exit(1);
}

const AUTH_AMOUNT = process.env.AUTH_AMOUNT ?? '200.00';
const CAPTURE_AMOUNT = process.env.CAPTURE_AMOUNT ?? '170.00';
const run = Date.now().toString(36);
console.log(`PayPal ${paypalBaseUrl()} — authorize ${AUTH_AMOUNT}, capture ${CAPTURE_AMOUNT}\n`);

async function viaCard(): Promise<string> {
  const order = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    requestId: `qt-card-${run}`,
    prefer: 'return=representation',
    body: {
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: 'quorum-test', amount: { currency_code: 'USD', value: AUTH_AMOUNT } }],
      payment_source: {
        card: {
          number: process.env.SANDBOX_CARD_NUMBER ?? '4111111111111111',
          expiry: process.env.SANDBOX_CARD_EXPIRY ?? '2030-12',
          security_code: process.env.SANDBOX_CARD_CVV ?? '123',
          name: 'Quorum Test',
        },
      },
    },
  });
  const auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new Error(`No authorization in card order (status ${order.status})`);
  return auth.id;
}

async function viaWallet(): Promise<string> {
  const order = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    requestId: `qt-wallet-${run}`,
    body: {
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: 'quorum-test', amount: { currency_code: 'USD', value: AUTH_AMOUNT } }],
      payment_source: { paypal: { experience_context: { user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING', return_url: 'https://example.com/approved', cancel_url: 'https://example.com/cancelled' } } },
    },
  });
  const link = (order.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  console.log(`Open this link and approve with a sandbox PERSONAL account:\n\n  ${link}\n\nWaiting for approval (up to 5 minutes)…`);
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const o = await paypalFetch(`/v2/checkout/orders/${order.id}`);
    if (o.status === 'APPROVED') break;
    if (i === 99) throw new Error('Timed out waiting for approval');
  }
  const authorized = await paypalFetch(`/v2/checkout/orders/${order.id}/authorize`, { method: 'POST', requestId: `qt-auth-${run}`, prefer: 'return=representation', body: {} });
  return authorized.purchase_units[0].payments.authorizations[0].id;
}

let authorizationId: string;
try {
  authorizationId = await viaCard();
  console.log('1. Authorized with a sandbox test card.');
} catch (err) {
  // Only fall back when PayPal itself refused the card order; network or credential problems stop here.
  if (!(err instanceof PayPalError) || err.message.includes('OAuth')) {
    console.error(`Could not reach PayPal sandbox: ${(err as Error).message}. Check your network and credentials.`);
    process.exit(1);
  }
  console.log(`Card authorization not available (${err.issue ?? err.message}). Using the PayPal wallet flow.`);
  authorizationId = await viaWallet();
  console.log('1. Authorized with a PayPal sandbox account.');
}

const auth = await paypalFetch(`/v2/payments/authorizations/${authorizationId}`);
console.log(`   authorization ${auth.id}: ${auth.status}, ${auth.amount.value} ${auth.amount.currency_code}, expires ${auth.expiration_time ?? 'n/a'}`);

const capture = await paypalFetch(`/v2/payments/authorizations/${authorizationId}/capture`, {
  method: 'POST',
  requestId: `qt-cap-${run}`,
  prefer: 'return=representation',
  body: { amount: { currency_code: 'USD', value: CAPTURE_AMOUNT }, final_capture: true },
});
console.log(`2. Captured ${capture.amount?.value ?? CAPTURE_AMOUNT}: capture ${capture.id} is ${capture.status}.`);

const after = await paypalFetch(`/v2/payments/authorizations/${authorizationId}`);
console.log(`3. Authorization is now ${after.status}.`);

const ok = (capture.status === 'COMPLETED' || capture.status === 'PENDING') && Number(capture.amount?.value ?? CAPTURE_AMOUNT) < Number(AUTH_AMOUNT);
console.log(ok ? `\nPASS: PayPal captured less than it authorized. Quorum's settlement model works on this account.` : '\nFAIL: see the statuses above.');
process.exit(ok ? 0 : 1);
