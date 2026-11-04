// Group page: progress, commit with PayPal (authorize only), invites, negotiation transcript.
(function () {
  const { esc, money, api, timeLeft, toast, initial, statusPill, progressBar } = window.Q;
  const root = document.getElementById('quorum-root');
  const id = root.dataset.quorumId;
  const params = new URLSearchParams(location.search);
  const intentId = params.get('intent');
  const ref = params.get('ref');
  const storeKey = `quorum:cmt:${id}`;
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  let state = null;
  let sideKey = '';
  let revealed = -1; // negotiation turns shown so far (-1 = not started)
  let pollTimer = null;

  root.innerHTML = `<div class="quorum-layout"><div class="quorum-main" id="main"></div><aside class="quorum-side" id="side"></aside></div>`;
  const main = document.getElementById('main');
  const side = document.getElementById('side');

  const mine = () => {
    const cid = store.get(storeKey);
    return cid && state ? state.quorum.commitments.find((c) => c.id === cid) : null;
  };

  async function load() {
    try {
      state = await api('GET', `/api/quorums/${encodeURIComponent(id)}`);
      render();
    } catch (err) {
      main.innerHTML = `<div class="card"><h2>Group not found</h2><p>${esc(err.message)}</p><a href="/">Back to start</a></div>`;
      side.innerHTML = '';
    } finally {
      clearTimeout(pollTimer);
      const s = state && state.quorum.status;
      pollTimer = setTimeout(load, s === 'negotiating' || s === 'settling' ? 1500 : 4000);
    }
  }

  function goalPrice(q) {
    return (q.tiers.find((t) => t.min === q.minMembers) || {}).price;
  }

  function render() {
    const q = state.quorum;
    const me = mine();
    const shownPrice = q.finalPrice ?? (q.goalReached ? q.currentPrice : goalPrice(q));
    const priceNote = q.finalPrice
      ? 'Final negotiated price'
      : q.goalReached
        ? 'Group price now, before negotiation'
        : `Group price once ${q.minMembers} commit`;

    let banner = '';
    if (q.status === 'closed') {
      const paid = me && me.status === 'captured' ? `<p><b>You paid ${money(me.captured)}</b> (you had authorized ${money(me.authorized)}).</p>` : '';
      banner = `<div class="result-banner ok"><h2>The group formed. Everyone paid ${money(q.finalPrice)}.</h2><p>${esc(q.summary || '')}</p>${paid}</div>`;
    } else if (q.status === 'failed') {
      banner = `<div class="result-banner fail"><h2>This group did not form</h2><p>${esc(q.summary || '')}</p><a class="btn btn-small" href="/">Start another request</a></div>`;
    } else if (q.status === 'negotiating' || q.status === 'settling') {
      banner = `<div class="notice notice-warn"><b>Goal reached.</b> The buyer agent is negotiating with ${esc(q.merchant.name)}'s agent. Payments are captured right after.</div>`;
    }

    const saving = q.product.listPrice - shownPrice;
    main.innerHTML = `
      ${banner}
      <section class="card">
        <div class="product-head">
          <div class="art art-${esc(q.product.category)}">${initial(q.product.title)}</div>
          <div>
            <div class="row" style="margin-bottom:.4rem">${statusPill(q.status)}<span class="muted small">Sold by ${esc(q.merchant.name)}</span></div>
            <h1 style="font-size:1.9rem">${esc(q.product.title)}</h1>
            <p class="muted">${esc(q.product.description)}</p>
            <div class="big-price">${money(shownPrice)}<span class="strike">${money(q.product.listPrice)}</span></div>
            <p class="muted small" style="margin-top:.35rem">${priceNote}</p>
          </div>
        </div>
        ${progressBar(q, false)}
        <div class="stats">
          <div class="stat"><b>${q.members} / ${q.minMembers}</b><span>committed / goal</span></div>
          <div class="stat"><b class="countdown" data-closes="${esc(q.closesAt)}">${q.status === 'open' ? timeLeft(q.closesAt) : '—'}</b><span>${q.status === 'open' ? 'left to join' : 'closed'}</span></div>
          <div class="stat"><b>${saving > 0 ? money(saving) : '—'}</b><span>saved per buyer</span></div>
        </div>
      </section>

      ${negotiationCard(q)}

      <section class="card">
        <h3>Price tiers</h3>
        <table class="tier-table"><thead><tr><th>Buyers</th><th>Price each</th><th>Saving</th></tr></thead><tbody>
          ${q.tiers.map((t) => `<tr class="${q.currentPrice === t.price && t.min <= q.members ? 'current' : ''}"><td>${t.min === 1 ? 'Alone' : `${t.min}+`}</td><td>${money(t.price)}</td><td>${t.price < q.product.listPrice ? money(q.product.listPrice - t.price) : '—'}</td></tr>`).join('')}
        </tbody></table>
        <p class="muted small" style="margin-top:.6rem">The merchant agent may go below the tier price when it negotiates. It is never above it.</p>
      </section>

      <section class="card">
        <h3>Who's in</h3>
        <div class="members">${
          q.commitments.filter((c) => c.status !== 'created').map((c) => `<span class="member ${c.provider === 'mock' ? 'sim' : ''}" title="${esc(c.status)}${c.provider === 'mock' ? ' · simulated buyer' : ''}"><span class="avatar">${initial(c.name)}</span>${esc(c.name)}${memberBadge(c)}</span>`).join('') || '<span class="muted">Nobody yet. Be the first.</span>'
        }</div>
        ${q.commitments.some((c) => c.provider === 'mock') ? '<p class="muted small" style="margin-top:.6rem">Grey avatars are simulated demo buyers.</p>' : ''}
      </section>

      ${marketCard(q)}
      ${agentCard()}
    `;

    const key = `${q.status}|${me ? me.status : 'none'}|${state.admin}`;
    if (key !== sideKey) {
      sideKey = key;
      renderSide(q, me);
    }
    tickNegotiation(q);
  }

  function memberBadge(c) {
    if (c.status === 'captured') return ` <span class="pill pill-ok">paid ${money(c.captured)}</span>`;
    if (c.status === 'voided') return ' <span class="pill">released</span>';
    if (c.status === 'failed') return ' <span class="pill pill-danger">failed</span>';
    return '';
  }

  function negotiationCard(q) {
    if (!q.negotiation) {
      if (q.status === 'negotiating') return '<section class="card"><h3>Negotiation</h3><p class="muted">Agents are negotiating…</p></section>';
      if (q.status !== 'open') return '';
      return `<section class="card"><h3>Negotiation</h3><p class="muted">When the group closes with at least ${q.minMembers} buyers, the buyer agent negotiates with the merchant agent. Every offer passes Quorum's rules: never below the merchant's floor, never above what buyers authorized.</p></section>`;
    }
    return `<section class="card"><div class="row" style="justify-content:space-between"><h3>Negotiation</h3><span class="pill">${q.negotiation.engine === 'llm' ? 'Claude agents' : 'Rule-based agents'}</span></div><div class="transcript" id="transcript"></div></section>`;
  }

  function bubble(t) {
    const cls = t.speaker === 'buyer_agent' ? 'buyer' : t.speaker === 'merchant_agent' ? 'merchant' : 'system';
    const who = cls === 'buyer' ? 'Buyer agent' : cls === 'merchant' ? `${esc(state.quorum.merchant.name)} agent` : 'Quorum';
    const tools = (t.tools || []).map((x) => `<span class="pill" title="${esc(x.summary)}">PayPal tool: ${esc(x.name)}</span>`).join('');
    return `<div class="bubble ${cls}"><div class="who">${who}</div>${esc(t.message)}${t.offer && cls !== 'system' ? `<div class="offer">${money(t.offer)}</div>` : ''}${t.rejected ? `<div class="rejected">${esc(t.rejected)}</div>` : ''}${tools ? `<div class="tools">${tools}</div>` : ''}</div>`;
  }

  // Reveal turns one by one the first time this session sees them (it reads like a live exchange).
  function tickNegotiation(q) {
    const el = document.getElementById('transcript');
    if (!el || !q.negotiation) return;
    const turns = q.negotiation.turns;
    if (revealed === -1) {
      const recentlyClosed = q.closedAt && Date.now() - Date.parse(q.closedAt) < 60_000;
      revealed = recentlyClosed ? 0 : turns.length;
      if (recentlyClosed) step();
    }
    el.innerHTML = turns.slice(0, revealed).map(bubble).join('');
    function step() {
      if (revealed >= turns.length) return;
      revealed++;
      const t = document.getElementById('transcript');
      if (t) t.innerHTML = turns.slice(0, revealed).map(bubble).join('');
      setTimeout(step, 1100);
    }
  }

  function marketCard(q) {
    if (!q.market.length) return '';
    return `<section class="card"><h3>Market check</h3><p class="muted small">Live prices from Channel3. The buyer agent uses the cheapest one as leverage.</p><ul class="market">${q.market
      .slice(0, 5)
      .map((m) => `<li><span>${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener nofollow">${esc(m.title)}</a>` : esc(m.title)} <span class="muted small">· ${esc(m.merchant)}</span></span><b>${money(m.price)}</b></li>`)
      .join('')}</ul></section>`;
  }

  function agentCard() {
    const log = state.agentLog || [];
    if (!log.length) return '';
    return `<section class="card"><h3>Why agents decided what they did</h3><ul class="log">${log
      .slice(-8)
      .map((l) => `<li><b>${esc(l.agent)}</b> · ${esc(l.decision)} <span class="muted">— ${esc(l.reason)}</span> <span class="pill">${esc(l.engine)}</span></li>`)
      .join('')}</ul></section>`;
  }

  function renderSide(q, me) {
    let html = '';
    if (me && (me.status === 'authorized' || me.status === 'captured')) {
      html += `<section class="card side-card">
        <p class="eyebrow">You're in</p>
        <h3>${me.status === 'captured' ? `Paid ${money(me.captured)}` : `PayPal is holding ${money(me.authorized)}`}</h3>
        <p class="muted">${me.status === 'captured' ? 'The group formed and you paid the negotiated price.' : `Nothing has been charged. If the group forms you pay the final group price, never more than ${money(me.authorized)}. If it doesn't, the hold is released.`}</p>
      </section>`;
      if (q.status === 'open') html += inviteShell();
    } else if (q.status === 'open') {
      const saved = store.get('quorum:email') || '';
      html += `<section class="card side-card">
        <p class="eyebrow">Join this group</p>
        <h3>Commit now, pay only if it forms</h3>
        <p class="muted small">PayPal authorizes up to ${money(q.product.listPrice)} and charges nothing today. When the group closes you pay the negotiated group price${q.goalReached ? ` (${money(q.currentPrice)} or less)` : ''}.</p>
        <label for="commit-email">Your email</label>
        <input id="commit-email" type="email" value="${esc(saved)}" placeholder="you@example.com" autocomplete="email">
        <div class="paypal-slot" id="paypal-slot"></div>
        ${window.QUORUM.paypalMode === 'mock' ? '<p class="muted small">PayPal is in simulation mode on this server: no sandbox credentials are set.</p>' : ''}
      </section>`;
    } else if (q.status === 'closed' || q.status === 'failed') {
      html += `<section class="card side-card"><h3>Want something else?</h3><p class="muted">Describe it and an agent will find or start a group.</p><a class="btn btn-primary" href="/">Start a request</a></section>`;
    }
    if (state.admin && (q.status === 'open' || q.status === 'negotiating' || q.status === 'settling')) {
      html += `<section class="card side-card admin"><p class="eyebrow">Demo controls</p>
        <div class="row"><button class="btn btn-small" id="sim-buyer">Add simulated buyer</button><button class="btn btn-small btn-danger" id="force-close">Close group now</button></div>
        <p class="muted small" style="margin-top:.5rem">Visible because DEMO_ADMIN=true. Closing runs negotiation and capture (or void) immediately.</p></section>`;
    }
    side.innerHTML = html;
    wireSide(q, me);
  }

  function inviteShell() {
    return `<section class="card side-card" id="invite-card"><p class="eyebrow">Grow the group</p><h3 id="invite-headline">Every new member lowers the price</h3>
      <div id="invite-body"><p class="muted small">Get a ready-to-send invite with your personal link.</p><button class="btn btn-primary" id="draft-invite">Draft my invite</button></div></section>`;
  }

  function wireSide(q, me) {
    const slot = document.getElementById('paypal-slot');
    if (slot) mountPayPal(slot);
    const draft = document.getElementById('draft-invite');
    if (draft) draft.onclick = () => draftInvite(me);
    const sim = document.getElementById('sim-buyer');
    if (sim) sim.onclick = async () => {
      sim.disabled = true;
      try { await api('POST', `/api/quorums/${encodeURIComponent(id)}/simulate-buyer`, { ref: me ? me.id : undefined }); toast('Simulated buyer added'); await load(); } catch (e) { toast(e.message); } finally { sim.disabled = false; }
    };
    const close = document.getElementById('force-close');
    if (close) close.onclick = async () => {
      close.disabled = true;
      close.textContent = 'Closing…';
      revealed = -1;
      try { await api('POST', `/api/quorums/${encodeURIComponent(id)}/settle`); await load(); } catch (e) { toast(e.message); close.disabled = false; }
    };
  }

  async function draftInvite(me) {
    const body = document.getElementById('invite-body');
    body.innerHTML = '<p class="muted">The growth agent is writing your invite…</p>';
    try {
      const inv = await api('POST', `/api/quorums/${encodeURIComponent(id)}/invite`, { commitmentId: me ? me.id : undefined });
      document.getElementById('invite-headline').textContent = inv.headline;
      body.innerHTML = `<div class="invite-box" id="invite-text">${esc(inv.message)}</div>
        <div class="row"><a class="btn btn-small" href="${esc(inv.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a><a class="btn btn-small" href="${esc(inv.email)}">Email</a><button class="btn btn-small" id="copy-invite">Copy</button></div>
        <p class="notice" style="margin-top:.8rem">${esc(inv.tip)}</p>`;
      document.getElementById('copy-invite').onclick = async () => {
        try { await navigator.clipboard.writeText(inv.message); toast('Invite copied'); } catch { toast('Copy failed: select the text instead'); }
      };
    } catch (e) {
      body.innerHTML = `<div class="notice notice-danger">${esc(e.message)}</div>`;
    }
  }

  const emailValue = () => (document.getElementById('commit-email') || {}).value || '';
  const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

  async function onAuthorized(orderId, commitmentId) {
    await api('POST', `/api/quorums/${encodeURIComponent(id)}/authorize`, { orderId });
    store.set(storeKey, commitmentId);
    store.set('quorum:email', emailValue());
    toast('You are in. PayPal is holding the payment; nothing was charged.');
    sideKey = '';
    await load();
  }

  async function startCheckout() {
    const email = emailValue();
    if (!validEmail(email)) throw new Error('Enter a valid email first');
    return api('POST', `/api/quorums/${encodeURIComponent(id)}/checkout`, { email, intentId: intentId || undefined, ref: ref || undefined });
  }

  function mountPayPal(slot) {
    if (window.QUORUM.paypalMode === 'mock') {
      slot.innerHTML = '<button class="btn btn-primary" style="width:100%" id="mock-pay">Commit with PayPal (simulated)</button>';
      document.getElementById('mock-pay').onclick = async () => {
        try {
          const r = await startCheckout();
          const popup = window.open(r.approveUrl, 'quorum-pay', 'width=480,height=640');
          const onMsg = async (ev) => {
            if (ev.origin !== location.origin || !ev.data || ev.data.orderId !== r.orderId) return;
            window.removeEventListener('message', onMsg);
            if (ev.data.type === 'quorum-mock-approved') {
              try { await onAuthorized(r.orderId, r.commitmentId); } catch (e) { toast(e.message); }
            } else toast('Payment cancelled');
          };
          window.addEventListener('message', onMsg);
          if (!popup) toast('Allow pop-ups to approve the payment');
        } catch (e) {
          toast(e.message);
        }
      };
      return;
    }
    // Real PayPal JS SDK, intent=authorize: the order is authorized, never captured at checkout.
    const render = () => {
      let pending = null;
      window.paypal
        .Buttons({
          style: { layout: 'vertical', shape: 'rect', label: 'paypal' },
          onClick: (_data, actions) => (validEmail(emailValue()) ? actions.resolve() : (toast('Enter a valid email first'), actions.reject())),
          createOrder: async () => {
            pending = await startCheckout();
            return pending.orderId;
          },
          onApprove: async (data) => {
            try { await onAuthorized(data.orderID, pending.commitmentId); } catch (e) { toast(e.message); }
          },
          onCancel: () => toast('Payment cancelled'),
          onError: (err) => toast(`PayPal error: ${err && err.message ? err.message : err}`),
        })
        .render(slot);
    };
    if (window.paypal) return render();
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(window.QUORUM.paypalClientId)}&currency=${encodeURIComponent(window.QUORUM.currency)}&intent=authorize&components=buttons`;
    s.onload = render;
    s.onerror = () => (slot.innerHTML = '<div class="notice notice-danger">Could not load PayPal. Check your connection or ad blocker.</div>');
    document.head.appendChild(s);
  }

  setInterval(() => {
    document.querySelectorAll('.countdown[data-closes]').forEach((el) => {
      if (state && state.quorum.status === 'open') el.textContent = timeLeft(el.dataset.closes);
    });
  }, 1000);

  load();
})();
