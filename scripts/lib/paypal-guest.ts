// Pays a PayPal SANDBOX order as a guest with a sandbox test card, in a real
// Chrome. It lets the sandbox checks run with no person and no sandbox buyer
// account. PayPal's checkout page is not ours: if its form changes, the
// selectors here are the place to update.
import { Browser, sleep, type Page } from './cdp.ts';

/**
 * A fresh sandbox test card, like PayPal's sandbox card generator makes: a
 * Luhn-valid number not yet attached to any sandbox account.
 * These numbers only exist in the sandbox; they are not real cards.
 */
export function testCard(prefix: string) {
  let digits = prefix;
  while (digits.length < 15) digits += Math.floor(Math.random() * 10);
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(digits[14 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits + ((10 - (sum % 10)) % 10);
}

const PREFIXES = (process.env.SANDBOX_CARD_PREFIXES ?? '403203,402400,453201,455673').split(',');
let cardAttempt = 0;
const nextCard = () => ({
  number: process.env.SANDBOX_CARD_NUMBER ?? testCard(PREFIXES[cardAttempt++ % PREFIXES.length]),
  expiry: process.env.SANDBOX_CARD_EXPIRY ?? '12/30',
  cvv: process.env.SANDBOX_CARD_CVV ?? '123',
});
type Card = ReturnType<typeof nextCard>;

export type GuestOptions = {
  tag: string; // makes the payer email unique
  returnPrefix: string; // PayPal sends the browser here once the payer approved
  cancelMarker?: string; // part of the cancel URL
};

/** Pay as a guest, trying a few fresh test cards if PayPal refuses one. Returns the page, now on the return URL. */
export async function payAsGuest(browser: Browser, approveUrl: string, opts: GuestOptions): Promise<Page> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return await payOnce(browser, approveUrl, { ...opts, tag: `${opts.tag}${i || ''}` }, nextCard());
    } catch (err) {
      last = err;
      if (!/refused the card/i.test((err as Error).message)) throw err;
      console.log('  – PayPal refused that test card, trying another');
    }
  }
  throw last;
}

async function payOnce(browser: Browser, approveUrl: string, opts: GuestOptions, card: Card): Promise<Page> {
  const page = await browser.newPage(approveUrl);
  const dir = process.env.DEBUG_SHOTS;
  const shot = async (name: string) => {
    if (dir) await page.screenshot(`${dir}/${opts.tag}-${name}.png`).catch(() => {});
  };
  await page.waitForSelector('#createAccount, #cardNumber', 40_000);
  // "Pay with debit or credit card". The button exists before its handler is attached, so retry.
  for (let i = 0; i < 12 && (await page.eval("!document.querySelector('#cardNumber')").catch(() => true)); i++) {
    await sleep(3000);
    await page.eval("(() => { const b = document.querySelector('#createAccount'); if (b) b.click(); })()").catch(() => {});
    await page.waitForSelector('#cardNumber', 8000).catch(() => {});
  }
  await page.waitForSelector('#cardNumber', 5000);
  await sleep(2000);

  // PayPal's form re-renders and masks some inputs, so type key by key and confirm the field kept the text.
  const fill = async (selector: string, value: string) => {
    const sel = JSON.stringify(selector);
    if (await page.eval(`!document.querySelector(${sel})`)) return;
    const plain = (v: string) => v.replace(/\W/g, '').toLowerCase();
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.eval(`(() => { const el = document.querySelector(${sel}); el.scrollIntoView({ block: 'center' }); el.focus(); el.select && el.select(); })()`);
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      for (const ch of value) {
        await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
        await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
        await sleep(25);
      }
      await sleep(250);
      const got = await page.eval<string>(`(document.querySelector(${sel}) || {}).value || ''`);
      if (plain(got).endsWith(plain(value))) return;
      await sleep(600);
    }
    throw new Error(`PayPal's form did not keep the value typed into ${selector}`);
  };
  await fill('#cardNumber', card.number);
  await fill('#cardExpiry', card.expiry);
  await fill('#cardCvv', card.cvv);
  await fill('#firstName', 'Quorum');
  await fill('#lastName', 'Tester');
  await fill('#billingLine1', 'Av. Larco 1301');
  await fill('#billingCity', 'Lima');
  await fill('#billingPostalCode', '15074');
  await fill('#billingState', 'Lima');
  await fill('#phone', '987654321');
  await fill('#email', `quorum.sandbox.${Date.now().toString(36)}.${opts.tag}@example.com`);
  // Stay a guest. PayPal shows one of two forms: a radio ("continue as guest") or a switch
  // ("save information and open your PayPal account") that is on by default and asks for an ID.
  await page.eval(`(() => {
    const g = document.querySelector('#onboardOptionGuest');
    if (g && !g.checked) g.click();
    for (const el of document.querySelectorAll('input[type=checkbox], [role=switch]')) {
      const label = ((el.closest('label') || el.parentElement.parentElement || el).innerText || '') + ' ' + (el.id || '') + ' ' + (el.name || '');
      const on = el.checked === true || el.getAttribute('aria-checked') === 'true';
      if (on && /cuenta de PayPal|PayPal account|signup|createAccount/i.test(label)) el.click();
    }
  })()`);
  await sleep(1200);
  await shot('filled');
  // The pay button is the submit button of the card form (not the language or country buttons).
  await page.eval(
    "(() => { const btns = [...document.querySelectorAll('button[type=submit]')].filter((b) => b.offsetParent && !/English|Français|中文|país|country/i.test(b.innerText)); const b = btns.find((x) => /continu|pay|pagar/i.test(x.innerText)) || btns.at(-1); b.scrollIntoView({ block: 'center' }); b.click(); })()",
  );

  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    const url = await page.url().catch(() => '');
    if (url.startsWith(opts.returnPrefix)) {
      if (opts.cancelMarker && url.includes(opts.cancelMarker)) throw new Error('PayPal returned to the cancel URL');
      return page;
    }
    const refused = await page
      .eval<string>("(document.body.innerText.match(/[^.\\n]*(no pudimos asociar esta tarjeta|couldn.t add this card|card was declined|tarjeta fue rechazada)[^.\\n]*/i) || [''])[0]")
      .catch(() => '');
    if (refused) {
      await shot('refused');
      throw new Error(`PayPal refused the card: ${refused.trim()}`);
    }
    // Some flows show a review step with one more button.
    await page
      .eval("(() => { const b = document.querySelector('#payment-submit-btn, [data-testid=submit-button-initial], #confirmButtonTop'); if (b && b.offsetParent && !b.disabled) b.click(); })()")
      .catch(() => {});
    await sleep(1500);
  }
  await shot('stuck');
  const text = (await page.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
  throw new Error(`PayPal's page did not finish the approval. It shows: ${text}`);
}
