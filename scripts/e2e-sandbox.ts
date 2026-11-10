// The whole app against the REAL PayPal sandbox, with no manual step.
// A real Chrome pays as a guest with a sandbox test card, and every result is
// checked twice: in Quorum and directly at PayPal.
//
//   npm run e2e:sandbox
//
//   1. Join a group: PayPal order (AUTHORIZE) → approval → Quorum authorizes, nothing charged
//   2. Join and leave another group: PayPal voids the authorization
//   3. The group closes: negotiation → PayPal captures less than it authorized
//   4. A late buyer reaches a cheaper tier: PayPal refunds the difference
//
// Needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox) and Chrome. Agents run
// on rules here so the check costs nothing; set E2E_USE_LLM=1 to use Claude.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.ts';
import { paypalBaseUrl, paypalFetch } from '../src/paypal/rest.ts';
import { Browser, findChrome, sleep } from './lib/cdp.ts';
import { payAsGuest, payOnPage } from './lib/paypal-guest.ts';

if (!config.paypal.clientId || !config.paypal.clientSecret || config.paypal.mode === 'live') {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for a SANDBOX app (PAYPAL_MODE must not be live).');
  process.exit(1);
}
if (!findChrome()) {
  console.error('Chrome or Chromium not found (set CHROME_PATH).');
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), 'quorum-sandbox-'));
const port = 4100 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;
const env = {
  ...process.env,
  DATA_DIR: dataDir,
  PORT: String(port),
  BASE_URL: base,
  PAYPAL_MODE: 'sandbox',
  PAYPAL_CLIENT_ID: config.paypal.clientId,
  PAYPAL_CLIENT_SECRET: config.paypal.clientSecret,
  PAYPAL_WEBHOOK_ID: '',
  ANTHROPIC_API_KEY: process.env.E2E_USE_LLM ? config.anthropic.apiKey : '',
  CHANNEL3_API_KEY: '',
  DEMO_ADMIN: 'true',
  QUORUM_ENV_FILE: 'none',
  SETTLE_INTERVAL_SECONDS: '3600',
  SEED_EXPIRING_MINUTES: '60',
  LATE_JOIN_HOURS: '24',
};
const node = ['--disable-warning=ExperimentalWarning'];
console.log(`PayPal ${paypalBaseUrl()} — the app at ${base}, real sandbox payments\n`);

let failures = 0;
function check(cond: unknown, label: string, extra?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
  }
}
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
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
  await sleep(100);
}

// Read-only view of the app's database, to look up the PayPal ids of a commitment.
const db = new DatabaseSync(join(dataDir, 'quorum.db'), { readOnly: true });
const commitment = (id: string) => db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as any;

const browser = await Browser.launch({ headless: !process.env.HEADFUL, height: 1400 });
try {
  console.log('1. Join a group with a real PayPal authorization');
  const co = await call('POST', `/api/quorums/${groupA}/checkout`, { email: 'sandbox.buyer@example.com' });
  check(co.status === 200 && co.json.provider === 'paypal' && /sandbox\.paypal\.com/.test(co.json.approveUrl), `PayPal order ${co.json.orderId} created with intent AUTHORIZE for $${co.json.amount}`, co.json);
  // PayPal redirects back to the group page, which finishes the authorization on its own.
  const page = await payAsGuest(browser, co.json.approveUrl, { tag: 'join', returnPrefix: `${base}/q/${groupA}` });
  await page.waitFor("document.querySelector('#side') && document.querySelector('#side').innerText.includes('PayPal is holding $199')", 30_000);
  check(true, "back from PayPal, the page says: PayPal is holding $199");
  const mine = commitment(co.json.commitmentId);
  check(mine.status === 'authorized' && mine.provider === 'paypal' && mine.authorization_id, `Quorum recorded authorization ${mine.authorization_id}`, mine);
  const authAtPayPal = await paypalFetch(`/v2/payments/authorizations/${mine.authorization_id}`);
  check(authAtPayPal.status === 'CREATED' && authAtPayPal.amount.value === '199.00', `PayPal: authorization is ${authAtPayPal.status} for $${authAtPayPal.amount.value}, nothing captured`);
  check((await call('GET', `/api/quorums/${groupA}`)).json.quorum.members === 5, 'the group reached its goal: 5 of 5');

  console.log('\n2. Join another group with the PayPal button on the page, then leave: PayPal voids the hold');
  const page2 = await browser.newPage(`${base}/q/${groupB}`);
  await page2.acceptDialogs();
  await page2.type('#commit-email', 'sandbox.buyer@example.com');
  // The PayPal JS SDK renders its buttons in a cross-origin iframe: click the first one (PayPal) by position.
  await page2.waitFor("(() => { const f = document.querySelector('#paypal-slot iframe'); return f && f.getBoundingClientRect().height > 40; })()", 40_000);
  await sleep(2500);
  await page2.type('#commit-email', 'sandbox.buyer@example.com'); // the buttons validate the email on click
  const spot = await page2.eval<{ x: number; y: number }>(
    "(() => { const f = document.querySelector('#paypal-slot iframe'); f.scrollIntoView({ block: 'center' }); const r = f.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 22 }; })()",
  );
  await page2.clickAt(spot.x, spot.y);
  const popup = await browser.waitForPage('sandbox.paypal.com/', 40_000).catch(async (err) => {
    if (process.env.DEBUG_SHOTS) {
      await page2.screenshot(`${process.env.DEBUG_SHOTS}/button-nopopup.png`).catch(() => {});
      console.log('    spot:', spot, 'targets:', (await browser.pages()).map((t) => `${t.type}:${t.url.slice(0, 60)}`));
      console.log('    email:', await page2.eval("document.querySelector('#commit-email')?.value"), 'toast:', await page2.eval("document.querySelector('.toast')?.innerText"));
    }
    throw err;
  });
  check(true, 'the PayPal button (JS SDK, intent=authorize) opened PayPal\'s checkout window');
  const approved = async () => page2.eval<boolean>("!!document.querySelector('#leave-group')").catch(() => false);
  await payOnPage(popup, { tag: 'button', done: approved }).catch(async (err) => {
    // PayPal closes its window as soon as the payer approves, which can interrupt the last check.
    if (process.env.DEBUG_SHOTS) {
      await sleep(4000);
      await page2.screenshot(`${process.env.DEBUG_SHOTS}/button-after.png`).catch(() => {});
      console.log('    targets:', (await browser.pages()).map((t) => `${t.type}:${t.url.slice(0, 70)}`));
    }
    for (let i = 0; i < 20 && !(await approved()); i++) await sleep(1000);
    if (!(await approved())) throw err;
  });
  await page2.waitForSelector('#leave-group', 30_000);
  const co2 = { json: { commitmentId: await page2.eval<string>(`localStorage.getItem('quorum:cmt:${groupB}')`) } };
  const held = commitment(co2.json.commitmentId);
  check(held.provider === 'paypal' && held.paypal_order_id, `the SDK's onApprove authorized order ${held.paypal_order_id}`);
  check(held.status === 'authorized', `joined the kettle group: PayPal holds $${held.authorized_amount}`);
  // PayPal's overlay fades out after its window closes; click once it no longer covers the page.
  for (let i = 0; i < 6 && (await page2.eval("!!document.querySelector('#leave-group')")); i++) {
    await sleep(2000);
    await page2.focus();
    await page2.click('#leave-group').catch(() => {});
    await page2.waitForSelector('#paypal-slot', 8000).catch(() => {});
  }
  await page2.waitForSelector('#paypal-slot', 10_000);
  check(commitment(co2.json.commitmentId).status === 'voided', 'clicked "Leave the group": Quorum marks the commitment released');
  const voided = await paypalFetch(`/v2/payments/authorizations/${held.authorization_id}`);
  check(voided.status === 'VOIDED', `PayPal: authorization ${held.authorization_id} is ${voided.status}`);

  console.log('\n3. The group closes: negotiation, then a real partial capture');
  for (let i = 0; i < 2; i++) await call('POST', `/api/quorums/${groupA}/simulate-buyer`, {});
  const closed = await call('POST', `/api/quorums/${groupA}/settle`);
  const q = closed.json.quorum;
  check(q.status === 'closed' && q.finalPrice >= 160 && q.finalPrice <= 179, `agents agreed on $${q.finalPrice} (public tier $179)`, { status: q.status, final: q.finalPrice });
  const paid = commitment(co.json.commitmentId);
  check(paid.status === 'captured' && paid.captured_amount === q.finalPrice && paid.capture_id, `Quorum captured $${paid.captured_amount} of the $199 authorized`, paid);
  const capAtPayPal = await paypalFetch(`/v2/payments/captures/${paid.capture_id}`);
  check(['COMPLETED', 'PENDING'].includes(capAtPayPal.status) && Number(capAtPayPal.amount.value) === q.finalPrice && capAtPayPal.final_capture === true, `PayPal: capture ${paid.capture_id} is ${capAtPayPal.status} for $${capAtPayPal.amount.value}, final_capture`, capAtPayPal);
  const authAfter = await paypalFetch(`/v2/payments/authorizations/${paid.authorization_id}`);
  check(authAfter.status === 'CAPTURED', `PayPal: authorization is ${authAfter.status}; the rest of the hold was released`);
  const again = await call('POST', `/api/quorums/${groupA}/settle`);
  check(commitment(co.json.commitmentId).capture_id === paid.capture_id && again.json.quorum.status === 'closed', 'settling again changes nothing (no double charge)');
  await page.waitFor("document.querySelector('.result-banner.ok') && document.querySelector('.result-banner.ok').innerText.includes('You paid')", 40_000);
  check((await page.text('.result-banner.ok')).includes(`You paid $${q.finalPrice}`), `the buyer's page shows: You paid $${q.finalPrice}`);

  console.log('\n4. A late buyer reaches the next tier: real refund of the difference');
  const expected = Math.max(160, q.finalPrice - 10);
  const late = await call('POST', `/api/quorums/${groupA}/simulate-buyer`, {});
  check(late.json.quorum.finalPrice === expected, `8 buyers: the price drops from $${q.finalPrice} to $${expected}`, late.json.quorum.finalPrice);
  if (expected < q.finalPrice) {
    const refunded = commitment(co.json.commitmentId);
    check(Math.abs(refunded.refunded_amount - (q.finalPrice - expected)) < 0.001, `Quorum refunded $${refunded.refunded_amount} to the real buyer`, refunded);
    const capAfter = await paypalFetch(`/v2/payments/captures/${paid.capture_id}`);
    check(capAfter.status === 'PARTIALLY_REFUNDED', `PayPal: capture is now ${capAfter.status}`, capAfter.status);
    await page.waitFor("document.querySelector('.result-banner.ok').innerText.includes('was refunded')", 30_000);
    check(true, "the buyer's page shows the refund");
  } else {
    console.log('  – the negotiated price was already at the floor, so there was nothing to refund');
  }
} catch (err) {
  failures++;
  console.error(`\n${(err as Error).message}`, JSON.stringify((err as any).details ?? '').slice(0, 400));
  if (process.env.DEBUG_SHOTS) console.error((err as Error).stack);
} finally {
  await browser.close();
  db.close();
  server.kill();
}

if (failures) {
  console.log(`\nFAIL: ${failures} problem(s).\n--- server log ---\n${serverLog.slice(-2000)}`);
  process.exit(1);
}
console.log('\nPASS: the app authorized, voided, partially captured and refunded real PayPal sandbox payments.');
