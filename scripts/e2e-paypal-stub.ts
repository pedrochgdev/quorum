// Runs the full cycle through the REAL PayPal REST client (PAYPAL_MODE=sandbox)
// against a local stub of PayPal's API, to check every request Quorum sends and
// every response it parses, plus signed-webhook handling. No network needed.
//
//   node --disable-warning=ExperimentalWarning scripts/e2e-paypal-stub.ts
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- PayPal stub ------------------------------------------------------------------
type Rec = { id: string; status: string; amount: number; approved?: boolean; auth?: string };
const orders = new Map<string, Rec>();
const auths = new Map<string, Rec>();
const log: { method: string; path: string; body: any; requestId?: string }[] = [];
let n = 0;
const nid = (p: string) => `${p}${(++n).toString().padStart(6, '0')}`;

const stub = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw;
  const path = req.url!.split('?')[0];
  log.push({ method: req.method!, path, body, requestId: req.headers['paypal-request-id'] as string });
  const send = (status: number, obj?: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(obj === undefined ? '' : JSON.stringify(obj));
  };
  const m = (re: RegExp) => path.match(re);
  let x: RegExpMatchArray | null;
  if (path === '/v1/oauth2/token') return send(200, { access_token: 'stub-token', expires_in: 3600 });
  if (req.headers.authorization !== 'Bearer stub-token') return send(401, { name: 'AUTHENTICATION_FAILURE' });
  if (path === '/v2/checkout/orders' && req.method === 'POST') {
    const id = nid('ORD');
    orders.set(id, { id, status: 'PAYER_ACTION_REQUIRED', amount: Number(body.purchase_units[0].amount.value) });
    return send(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://sandbox.example/checkoutnow?token=${id}` }] });
  }
  if ((x = m(/^\/stub\/approve\/(\w+)$/))) {
    const o = orders.get(x[1])!;
    o.status = 'APPROVED';
    return send(200, {});
  }
  if ((x = m(/^\/v2\/checkout\/orders\/(\w+)\/authorize$/))) {
    const o = orders.get(x[1]);
    if (!o || o.status !== 'APPROVED') return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
    const a = { id: nid('AUTH'), status: 'CREATED', amount: o.amount };
    auths.set(a.id, a);
    o.status = 'COMPLETED';
    return send(201, { id: o.id, status: 'COMPLETED', payer: { email_address: 'buyer@personal.example' }, purchase_units: [{ payments: { authorizations: [{ id: a.id, status: 'CREATED', amount: { currency_code: 'USD', value: a.amount.toFixed(2) } }] } }] });
  }
  if ((x = m(/^\/v2\/payments\/authorizations\/(\w+)$/))) {
    const a = auths.get(x[1]);
    return a ? send(200, { id: a.id, status: a.status, amount: { value: a.amount.toFixed(2) } }) : send(404, { name: 'RESOURCE_NOT_FOUND' });
  }
  if ((x = m(/^\/v2\/payments\/authorizations\/(\w+)\/capture$/))) {
    const a = auths.get(x[1])!;
    const amt = Number(body.amount.value);
    if (a.status !== 'CREATED') return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'AUTHORIZATION_ALREADY_CAPTURED' }] });
    if (amt > a.amount) return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'MAX_CAPTURE_AMOUNT_EXCEEDED' }] });
    a.status = 'CAPTURED';
    return send(201, { id: nid('CAP'), status: 'COMPLETED', amount: { value: amt.toFixed(2) } });
  }
  if ((x = m(/^\/v2\/payments\/authorizations\/(\w+)\/void$/))) {
    auths.get(x[1])!.status = 'VOIDED';
    return send(204);
  }
  if (path === '/v1/payments/payouts') return send(201, { batch_header: { payout_batch_id: nid('BATCH'), batch_status: 'PENDING' } });
  if (path === '/v1/notifications/verify-webhook-signature') {
    return send(200, { verification_status: body.transmission_sig === 'good-signature' ? 'SUCCESS' : 'FAILURE' });
  }
  send(404, { name: 'RESOURCE_NOT_FOUND', path });
});
await new Promise<void>((r) => stub.listen(0, r));
const stubPort = (stub.address() as { port: number }).port;

// ---- Quorum in sandbox mode, pointed at the stub -----------------------------------------
const port = 4100 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;
const env = {
  ...process.env,
  DATA_DIR: mkdtempSync(join(tmpdir(), 'quorum-stub-')),
  PORT: String(port),
  BASE_URL: base,
  PAYPAL_MODE: 'sandbox',
  PAYPAL_CLIENT_ID: 'stub-client',
  PAYPAL_CLIENT_SECRET: 'stub-secret',
  PAYPAL_WEBHOOK_ID: 'WH-STUB',
  PAYPAL_API_BASE: `http://localhost:${stubPort}`,
  ANTHROPIC_API_KEY: '',
  CHANNEL3_API_KEY: '',
  DEMO_ADMIN: 'true',
  SETTLE_INTERVAL_SECONDS: '3600',
  REFERRAL_REWARD: '5',
};
const node = ['--disable-warning=ExperimentalWarning'];
const seed = spawnSync('node', [...node, 'scripts/seed.ts', '--reset'], { env, encoding: 'utf8' });
const groupB = seed.stdout.match(/Group B[^\n]*\/q\/(q_[\w-]+)/)![1];
const server = spawn('node', [...node, 'src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

let failures = 0;
const check = (cond: unknown, label: string, extra?: unknown) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500)); }
};
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

try {
  console.log('Real REST client against a PayPal stub');
  const health = await call('GET', '/api/health');
  check(health.json.modes.paypal === 'sandbox', 'server runs in sandbox mode');

  // A tent group with 5 real (sandbox-provider) buyers.
  const m = await call('GET', '/api/merchant');
  const tent = m.json.products.find((p: any) => /tent/i.test(p.title));
  const og = await call('POST', `/api/merchant/products/${tent.id}/open-group`, { hours: 1 });
  const q = og.json.quorumId;
  const commitments: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const co = await call('POST', `/api/quorums/${q}/checkout`, { email: `buyer${i}@personal.example`, ref: commitments[0] });
    check(co.status === 200 && co.json.provider === 'paypal' && co.json.approveUrl.startsWith('https://sandbox.example/'), `buyer ${i}: AUTHORIZE order created`, co.json);
    const early = await call('POST', `/api/quorums/${q}/authorize`, { orderId: co.json.orderId });
    if (i === 1) check(early.status === 502 && /ORDER_NOT_APPROVED/.test(early.json.error), 'unapproved order → PayPal error surfaced', early.json);
    await fetch(`http://localhost:${stubPort}/stub/approve/${co.json.orderId}`, { method: 'POST', headers: { Authorization: 'Bearer stub-token' } });
    const au = await call('POST', `/api/quorums/${q}/authorize`, { orderId: co.json.orderId });
    check(au.status === 200 && au.json.status === 'authorized', `buyer ${i}: authorized`);
    commitments.push(co.json.commitmentId);
  }
  const create = log.find((l) => l.path === '/v2/checkout/orders')!;
  check(create.body.intent === 'AUTHORIZE' && create.body.purchase_units[0].amount.value === '249.00' && create.requestId?.startsWith('order-'), 'order body: AUTHORIZE, list price, idempotency key', create);

  const closed = await call('POST', `/api/quorums/${q}/settle`);
  const v = closed.json.quorum;
  check(v.status === 'closed' && v.finalPrice >= 190 && v.finalPrice <= 219, `closed at ${v.finalPrice} (floor 190, tier 219)`, v.summary);
  const caps = log.filter((l) => l.path.endsWith('/capture'));
  check(caps.length === 5 && caps.every((c) => Number(c.body.amount.value) === v.finalPrice && c.body.final_capture === true && c.requestId?.startsWith('cap-')), '5 captures at the final price, final_capture, idempotency keys', caps.map((c) => c.body));
  check(log.filter((l) => /\/v2\/payments\/authorizations\/\w+$/.test(l.path)).length >= 5, 'each authorization checked before capture');
  check(v.commitments.every((c: any) => c.status === 'captured' && c.captured < c.authorized), 'all captured below the authorized amount');
  check(log.some((l) => l.path === '/v1/payments/payouts' && l.body.items[0].amount.value === '20.00'), 'referral payout sent through Payouts API ($5 × 4 invited)');

  // Group B is seeded with simulated buyers: it fails and voids through the mock ledger, while new
  // real buyers would void through PayPal. Add one real buyer, then close it below the goal.
  const co = await call('POST', `/api/quorums/${groupB}/checkout`, { email: 'late@personal.example' });
  await fetch(`http://localhost:${stubPort}/stub/approve/${co.json.orderId}`, { method: 'POST', headers: { Authorization: 'Bearer stub-token' } });
  await call('POST', `/api/quorums/${groupB}/authorize`, { orderId: co.json.orderId });
  const fb = await call('POST', `/api/quorums/${groupB}/settle`);
  check(fb.json.quorum.status === 'failed' && log.some((l) => l.path.endsWith('/void')), 'group below goal: real authorization voided at PayPal', fb.json.quorum.status);

  console.log('Webhooks');
  const event = { id: 'WH-1', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: 'AUTH-UNKNOWN' } };
  const sigHeaders = { 'paypal-transmission-id': 't1', 'paypal-transmission-time': new Date().toISOString(), 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-auth-algo': 'SHA256withRSA' };
  const bad = await call('POST', '/api/webhooks/paypal', event, { ...sigHeaders, 'paypal-transmission-sig': 'forged' });
  check(bad.status === 400, 'forged webhook rejected after verify-webhook-signature');
  const good = await call('POST', '/api/webhooks/paypal', event, { ...sigHeaders, 'paypal-transmission-sig': 'good-signature' });
  check(good.status === 200, 'verified webhook accepted');
  const verify = log.filter((l) => l.path === '/v1/notifications/verify-webhook-signature').at(-1)!;
  check(verify.body.webhook_id === 'WH-STUB' && verify.body.webhook_event.id === 'WH-1', 'verification request carries webhook id and event');
} catch (err) {
  failures++;
  console.error(err);
} finally {
  server.kill();
  stub.close();
}
if (failures) {
  console.log(`\n${failures} check(s) failed.\n--- server log ---\n${serverLog.slice(-3000)}`);
  process.exit(1);
}
console.log('\nAll PayPal REST checks passed.');
