// End-to-end check of the full cycle against a real HTTP server in mock mode:
// intent → group → PayPal authorization → invites → close → negotiation → capture,
// plus the failure path (void), a declined capture, and the merchant demand board.
//
//   npm run e2e:mock
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'quorum-e2e-'));
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;
const env = {
  ...process.env,
  DATA_DIR: dataDir,
  PORT: String(port),
  BASE_URL: base,
  PAYPAL_MODE: 'mock',
  PAYPAL_CLIENT_ID: '',
  PAYPAL_CLIENT_SECRET: '',
  ANTHROPIC_API_KEY: process.env.E2E_USE_LLM ? process.env.ANTHROPIC_API_KEY : '',
  CHANNEL3_API_KEY: '',
  DEMO_ADMIN: 'true',
  SETTLE_INTERVAL_SECONDS: '3600',
  REFERRAL_REWARD: '5',
};
const node = ['--disable-warning=ExperimentalWarning'];

let failures = 0;
function check(cond: unknown, label: string, extra?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
  }
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, json };
}

const seed = spawnSync('node', [...node, 'scripts/seed.ts', '--reset'], { env, encoding: 'utf8' });
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  process.exit(1);
}
const groupA = seed.stdout.match(/Group A[^\n]*\/q\/(q_[\w-]+)/)![1];
const groupB = seed.stdout.match(/Group B[^\n]*\/q\/(q_[\w-]+)/)![1];

const server = spawn('node', [...node, 'src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

try {
  console.log('Pages');
  for (const p of ['/', `/q/${groupA}`, '/merchant']) {
    const r = await fetch(base + p);
    check(r.status === 200 && (await r.text()).includes('Quorum'), `GET ${p} renders`);
  }

  console.log('Intent agent');
  const intent = await call('POST', '/api/intents', { text: 'Busco una cafetera espresso compacta para dos, máximo $199', email: 'me@example.com' });
  check(intent.status === 200 && intent.json.quorumId === groupA, 'Spanish request joins the open espresso group', intent.json);
  check(intent.json.parsed?.max_price === 199, 'max price parsed from Spanish text', intent.json.parsed);

  const tooCheap = await call('POST', '/api/intents', { text: 'espresso machine under $90' });
  check(tooCheap.json.quorumId === null, 'request below the group price is not grouped (hard price filter)', tooCheap.json);

  console.log('Checkout (authorize only)');
  const before = (await call('GET', `/api/quorums/${groupA}`)).json.quorum;
  check(before.members === 4 && before.minMembers === 5, 'seeded group A has 4 of 5', { m: before.members, min: before.minMembers });
  const co = await call('POST', `/api/quorums/${groupA}/checkout`, { email: 'me@example.com', intentId: intent.json.intentId });
  check(co.status === 200 && co.json.amount === 199 && co.json.approveUrl, 'order created for the list price, capped by buyer max', co.json);
  const early = await call('POST', `/api/quorums/${groupA}/authorize`, { orderId: co.json.orderId });
  check(early.status === 502 || early.status === 422, 'authorization refused before the buyer approves', early);
  await call('POST', '/api/mock-paypal/approve', { orderId: co.json.orderId, email: 'me@example.com' });
  const auth = await call('POST', `/api/quorums/${groupA}/authorize`, { orderId: co.json.orderId });
  check(auth.status === 200 && auth.json.status === 'authorized', 'authorized after approval', auth.json);
  check(auth.json.quorum.members === 5 && auth.json.quorum.goalReached, 'goal reached with 5 members');
  const dup = await call('POST', `/api/quorums/${groupA}/checkout`, { email: 'me@example.com' });
  check(dup.status === 409, 'same buyer cannot join twice');

  console.log('Growth agent');
  const inv = await call('POST', `/api/quorums/${groupA}/invite`, { commitmentId: co.json.commitmentId });
  check(inv.status === 200 && inv.json.link.includes(`ref=${co.json.commitmentId}`) && inv.json.message.includes(inv.json.link), 'invite carries a personal referral link', inv.json);
  check(/\$169/.test(inv.json.headline + inv.json.message + inv.json.tip), 'invite names the next tier price ($169)', inv.json);

  for (let i = 0; i < 2; i++) await call('POST', `/api/quorums/${groupA}/simulate-buyer`, { ref: co.json.commitmentId });
  const seven = (await call('GET', `/api/quorums/${groupA}`)).json.quorum;
  check(seven.members === 7 && seven.currentPrice === 179, '7 members → $179 tier', { m: seven.members, p: seven.currentPrice });

  console.log('Close: negotiation + capture');
  const closed = await call('POST', `/api/quorums/${groupA}/settle`);
  const qa = closed.json.quorum;
  check(qa.status === 'closed', 'group A closed', closed.json);
  check(qa.finalPrice >= 160 && qa.finalPrice <= 179, `final price ${qa.finalPrice} within [floor 160, tier 179]`);
  check(qa.negotiation && qa.negotiation.turns.length >= 2, `negotiation transcript has ${qa.negotiation?.turns.length} turns`);
  const caps = qa.commitments.filter((c: any) => c.status === 'captured');
  check(caps.length === 7 && caps.every((c: any) => c.captured === qa.finalPrice && c.captured < c.authorized), 'all 7 captured at the final price, below what each authorized', caps);
  const again = await call('POST', `/api/quorums/${groupA}/settle`);
  check(again.json.quorum.commitments.filter((c: any) => c.status === 'captured').length === 7, 'settling twice is a no-op (idempotent)');

  console.log('Failure path: group B does not form');
  const fb = await call('POST', `/api/quorums/${groupB}/settle`);
  check(fb.json.quorum.status === 'failed', 'group B failed', fb.json.quorum?.status);
  check(fb.json.quorum.commitments.every((c: any) => c.status === 'voided'), 'every authorization voided, nobody charged');

  console.log('Merchant console + demand board');
  const m = await call('GET', '/api/merchant');
  const desk = m.json.demand.find((d: any) => /desk/i.test(d.label));
  check(desk && desk.count >= 3, 'standing-desk demand clustered (English + Spanish)', m.json.demand);
  const created = await call('POST', '/api/merchant/products', {
    merchantId: m.json.merchants[0].id,
    title: 'Electric standing desk, dual motor',
    category: 'home',
    listPrice: 329,
    floorPrice: 240,
    tiers: [{ min: 3, price: 289 }, { min: 6, price: 269 }],
    keywords: 'standing desk, electric, height adjustable, desk',
    stock: 20,
    openGroup: true,
    hours: 24,
  });
  check(created.status === 200 && created.json.quorumId && created.json.attachedIntents === 2, 'merchant opens a group from demand; the 2 requests that can afford $289 move in', created.json);
  const left = (await call('GET', '/api/merchant')).json.demand.find((d: any) => /desk/i.test(d.label));
  check(left && left.count === 1 && left.medianMax === 280, 'the $280-max request stays on the board (group price is above its max)', left);
  const badFloor = await call('POST', '/api/merchant/products', { title: 'x', listPrice: 10, floorPrice: 20, tiers: [{ min: 2, price: 9 }] });
  check(badFloor.status === 400, 'floor above list price is rejected');

  console.log('Declined capture');
  const grinder = m.json.products.find((p: any) => /grinder/i.test(p.title));
  const og = await call('POST', `/api/merchant/products/${grinder.id}/open-group`, { hours: 1 });
  for (const e of ['a@example.com', 'b@example.com', 'c@example.com', 'd+decline@example.com']) {
    await call('POST', `/api/quorums/${og.json.quorumId}/simulate-buyer`, { email: e });
  }
  const gc = await call('POST', `/api/quorums/${og.json.quorumId}/settle`);
  const st = gc.json.quorum.commitments.map((c: any) => c.status).sort();
  check(gc.json.quorum.status === 'closed' && st.filter((s: string) => s === 'failed').length === 1 && st.filter((s: string) => s === 'captured').length === 3, 'declined card marked failed, others captured', st);

  console.log('Referral payouts');
  const payouts = (await call('GET', `/api/quorums/${groupA}`)).json.quorum.payouts;
  check(payouts.length === 1 && payouts[0].commitmentId === co.json.commitmentId && payouts[0].amount === 10, 'referrer paid $5 × 2 invited members via Payouts', payouts);
  const ev = await call('GET', '/api/events');
  check(ev.json.events.some((e: any) => e.type === 'PAYMENT.CAPTURE.COMPLETED') && ev.json.events.some((e: any) => e.type === 'PAYMENT.AUTHORIZATION.VOIDED'), 'PayPal-style events recorded');

  console.log('MCP server (agent-to-agent)');
  const init = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
  check(init.json.result?.serverInfo?.name === 'quorum' && init.json.result.capabilities.tools, 'MCP initialize', init.json);
  const toolsList = await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  check(toolsList.json.result?.tools?.map((t: any) => t.name).join(',') === 'add_intent,list_open_quorums,get_quorum', 'MCP tools/list');
  const viaAgent = await call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_intent', arguments: { text: 'ultralight tent for two people, max $240' } } });
  const sc = viaAgent.json.result?.structuredContent;
  check(sc && sc.quorum && /tent/i.test(sc.quorum.product) && sc.approveUrl.includes('/q/'), 'external agent adds an intent and gets an approval link', viaAgent.json);
  const notif = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  check(notif.status === 202, 'MCP notification acknowledged with 202');

  console.log('Security');
  const hook = await call('POST', '/api/webhooks/paypal', { event_type: 'PAYMENT.CAPTURE.COMPLETED' });
  check(hook.status === 400, 'unverified webhook rejected');
  const xss = await call('POST', '/api/intents', { text: '<script>alert(1)</script> espresso machine under $200' });
  const page = await (await fetch(`${base}/`)).text();
  check(!page.includes('<script>alert(1)</script>'), 'user text is not reflected unescaped');
  check(xss.status === 200, 'odd input handled');
} catch (err) {
  failures++;
  console.error(err);
} finally {
  server.kill();
}

if (failures) {
  console.log(`\n${failures} check(s) failed.\n--- server log ---\n${serverLog.slice(-3000)}`);
  process.exit(1);
}
console.log('\nAll end-to-end checks passed.');
