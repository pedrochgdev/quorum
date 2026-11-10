// Registers Quorum's webhook on your PayPal app and prints the id to put in
// PAYPAL_WEBHOOK_ID. Run it once after deploying:
//
//   npm run paypal:webhook -- https://your-app.onrender.com
//
// PayPal only accepts public https URLs. Running it again for the same URL
// reuses the existing webhook.
import { config } from '../src/config.ts';
import { paypalBaseUrl, paypalFetch } from '../src/paypal/rest.ts';
import { PayPalError } from '../src/paypal/types.ts';

const EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
];

const base = (process.argv[2] ?? process.env.BASE_URL ?? '').replace(/\/+$/, '');
if (!/^https:\/\/[^/]+\.[^/]+/.test(base)) {
  console.error('Usage: npm run paypal:webhook -- https://your-public-url\n(PayPal needs a public https URL; localhost does not work.)');
  process.exit(1);
}
if (!config.paypal.clientId || !config.paypal.clientSecret) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first.');
  process.exit(1);
}
const url = `${base}/api/webhooks/paypal`;
console.log(`PayPal ${paypalBaseUrl()}\nWebhook URL: ${url}\n`);

try {
  const existing = await paypalFetch<{ webhooks?: { id: string; url: string }[] }>('/v1/notifications/webhooks');
  const found = (existing.webhooks ?? []).find((w) => w.url === url);
  const id = found
    ? found.id
    : (await paypalFetch<{ id: string }>('/v1/notifications/webhooks', { method: 'POST', body: { url, event_types: EVENTS.map((name) => ({ name })) } })).id;
  console.log(`${found ? 'Already registered' : 'Registered'}. Add this to your environment and restart:\n\n  PAYPAL_WEBHOOK_ID=${id}\n`);
} catch (err) {
  const e = err as PayPalError;
  console.error(`PayPal refused: ${e.issue ?? e.message}`, JSON.stringify(e.details ?? '').slice(0, 400));
  process.exit(1);
}
