// Records the demo video on its own: a real Chrome goes through the product
// with whatever services are configured in .env (PayPal sandbox, Claude,
// Channel3), captions are drawn on screen, and ffmpeg writes an MP4.
//
//   npm run demo:record            → out/quorum-demo.mp4 (about 2:45, 1920×1080, no audio)
//
// Needs Chrome and ffmpeg. With no keys it records the simulation mode, which
// is fine for a rehearsal but not for the submission: record with the footer
// showing PayPal sandbox and Claude.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Browser, findChrome, sleep, type Page } from './lib/cdp.ts';
import { payOnPage } from './lib/paypal-guest.ts';
import { Recorder } from './lib/recorder.ts';

if (!findChrome()) {
  console.error('Chrome or Chromium not found (set CHROME_PATH).');
  process.exit(1);
}
if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.error('ffmpeg not found.');
  process.exit(1);
}

const outDir = resolve('out');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'quorum-demo.mp4');
const dataDir = mkdtempSync(join(tmpdir(), 'quorum-demo-'));
const port = 4200 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;
const env = {
  ...process.env,
  DATA_DIR: dataDir,
  PORT: String(port),
  BASE_URL: base,
  DEMO_ADMIN: 'true',
  SETTLE_INTERVAL_SECONDS: '3600',
  SEED_EXPIRING_MINUTES: '45',
  LATE_JOIN_HOURS: '24',
  REFERRAL_REWARD: '0',
};
const node = ['--disable-warning=ExperimentalWarning'];

const seed = spawnSync('node', [...node, 'scripts/seed.ts', '--reset'], { env, encoding: 'utf8' });
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  process.exit(1);
}
const groupA = seed.stdout.match(/Group A[^\n]*\/q\/(q_[\w-]+)/)![1];
const server = spawn('node', [...node, 'src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
let modes: any = {};
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) {
      modes = ((await r.json()) as any).modes;
      break;
    }
  } catch {}
  await sleep(100);
}
const sandbox = modes.paypal === 'sandbox';
const claude = String(modes.ai).startsWith('anthropic');
console.log(`Recording with PayPal: ${modes.paypal}, AI: ${modes.ai}, Channel3: ${modes.channel3}, agent tools: ${modes.merchantTools}`);
if (!sandbox || !claude) console.log('Note: this is a rehearsal recording. Add PayPal sandbox and Anthropic keys to .env for the real one.');

const browser = await Browser.launch({ headless: !process.env.HEADFUL, width: 1280, height: 720 });
const rec = new Recorder(browser, join(dataDir, 'frames'));
const quorum = async () => ((await (await fetch(`${base}/api/quorums/${groupA}`)).json()) as any).quorum;
const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** Say something on screen and give people time to read it. */
async function say(text: string, holdMs?: number) {
  await rec.caption(text);
  await sleep(holdMs ?? Math.max(3200, text.length * 62));
}

async function payWithPayPal(page: Page) {
  const joined = async () => page.eval<boolean>("!!document.querySelector('#leave-group')").catch(() => false);
  if (sandbox) {
    await page.waitFor("(() => { const f = document.querySelector('#paypal-slot iframe'); return f && f.getBoundingClientRect().height > 40; })()", 40_000);
    await sleep(2500);
    const spot = await page.eval<{ x: number; y: number }>(
      "(() => { const f = document.querySelector('#paypal-slot iframe'); const r = f.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 22 }; })()",
    );
    await rec.clickAt(spot.x, spot.y);
    const popup = await browser.waitForPage('sandbox.paypal.com/', 40_000);
    rec.speed = 7; // PayPal's own form is not the story: play it fast
    await rec.watch(popup);
    const note = "PayPal's sandbox checkout (sped up). Paying as a guest with a sandbox test card.";
    const keep = setInterval(() => void rec.caption(note), 1200);
    try {
      await payOnPage(popup, { tag: 'demo', done: joined }).catch(async (err) => {
        for (let i = 0; i < 25 && !(await joined()); i++) await sleep(1000);
        if (!(await joined())) throw err;
      });
    } finally {
      clearInterval(keep);
      rec.speed = 1;
      await rec.watch(page);
    }
  } else {
    await rec.click('#mock-pay');
    const popup = await browser.waitForPage('/mock-paypal/checkout');
    await rec.watch(popup);
    await rec.caption('Simulation mode: this page stands in for PayPal because no sandbox keys are set.');
    await rec.type('#sim-email', 'maria.torres@example.com');
    await sleep(1200);
    await rec.click('#sim-approve');
    await rec.watch(page);
  }
  await page.waitFor("document.querySelector('#side') && /PayPal is holding/.test(document.querySelector('#side').innerText)", 60_000);
}

try {
  // 1. The problem and the idea
  const page = await browser.newPage('about:blank');
  await rec.prepare(page);
  await page.goto(`${base}/?lang=en`);
  await page.waitForSelector('.group-card');
  await rec.watch(page);
  await sleep(600);
  await say('Group buying keeps failing for one reason: coordinating strangers costs more than the discount.', 5200);
  await say('Quorum gives that work to AI agents, and uses PayPal so nobody pays unless the group actually forms.', 5600);

  // 2. Intent agent
  await rec.caption('Describe what you want, in English or Spanish.');
  await rec.type('#intent-text', 'Busco una cafetera espresso compacta para dos, máximo $199', 42);
  await sleep(700);
  await rec.click('#intent-form button[type=submit]');
  await page.waitForSelector('.result-card a.btn-primary', 60_000);
  await rec.scrollTo('.result-card', 'center');
  await say(`${claude ? 'An intent agent on Claude' : 'The intent agent'} extracts the product and the maximum price, and finds people who want the same thing. Four are already waiting.`, 6800);

  // 3. Commit with PayPal: authorize, never charge
  await rec.click('.result-card a.btn-primary');
  await page.waitFor("location.pathname.startsWith('/q/')");
  await page.waitForSelector('#commit-email');
  await sleep(900);
  await say('This group needs five buyers. Four have committed. One more and it forms.', 4600);
  await rec.caption(`Commit with PayPal. ${sandbox ? 'This is a real sandbox order with intent AUTHORIZE' : 'The order uses intent AUTHORIZE'}: PayPal holds the money and charges nothing.`);
  await rec.type('#commit-email', 'maria.torres@example.com');
  await sleep(1800);
  await payWithPayPal(page);
  await sleep(900);
  await say('PayPal is holding $199. Nothing was charged. I can leave any time and PayPal releases the hold.', 6200);

  // 4. Growth agent
  await rec.click('#draft-invite');
  await page.waitForSelector('#invite-text', 60_000);
  await rec.scrollTo('#invite-card', 'center');
  await say('A growth agent tells each member what one more buyer is worth, and writes the invite with a personal link.', 5600);
  await rec.caption('Two more people join.');
  await rec.click('#sim-buyer');
  await page.waitFor("document.querySelector('.stats').innerText.includes('6 / 5')");
  await rec.click('#sim-buyer');
  await page.waitFor("document.querySelector('.stats').innerText.includes('7 / 5')");
  await sleep(1400);

  // 5. Live negotiation
  await rec.click('#force-close');
  await rec.caption(
    sandbox && claude
      ? "The group closes. First, the merchant's agent reads its own PayPal account through PayPal's MCP server."
      : "The group closes. First, the merchant's agent checks its own sales, then the two agents negotiate.",
  );
  let explained = false;
  for (let i = 0; i < 400; i++) {
    const s = await page.eval<{ n: number; done: boolean }>("({ n: document.querySelectorAll('#transcript .bubble:not(.typing)').length, done: !!document.querySelector('.result-banner.ok') })");
    await page.eval("(() => { const b = document.querySelector('#transcript .bubble:last-child'); if (b) b.scrollIntoView({ block: 'center', behavior: 'smooth' }); })()");
    if (s.n >= 1 && !explained) {
      explained = true;
      await rec.caption('Two agents negotiate, live. Code checks every offer: never below the merchant’s private floor, never above what buyers authorized.');
    }
    if (s.done) break;
    await sleep(400);
  }
  await sleep(1500);
  const closed = await quorum();
  await page.eval("window.scrollTo({ top: 0, behavior: 'smooth' })");
  await sleep(1100);
  await say(`Deal. Everyone pays ${money(closed.finalPrice)} instead of $199. PayPal captured less than it had authorized: no refunds needed.`, 6800);

  // 6. Every price is explained
  await rec.scrollTo('.ladder', 'center');
  await say(`Every price is explained: the list price, the public group price, what the agents agreed${closed.market.length ? ', and a live market comparison from Channel3' : ''}. The merchant’s floor stays private.`, 7200);

  // 7. Late join + refund
  await page.eval("window.scrollTo({ top: 0, behavior: 'smooth' })");
  await sleep(1000);
  const drop = closed.lateJoin.nextDrop;
  await rec.caption('The price can only get better. The group stays open to late buyers.');
  await rec.click('#sim-buyer');
  if (drop) {
    await page.waitFor(`document.querySelector('.big-price').innerText.includes('${money(drop.price)}')`, 60_000);
    await sleep(900);
    await page.eval("window.scrollTo({ top: 0, behavior: 'smooth' })");
    await say(`An eighth buyer reaches the next tier: the price drops to ${money(drop.price)}, and PayPal refunds ${money(drop.refundEach)} to everyone already charged.`, 7200);
  } else {
    await sleep(2500);
    await say('A late buyer joins at the final price. If the group reaches a cheaper tier, PayPal refunds the difference to everyone.', 6000);
  }

  // 8. Merchant side: demand before supply
  await page.goto(`${base}/merchant?lang=en`);
  await page.waitForSelector('[data-draft="0"]');
  await sleep(700);
  await say('Merchants see demand before they stock. Three people want a standing desk that nobody sells here yet.', 5600);
  await rec.click('[data-draft="0"]');
  await rec.caption('A pricing agent drafts the offer…');
  await page.waitFor("document.querySelector('[data-draft-note=\"0\"]').innerText.includes('waiting buyers can afford')", 90_000);
  await rec.scrollTo('[data-draft-note="0"]', 'center');
  await say('…from what buyers said they would pay and live market prices. Code enforces the pricing rules; the merchant reviews it and opens the group.', 7400);

  // 9. Agent-to-agent, and close
  await page.goto(`${base}/?lang=en`);
  await page.waitForSelector('.agents-strip');
  await rec.scrollTo('.agents-strip', 'center');
  await say('Quorum is also an MCP server: any AI assistant can join a group for its user, with a spending limit. Only the person approves the payment.', 7200);
  await page.eval("window.scrollTo({ top: 0, behavior: 'smooth' })");
  await sleep(1000);
  await say('Agents coordinate. PayPal holds the money. Quorum: buy together, pay only if the group forms.', 6000);
  await sleep(400);
  await rec.stop();

  const info = rec.render(outFile);
  const m = Math.floor(info.seconds / 60);
  console.log(`\nWrote ${outFile} (${m}:${String(info.seconds % 60).padStart(2, '0')}, ${info.frames} frames).`);
} catch (err) {
  console.error(`\nRecording failed: ${(err as Error).message}\n--- server log ---\n${serverLog.slice(-1500)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
