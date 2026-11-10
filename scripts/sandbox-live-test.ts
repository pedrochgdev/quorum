// Proves the money rules Quorum depends on against the REAL PayPal sandbox,
// with no manual step: a real Chrome pays as a guest with a sandbox test card.
//
//   npm run sandbox:live-test
//
//   Order 1: authorize $200 → capture $170 (final_capture) → refund $5
//   Order 2: authorize $200 → void
//
// It uses the same REST client as the app. PayPal's checkout page is not ours,
// so if its form changes this script may need new selectors; in that case use
// `npm run sandbox:capture-test` and approve the printed link by hand.
import { config } from '../src/config.ts';
import { paypalBaseUrl, paypalFetch, RestPayPal } from '../src/paypal/rest.ts';
import { PayPalError } from '../src/paypal/types.ts';
import { Browser, findChrome } from './lib/cdp.ts';
import { payAsGuest } from './lib/paypal-guest.ts';

if (!config.paypal.clientId || !config.paypal.clientSecret || config.paypal.mode === 'live') {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for a SANDBOX app (PAYPAL_MODE must not be live).');
  process.exit(1);
}
if (!findChrome()) {
  console.error('Chrome or Chromium not found (set CHROME_PATH). Use `npm run sandbox:capture-test` instead.');
  process.exit(1);
}

const run = Date.now().toString(36);
const paypal = new RestPayPal();
console.log(`PayPal ${paypalBaseUrl()} — real sandbox, guest card checkout in Chrome\n`);

let failures = 0;
function check(cond: unknown, label: string, extra?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
  }
}

async function newOrder(tag: string) {
  const order = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    requestId: `live-${tag}-${run}`,
    body: {
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: `quorum-live-${tag}`, description: 'Quorum group (sandbox live test)', amount: { currency_code: 'USD', value: '200.00' } }],
      payment_source: { paypal: { experience_context: { brand_name: 'Quorum', user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING', return_url: 'https://example.com/approved', cancel_url: 'https://example.com/cancelled' } } },
    },
  });
  const link = (order.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href as string;
  return { id: order.id as string, link };
}

const browser = await Browser.launch({ headless: !process.env.HEADFUL, height: 1400 });
try {
  console.log('Order 1: authorize $200, capture $170, refund $5');
  const a = await newOrder('capture');
  await payAsGuest(browser, a.link, { tag: 'capture', returnPrefix: 'https://example.com/', cancelMarker: 'cancelled' });
  check((await paypalFetch(`/v2/checkout/orders/${a.id}`)).status === 'APPROVED', `buyer approved order ${a.id} in PayPal's checkout`);
  const auth = await paypal.authorizeOrder(a.id, `live-auth-${run}`);
  check(auth.status === 'CREATED' && auth.amount === 200, `authorized $200: ${auth.authorizationId} is ${auth.status}, nothing charged`, auth);
  const before = await paypal.getAuthorization(auth.authorizationId);
  check(before.status === 'CREATED', 'authorization is open before settlement');
  const cap = await paypal.captureAuthorization(auth.authorizationId, 170, 'USD', `live-cap-${run}`);
  check((cap.status === 'COMPLETED' || cap.status === 'PENDING') && cap.amount === 170, `captured $170 of the $200 authorized: ${cap.captureId} is ${cap.status}`, cap);
  const again = await paypal.captureAuthorization(auth.authorizationId, 170, 'USD', `live-cap-${run}`);
  check(again.captureId === cap.captureId, 'repeating the capture with the same PayPal-Request-Id returns the same capture (no double charge)', again);
  const after = await paypal.getAuthorization(auth.authorizationId);
  check(after.status === 'CAPTURED', `authorization is now ${after.status}: the other $30 was released`);
  if (cap.status === 'COMPLETED') {
    const refund = await paypal.refundCapture(cap.captureId, 5, 'USD', `live-refund-${run}`);
    check(refund.status === 'COMPLETED' || refund.status === 'PENDING', `refunded $5 (price-drop rule): ${refund.refundId} is ${refund.status}`, refund);
  } else {
    console.log('  – capture is PENDING on this account, so the refund step was skipped');
  }

  console.log('\nOrder 2: authorize $200, then void (the group did not form)');
  const b = await newOrder('void');
  await payAsGuest(browser, b.link, { tag: 'void', returnPrefix: 'https://example.com/', cancelMarker: 'cancelled' });
  const auth2 = await paypal.authorizeOrder(b.id, `live-auth2-${run}`);
  check(auth2.status === 'CREATED', `authorized $200: ${auth2.authorizationId}`);
  await paypal.voidAuthorization(auth2.authorizationId, `live-void-${run}`);
  const voided = await paypal.getAuthorization(auth2.authorizationId);
  check(voided.status === 'VOIDED', `authorization is ${voided.status}: the buyer was never charged`);
  await paypal.captureAuthorization(auth2.authorizationId, 170, 'USD', `live-cap2-${run}`).then(
    () => check(false, 'a voided authorization cannot be captured'),
    (err: PayPalError) => check(true, `a voided authorization cannot be captured (${err.issue ?? err.message})`),
  );
} catch (err) {
  failures++;
  const e = err as PayPalError;
  console.error(`\n${e.message}`, e.details ? JSON.stringify(e.details).slice(0, 500) : '');
} finally {
  await browser.close();
}

console.log(failures ? `\nFAIL: ${failures} problem(s). See above.` : "\nPASS: PayPal sandbox authorized, partially captured, refunded and voided as Quorum's settlement needs.");
process.exit(failures ? 1 : 0);
