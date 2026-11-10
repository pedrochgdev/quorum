// Checks that a DEPLOYED Quorum receives and verifies real PayPal webhooks.
//
//   npm run paypal:webhook-test -- https://your-app.onrender.com
//
// It makes one real sandbox payment from this machine (authorize, then void),
// then asks the deployed app which PayPal events it received. An event only
// appears there after the app verified its signature with PayPal, so seeing
// it proves the webhook URL, PAYPAL_WEBHOOK_ID and verification all work.
//
// Needs the same sandbox PayPal keys as the deployment, Chrome, and either
// DEMO_ADMIN=true on the deployment or its CRON_SECRET in your environment.
import { config } from '../src/config.ts';
import { paypalFetch, RestPayPal } from '../src/paypal/rest.ts';
import { Browser, findChrome, sleep } from './lib/cdp.ts';
import { payAsGuest } from './lib/paypal-guest.ts';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+/.test(base)) {
  console.error('Usage: npm run paypal:webhook-test -- https://your-app.onrender.com');
  process.exit(1);
}
if (!config.paypal.clientId || !config.paypal.clientSecret || config.paypal.mode === 'live') {
  console.error('Set the SANDBOX PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET that the deployment uses.');
  process.exit(1);
}
if (!findChrome()) {
  console.error('Chrome or Chromium not found (set CHROME_PATH).');
  process.exit(1);
}

type AppEvent = { type: string; source: string; ref_id: string | null; created_at: string };
async function appEvents(): Promise<AppEvent[]> {
  const res = await fetch(`${base}/api/events`, { headers: config.cronSecret ? { Authorization: `Bearer ${config.cronSecret}` } : undefined });
  if (res.status === 403) throw new Error('The deployment refused /api/events: set DEMO_ADMIN=true there, or export its CRON_SECRET here.');
  if (!res.ok) throw new Error(`${base}/api/events answered ${res.status}`);
  return ((await res.json()) as { events: AppEvent[] }).events;
}

const hooks = await paypalFetch<{ webhooks?: { id: string; url: string }[] }>('/v1/notifications/webhooks');
const hook = (hooks.webhooks ?? []).find((w) => w.url === `${base}/api/webhooks/paypal`);
if (!hook) {
  console.error(`No webhook is registered for ${base}/api/webhooks/paypal.\nRun: npm run paypal:webhook -- ${base}`);
  process.exit(1);
}
console.log(`Webhook ${hook.id} is registered for ${hook.url}`);
await appEvents(); // fail early if the deployment cannot be read

const run = Date.now().toString(36);
const paypal = new RestPayPal();
const order = await paypalFetch('/v2/checkout/orders', {
  method: 'POST',
  requestId: `hook-${run}`,
  body: {
    intent: 'AUTHORIZE',
    purchase_units: [{ reference_id: 'quorum-webhook-test', amount: { currency_code: 'USD', value: '25.00' } }],
    payment_source: { paypal: { experience_context: { user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING', return_url: 'https://example.com/approved', cancel_url: 'https://example.com/cancelled' } } },
  },
});
const link = (order.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href as string;
const browser = await Browser.launch({ headless: !process.env.HEADFUL, height: 1400 });
let authorizationId = '';
try {
  await payAsGuest(browser, link, { tag: 'hook', returnPrefix: 'https://example.com/', cancelMarker: 'cancelled' });
  authorizationId = (await paypal.authorizeOrder(order.id, `hook-auth-${run}`)).authorizationId;
  await paypal.voidAuthorization(authorizationId, `hook-void-${run}`);
  console.log(`Made a real sandbox payment: authorization ${authorizationId} created, then voided.`);
} finally {
  await browser.close();
}

console.log('Waiting for PayPal to deliver the events (up to 3 minutes)…');
const wanted = ['PAYMENT.AUTHORIZATION.CREATED', 'PAYMENT.AUTHORIZATION.VOIDED'];
const seen = new Set<string>();
let rejected = 0;
for (let i = 0; i < 36 && seen.size < wanted.length; i++) {
  await sleep(5000);
  const events = await appEvents();
  for (const e of events) if (e.source === 'paypal' && e.ref_id === authorizationId && wanted.includes(e.type)) seen.add(e.type);
  rejected = events.filter((e) => e.type === 'webhook.rejected' && Date.parse(e.created_at) > Date.now() - 300_000).length;
}
for (const w of wanted) console.log(`  ${seen.has(w) ? '✓' : '✗'} ${w} received and its signature verified`);
if (seen.size < wanted.length) {
  console.log(
    rejected
      ? `\nThe deployment received webhooks but rejected ${rejected} of them: PAYPAL_WEBHOOK_ID there is probably not ${hook.id}.`
      : '\nNo event arrived. Check that the deployment is running, reachable at that URL, and has PAYPAL_WEBHOOK_ID set.',
  );
  process.exit(1);
}
console.log('\nPASS: the deployment receives real PayPal webhooks and verifies them.');
