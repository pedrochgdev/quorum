// Checks what your PayPal sandbox app can do, without a browser:
//
//   npm run paypal:check
//
// It verifies credentials, creates an AUTHORIZE order (never approved, so it
// simply expires), and probes the features Quorum uses. The one step that
// needs a person, approving a payment, is covered by
// `npm run sandbox:capture-test`.
import { config } from '../src/config.ts';
import { connectPayPalMcp, paypalMcpUrl } from '../src/paypal/mcp-client.ts';
import { paypalBaseUrl, paypalFetch } from '../src/paypal/rest.ts';
import { PayPalError } from '../src/paypal/types.ts';

if (!config.paypal.clientId || !config.paypal.clientSecret) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (see .env.example).');
  process.exit(1);
}
console.log(`PayPal ${paypalBaseUrl()}\n`);

let required = 0;
async function probe(label: string, need: boolean, fn: () => Promise<string>, hint = '') {
  try {
    console.log(`  ✓ ${label}: ${await fn()}`);
  } catch (err) {
    const e = err as PayPalError;
    console.log(`  ${need ? '✗' : '–'} ${label}: ${e.issue ?? e.message}${hint ? `\n      ${hint}` : ''}`);
    if (need) required++;
  }
}

await probe('Credentials (OAuth)', true, async () => {
  await paypalFetch('/v1/identity/oauth2/userinfo?schema=paypalv1.1');
  return 'accepted';
});

await probe('Orders API, intent AUTHORIZE', true, async () => {
  const order = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    requestId: `check-${Date.now().toString(36)}`,
    body: {
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: 'quorum-check', amount: { currency_code: config.paypal.currency, value: '10.00' } }],
      payment_source: { paypal: { experience_context: { user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING', return_url: 'https://example.com/ok', cancel_url: 'https://example.com/cancel' } } },
    },
  });
  const seen = await paypalFetch(`/v2/checkout/orders/${order.id}`);
  return `order ${order.id} is ${seen.status} (not approved, it expires on its own)`;
});

await probe('Catalog Products API', false, async () => {
  const r = await paypalFetch('/v1/catalogs/products?page_size=1&total_required=true');
  return `${r.total_items ?? 0} products`;
});

await probe('Webhooks API', false, async () => {
  const r = await paypalFetch<{ webhooks?: { url: string }[] }>('/v1/notifications/webhooks');
  const n = r.webhooks?.length ?? 0;
  return n ? `${n} registered (${r.webhooks![0].url})` : 'none registered yet: run `npm run paypal:webhook -- https://your-app` after deploying';
});

await probe(
  'Transaction Search API',
  false,
  async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86400_000);
    const q = new URLSearchParams({ start_date: start.toISOString().replace(/\.\d+Z$/, '-0000'), end_date: end.toISOString().replace(/\.\d+Z$/, '-0000'), fields: 'transaction_info', page_size: '1' });
    const r = await paypalFetch<{ total_items?: number }>(`/v1/reporting/transactions?${q}`);
    return `${r.total_items ?? 0} transactions in the last 7 days`;
  },
  'Optional. Enable "Transaction search" in the app\'s Features so the merchant agent can read sales volume.',
);

await probe(
  `PayPal MCP server (${paypalMcpUrl()})`,
  false,
  async () => {
    const mcp = await connectPayPalMcp();
    try {
      const tools = await mcp.listTools();
      const used = ['list_products', 'show_product_details', 'list_transactions', 'list_disputes', 'get_order', 'create_product'];
      return `${tools.length} tools; Quorum uses ${used.filter((n) => tools.some((t) => t.name === n)).join(', ')}`;
    } finally {
      mcp.close();
    }
  },
  'Optional. Without it the merchant agent calls the REST API directly (set PAYPAL_MCP=off to skip the attempt).',
);

console.log(
  required
    ? `\n${required} required check(s) failed.`
    : '\nRequired checks passed. Next: `npm run sandbox:capture-test` and approve the printed link with a sandbox PERSONAL account.',
);
process.exit(required ? 1 : 0);
