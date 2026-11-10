// Server-rendered page shells. Interactive parts are rendered by small
// vanilla JS files in /public that talk to the JSON API.
import { config, describeModes } from '../config.ts';
import { escapeHtml as e } from '../util.ts';

const LOGO = `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="12.5" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="9" cy="12" r="2.6" fill="currentColor"/><circle cx="19" cy="12" r="2.6" fill="currentColor"/><circle cx="14" cy="19" r="2.6" fill="currentColor"/></svg>`;

export function layout(title: string, body: string, opts: { scripts?: string[]; active?: 'home' | 'merchant' | '' } = {}) {
  const modes = describeModes();
  const clientConfig = {
    paypalMode: config.paypal.mode,
    paypalClientId: config.paypal.mode === 'mock' ? null : config.paypal.clientId,
    currency: config.paypal.currency,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} · Quorum</title>
<meta name="description" content="Buy together. AI agents pool purchase intent into group buying power; PayPal holds each payment and charges only if the group forms.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
<script>window.QUORUM = ${JSON.stringify(clientConfig).replaceAll('<', '\\u003c')};</script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">${LOGO}<span>Quorum</span></a>
  <nav>
    <a href="/" class="${opts.active === 'home' ? 'active' : ''}">Start a group</a>
    <a href="/#groups">Open groups</a>
    <a href="/merchant" class="${opts.active === 'merchant' ? 'active' : ''}">Merchant console</a>
  </nav>
</header>
<main>${body}</main>
<footer class="footer">
  <span>Quorum · built for the PayPal AI Hackathon</span>
  <span class="modes">
    <span class="pill ${modes.paypal === 'mock' ? 'pill-warn' : 'pill-ok'}" title="PayPal mode">PayPal: ${e(modes.paypal === 'mock' ? 'simulated' : modes.paypal)}</span>
    <span class="pill" title="AI engine">AI: ${e(modes.ai.startsWith('anthropic') ? 'Claude' : 'heuristic')}</span>
    <span class="pill" title="Market data">Channel3: ${e(modes.channel3.startsWith('live') ? 'live' : 'off')}</span>
  </span>
</footer>
${(opts.scripts ?? []).map((s) => `<script src="${e(s)}" defer></script>`).join('\n')}
</body>
</html>`;
}

export function homePage() {
  return layout(
    'Buy together',
    `
<section class="hero">
  <div class="hero-copy">
    <p class="eyebrow">Group buying, run by agents</p>
    <h1>Buy together.<br>Pay only if the group forms.</h1>
    <p class="lead">Tell Quorum what you want. An AI agent finds people who want the same thing, PayPal holds your payment without charging it, and an agent negotiates a volume price for the whole group. No group, no charge.</p>
  </div>
  <form id="intent-form" class="card intent-card" autocomplete="on">
    <label for="intent-text">What do you want to buy?</label>
    <textarea id="intent-text" name="text" rows="3" maxlength="500" required placeholder="A compact espresso machine for two, under $200, before December"></textarea>
    <div class="examples" aria-label="Examples">
      <button type="button" class="chip" data-example="Compact espresso machine for two, under $200, before December">Espresso machine under $200</button>
      <button type="button" class="chip" data-example="Busco una carpa ultraligera para 2 personas, máximo $230">Carpa para 2 (español)</button>
      <button type="button" class="chip" data-example="Electric gooseneck kettle for pour-over coffee, less than $65">Gooseneck kettle</button>
    </div>
    <label for="intent-email">Email <span class="muted">(optional, to hear when your group closes)</span></label>
    <input id="intent-email" name="email" type="email" placeholder="you@example.com">
    <button class="btn btn-primary" type="submit">Find my group</button>
    <div id="intent-result" class="intent-result" aria-live="polite"></div>
  </form>
</section>

<section class="how">
  <div class="step"><span class="num">1</span><h3>Describe it</h3><p>In your own words, in English or Spanish. The intent agent extracts what you need, your max price and your deadline.</p></div>
  <div class="step"><span class="num">2</span><h3>Commit without paying</h3><p>PayPal authorizes the list price. Nothing is charged. Each new member lowers the price for everyone.</p></div>
  <div class="step"><span class="num">3</span><h3>Agents close the deal</h3><p>When the group forms, a buyer agent negotiates with the merchant's agent. You pay the final group price, never more than you authorized.</p></div>
</section>

<section id="groups" class="groups">
  <div class="section-head"><h2>Open groups</h2><p class="muted">Join one directly, or describe what you want above.</p></div>
  <div id="group-grid" class="group-grid"><p class="muted">Loading…</p></div>
</section>`,
    { scripts: ['/common.js', '/app.js'], active: 'home' },
  );
}

export function quorumPage(id: string) {
  return layout(
    'Group',
    `<div id="quorum-root" data-quorum-id="${e(id)}" class="quorum-root"><p class="muted">Loading group…</p></div>`,
    { scripts: ['/common.js', '/quorum.js'] },
  );
}

export function merchantPage() {
  return layout(
    'Merchant console',
    `<div id="merchant-root" class="merchant-root"><p class="muted">Loading console…</p></div>`,
    { scripts: ['/common.js', '/merchant.js'], active: 'merchant' },
  );
}

/** Stand-in for the PayPal approval step when PAYPAL_MODE=mock. Clearly labelled as a simulation. */
export function mockCheckoutPage(orderId: string, amount: number | null, quorumId: string | null = null) {
  const back = quorumId ? `/q/${encodeURIComponent(quorumId)}?token=${encodeURIComponent(orderId)}` : '/';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment simulation</title><link rel="stylesheet" href="/styles.css"></head>
<body class="sim-body">
<div class="card sim-card">
  <p class="eyebrow">Simulation mode · no real money</p>
  <h1>Approve payment authorization</h1>
  <p>This page stands in for PayPal's approval step because Quorum is running without PayPal sandbox credentials. With credentials, buyers approve in PayPal's own checkout.</p>
  <dl class="sim-dl"><dt>Order</dt><dd>${e(orderId)}</dd><dt>Amount to authorize</dt><dd>${amount === null ? '—' : `$${amount.toFixed(2)}`}</dd><dt>Charged now</dt><dd>$0.00</dd></dl>
  <label for="sim-email">Payer email</label>
  <input id="sim-email" type="email" value="buyer@example.com">
  <div class="row">
    <button class="btn btn-primary" id="sim-approve">Approve authorization</button>
    <button class="btn" id="sim-cancel">Cancel</button>
  </div>
  <p class="muted small">Tip: an email containing <code>+decline</code> simulates a card that fails at capture.</p>
</div>
<script>
const orderId = ${JSON.stringify(orderId).replaceAll('<', '\\u003c')};
const back = ${JSON.stringify(back).replaceAll('<', '\\u003c')};
document.getElementById('sim-approve').onclick = async () => {
  const email = document.getElementById('sim-email').value;
  const r = await fetch('/api/mock-paypal/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, email }) });
  if (!r.ok) { alert('Approval failed'); return; }
  if (window.opener) { window.opener.postMessage({ type: 'quorum-mock-approved', orderId }, location.origin); window.close(); }
  else { location.href = back; } // opened from a link (for example by an agent): return like PayPal's redirect does
};
document.getElementById('sim-cancel').onclick = () => {
  if (window.opener) { window.opener.postMessage({ type: 'quorum-mock-cancelled', orderId }, location.origin); window.close(); } else { location.href = back.split('?')[0]; }
};
</script>
</body></html>`;
}

export function notFoundPage() {
  return layout('Not found', `<section class="card narrow"><h1>Not found</h1><p>That page does not exist. <a href="/">Start a group</a>.</p></section>`);
}
