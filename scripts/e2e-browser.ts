// Drives a real Chrome through the whole product, with real clicks and typing:
// request → group → PayPal approval window → invite → close → live negotiation →
// charge → late buyer + refund → leave a group → merchant pricing agent → Spanish.
// Runs in simulation mode (no keys, no network). Needs Chrome or Chromium.
//
//   npm run e2e:browser            headless
//   HEADFUL=1 npm run e2e:browser  watch it happen
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, findChrome, sleep, type Page } from './lib/cdp.ts';

if (!findChrome()) {
  console.log('Chrome or Chromium not found: skipping the browser check (set CHROME_PATH to run it).');
  process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), 'quorum-browser-'));
const port = 4000 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;
const env = {
  ...process.env,
  DATA_DIR: dataDir,
  PORT: String(port),
  BASE_URL: base,
  PAYPAL_MODE: 'mock',
  PAYPAL_CLIENT_ID: '',
  PAYPAL_CLIENT_SECRET: '',
  ANTHROPIC_API_KEY: '',
  CHANNEL3_API_KEY: '',
  DEMO_ADMIN: 'true',
  QUORUM_ENV_FILE: 'none',
  SETTLE_INTERVAL_SECONDS: '3600',
  SEED_EXPIRING_MINUTES: '60',
};
const node = ['--disable-warning=ExperimentalWarning'];

let failures = 0;
function check(cond: unknown, label: string, extra?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
  }
}

const seed = spawnSync('node', [...node, 'scripts/seed.ts', '--reset'], { env, encoding: 'utf8' });
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  process.exit(1);
}
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

const browser = await Browser.launch({ headless: !process.env.HEADFUL, height: 1000 });
const pageErrors: string[] = [];
browser.on((method, params) => {
  if (method === 'Runtime.exceptionThrown') pageErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'error');
});

const dollars = (s: string) => Number((s.match(/\$([\d,.]+)/) ?? [])[1]?.replace(/,/g, ''));

/** Commit with the simulated PayPal window: click the button, approve in the popup. */
async function commit(page: Page, email: string) {
  await page.type('#commit-email', email);
  await page.click('#mock-pay');
  const popup = await browser.waitForPage('/mock-paypal/checkout');
  await popup.type('#sim-email', email);
  await popup.click('#sim-approve');
}

try {
  console.log('Request → group');
  const page = await browser.newPage(`${base}/?lang=en`);
  await page.waitForSelector('.group-card');
  check((await page.text('h1')).includes('Buy together'), 'home page renders');
  await page.type('#intent-text', 'Compact espresso machine for two, under $200');
  await page.click('#intent-form button[type=submit]');
  await page.waitForSelector('.result-card a.btn-primary');
  check(/4 already committed/.test(await page.text('.result-card')), 'intent agent found the group with 4 committed', await page.text('.result-card'));
  await page.click('.result-card a.btn-primary');
  await page.waitFor("location.pathname.startsWith('/q/')");
  await page.waitForSelector('#mock-pay');
  check((await page.text('.stats')).includes('4 / 5'), 'group page shows 4 of 5');
  check(await page.eval("document.querySelector('.live-dot') !== null"), 'page is connected to the live stream');

  console.log('Commit with PayPal (approval window)');
  await commit(page, 'tester@example.com');
  await page.waitFor("document.querySelector('#side').innerText.includes('PayPal is holding $199')");
  check(true, 'after approving, PayPal holds $199 and nothing is charged');
  await page.waitFor("document.querySelector('.stats').innerText.includes('5 / 5')");
  check(true, 'goal reached: 5 of 5');

  console.log('Invite + more buyers');
  await page.click('#draft-invite');
  await page.waitForSelector('#invite-text');
  check((await page.text('#invite-text')).includes('?ref=cmt_'), 'growth agent drafted an invite with my referral link');
  await page.click('#sim-buyer');
  await page.waitFor("document.querySelector('.stats').innerText.includes('6 / 5')");
  await page.click('#sim-buyer');
  await page.waitFor("document.querySelector('.stats').innerText.includes('7 / 5')");
  check(true, 'two more buyers appear without reloading');

  console.log('Close: live negotiation');
  await page.click('#force-close');
  const seen: number[] = [];
  let sawTyping = false;
  for (let i = 0; i < 200; i++) {
    const s = await page.eval<{ n: number; typing: boolean; done: boolean }>(
      "({ n: document.querySelectorAll('#transcript .bubble:not(.typing)').length, typing: !!document.querySelector('#transcript .typing'), done: !!document.querySelector('.result-banner.ok') })",
    );
    if (seen.at(-1) !== s.n) seen.push(s.n);
    sawTyping ||= s.typing;
    if (s.done) break;
    await sleep(150);
  }
  check(seen.length >= 3 && seen.every((n, i) => i === 0 || n > seen[i - 1]), `negotiation turns appeared one by one (${seen.join(' → ')})`, seen);
  check(sawTyping, 'a typing indicator showed while agents were working');
  const banner = await page.text('.result-banner.ok');
  const final = dollars(banner);
  check(final >= 160 && final <= 179, `group formed at $${final}, between the floor and the tier`, banner);
  check(banner.includes(`You paid $${final}`) && banner.includes('authorized $199'), 'banner says what I paid and what I had authorized', banner);
  const body = await page.text('#main');
  check(body.includes('How this price was reached') && body.includes('Negotiated by the agents') && body.includes('Ceiling:'), 'price explanation is shown');
  check(!body.includes('160') || final === 160, 'the merchant floor is not revealed on the page');

  console.log('Late buyer → price drop → refund');
  check(/price-drop guarantee/i.test(await page.text('#side')) || final === 160, 'member sees the price-drop guarantee');
  await page.click('#sim-buyer');
  const expected = Math.max(160, final - 10);
  await page.waitFor(`document.querySelector('.big-price').innerText.includes('$${expected}')`);
  check(true, `eighth buyer reached the next tier: price is now $${expected}`);
  if (expected < final) {
    await page.waitFor("document.querySelector('.members').innerText.includes('back')");
    check((await page.text('.result-banner.ok')).includes(`$${final - expected} was refunded`), `I was refunded $${final - expected}`, await page.text('.result-banner.ok'));
  }

  console.log('Leave a group');
  const kettle = await browser.newPage(`${base}/q/${groupB}`);
  await kettle.acceptDialogs();
  await kettle.waitForSelector('#mock-pay');
  await commit(kettle, 'tester@example.com');
  await kettle.waitForSelector('#leave-group');
  check((await kettle.text('.stats')).includes('3 / 5'), 'joined a second group (3 of 5)');
  await kettle.click('#leave-group');
  await kettle.waitForSelector('#mock-pay');
  await kettle.waitFor("document.querySelector('.stats').innerText.includes('2 / 5')");
  check((await kettle.text('.members')).includes('released'), 'left the group: hold released, back to 2 of 5');

  console.log('Merchant console: pricing agent');
  const merchant = await browser.newPage(`${base}/merchant`);
  await merchant.waitForSelector('[data-draft="0"]');
  await merchant.click('[data-draft="0"]');
  await merchant.waitFor("document.querySelector('[data-draft-note=\"0\"]').innerText.includes('waiting buyers can afford')");
  const form = await merchant.eval<Record<string, string>>(
    "Object.fromEntries(new FormData(document.querySelector('form[data-demand=\"0\"]')).entries())",
  );
  check(form.title && Number(form.listPrice) > 0 && Number(form.floorPrice) > 0 && /^\d+:\d+/.test(form.tiers), 'the draft filled the offer form', form);
  await merchant.click('form[data-demand="0"] button[type=submit]');
  await merchant.waitFor("location.pathname.startsWith('/q/')");
  await merchant.waitForSelector('.stats');
  check((await merchant.text('h1')).length > 3 && (await merchant.text('.stats')).includes('0 /'), 'the merchant opened a group from the demand board');

  console.log('Spanish');
  await page.click('#lang-toggle');
  await page.waitFor("document.querySelector('.topbar nav a').innerText === 'Iniciar un grupo'");
  await page.waitForSelector('.result-banner.ok');
  check((await page.text('.result-banner.ok')).includes('El grupo se formó'), 'the same page in Spanish');

  check(pageErrors.length === 0, 'no JavaScript errors on any page', pageErrors);
} catch (err) {
  failures++;
  console.error(err);
  if (pageErrors.length) console.error('page errors:', pageErrors);
} finally {
  await browser.close();
  server.kill();
}

if (failures) {
  console.log(`\n${failures} check(s) failed.\n--- server log ---\n${serverLog.slice(-2000)}`);
  process.exit(1);
}
console.log('\nAll browser checks passed.');
