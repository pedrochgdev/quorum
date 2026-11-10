// Group page: live progress, commit with PayPal (authorize only), invites,
// the negotiation as it happens, and how the final price was reached.
(function () {
  const { esc, money, api, timeLeft, toast, initial, statusPill, progressBar, t, lang } = window.Q;
  const root = document.getElementById('quorum-root');
  const id = root.dataset.quorumId;
  const params = new URLSearchParams(location.search);
  const intentId = params.get('intent');
  const ref = params.get('ref');
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };
  const cmtKey = `quorum:cmt:${id}`;
  const tokKey = `quorum:tok:${id}`;

  let state = null;
  let sideKey = '';
  let revealed = -1; // negotiation turns shown so far (-1 = not decided yet)
  let revealTimer = null;
  let pollTimer = null;
  let live = false;

  root.innerHTML = `<div class="quorum-layout"><div class="quorum-main" id="main"></div><aside class="quorum-side" id="side"></aside></div>`;
  const main = document.getElementById('main');
  const side = document.getElementById('side');

  const mine = () => {
    const cid = store.get(cmtKey);
    return cid && state ? state.quorum.commitments.find((c) => c.id === cid) : null;
  };
  const remember = (commitmentId, token) => {
    store.set(cmtKey, commitmentId);
    if (token) store.set(tokKey, token);
  };

  // ---- Data: Server-Sent Events, with polling as a safety net ----------------------
  async function load() {
    try {
      state = await api('GET', `/api/quorums/${encodeURIComponent(id)}`);
      render();
    } catch (err) {
      if (!state) {
        main.innerHTML = `<div class="card"><h2>${t('Group not found')}</h2><p>${esc(err.message)}</p><a href="/">${t('Back to start')}</a></div>`;
        side.innerHTML = '';
      }
    } finally {
      clearTimeout(pollTimer);
      const s = state && state.quorum.status;
      const busy = s === 'negotiating' || s === 'settling';
      pollTimer = setTimeout(load, live ? 20000 : busy ? 1500 : 4000);
    }
  }

  function connect() {
    if (!window.EventSource) return;
    const es = new EventSource(`/api/quorums/${encodeURIComponent(id)}/stream`);
    es.onmessage = (ev) => {
      live = true;
      try {
        state = JSON.parse(ev.data);
        render();
      } catch {}
    };
    es.onerror = () => { live = false; }; // EventSource reconnects on its own; polling covers the gap
  }

  function goalPrice(q) {
    return (q.tiers.find((x) => x.min === q.minMembers) || {}).price;
  }

  // ---- Negotiation transcript --------------------------------------------------------
  const negotiating = (q) => q.status === 'negotiating' || (q.negotiation && q.negotiation.status !== 'agreed');
  const revealPending = (q) => Boolean(q.negotiation) && revealed >= 0 && revealed < q.negotiation.turns.length;

  function scheduleReveal() {
    if (revealTimer || !state) return;
    const q = state.quorum;
    if (!q.negotiation) return;
    const turns = q.negotiation.turns;
    if (revealed === -1) {
      // An old, finished negotiation is shown at once; a fresh one plays turn by turn.
      const old = q.negotiation.status === 'agreed' && q.closedAt && Date.now() - Date.parse(q.closedAt) > 60_000;
      revealed = old ? turns.length : 0;
    }
    if (revealed >= turns.length) return;
    revealTimer = setTimeout(() => {
      revealTimer = null;
      revealed = Math.min(revealed + 1, state.quorum.negotiation ? state.quorum.negotiation.turns.length : revealed);
      render();
    }, revealed === 0 ? 350 : 1200);
  }

  function bubble(turn) {
    const cls = turn.speaker === 'buyer_agent' ? 'buyer' : turn.speaker === 'merchant_agent' ? 'merchant' : 'system';
    const who = cls === 'buyer' ? t('Buyer agent') : cls === 'merchant' ? t('{merchant} agent', { merchant: esc(state.quorum.merchant.name) }) : 'Quorum';
    const tools = (turn.tools || []).map((x) => `<span class="pill tool-pill" title="${esc(x.summary)}">${esc(x.name)}</span>`).join('');
    const toolLine = tools ? `<div class="tools"><span class="muted small">${t('Checked first on {source}:', { source: esc(turn.toolSource || 'PayPal') })}</span> ${tools}</div>` : '';
    return `<div class="bubble ${cls}"><div class="who">${who}</div>${toolLine}${esc(turn.message)}${turn.offer && cls !== 'system' ? `<div class="offer">${money(turn.offer)}</div>` : ''}${turn.rejected ? `<div class="rejected">${esc(turn.rejected)}</div>` : ''}</div>`;
  }

  function typingBubble(q) {
    const n = q.negotiation;
    const shown = Math.max(0, revealed);
    let cls = shown % 2 === 0 ? 'buyer' : 'merchant';
    let label = cls === 'buyer' ? t('Buyer agent is writing…') : t('{merchant} agent is writing…', { merchant: esc(q.merchant.name) });
    if (!n || n.status === 'briefing') {
      cls = 'merchant';
      label = t('{merchant} agent is reading its PayPal account before negotiating…', { merchant: esc(q.merchant.name) });
    }
    return `<div class="bubble ${cls} typing"><div class="who">${label}</div><span class="dots"><i></i><i></i><i></i></span></div>`;
  }

  function negotiationCard(q) {
    const n = q.negotiation;
    if (!n && q.status === 'open') {
      return `<section class="card"><h3>${t('Negotiation')}</h3><p class="muted">${t("When the group closes with at least {n} buyers, the buyer agent negotiates with the merchant agent. Every offer passes Quorum's rules: never below the merchant's floor, never above what buyers authorized.", { n: q.minMembers })}</p></section>`;
    }
    if (!n && q.status !== 'negotiating') return '';
    const turns = n ? n.turns.slice(0, Math.max(0, revealed)) : [];
    const more = negotiating(q) || revealPending(q);
    const engine = n && n.engine === 'llm' ? t('Claude agents') : n && n.engine === 'heuristic' ? t('Rule-based agents') : t('Live');
    return `<section class="card"><div class="row" style="justify-content:space-between"><h3>${t('Negotiation')}</h3><span class="pill ${more ? 'pill-warn' : ''}">${more ? `<span class="live-dot"></span>${t('Live')}` : engine}</span></div>
      <div class="transcript" id="transcript">${turns.map(bubble).join('')}${more ? typingBubble(q) : ''}</div></section>`;
  }

  // ---- How the price was reached -----------------------------------------------------
  function priceCard(q) {
    const px = q.priceExplain;
    const done = q.finalPrice !== null && !revealPending(q) && !negotiating(q);
    const rows = [{ label: t('List price, buying alone'), value: px.listPrice, cls: 'list' }];
    if (q.members >= q.minMembers || done) rows.push({ label: t('Public group price for {n} buyers', { n: q.members }), value: px.tierPrice, cls: 'tier' });
    else rows.push({ label: t('Public group price once {n} commit', { n: q.minMembers }), value: goalPrice(q), cls: 'tier' });
    if (done && px.negotiatedPrice !== null) rows.push({ label: t('Negotiated by the agents'), value: px.negotiatedPrice, cls: 'deal' });
    if (done && px.negotiatedPrice !== null && q.finalPrice < px.negotiatedPrice) rows.push({ label: t('After late buyers unlocked a cheaper tier'), value: q.finalPrice, cls: 'deal' });
    const bars = rows
      .map((r, i) => {
        const pct = Math.max(8, (r.value / px.listPrice) * 100);
        const prev = i > 0 ? rows[i - 1].value : null;
        const delta = prev !== null && r.value < prev ? `<span class="delta">−${money(prev - r.value)}</span>` : '';
        return `<div class="ladder-row ${r.cls}"><span class="ladder-label">${r.label}</span><span class="ladder-track"><span class="ladder-bar" style="width:${pct}%"></span></span><span class="ladder-value">${money(r.value)}${delta}</span></div>`;
      })
      .join('');

    const facts = [];
    if (px.lowestAuthorization !== null) facts.push(t('Ceiling: the lowest PayPal authorization in the group is {amount}. No one can be charged more than they authorized.', { amount: `<b>${money(px.lowestAuthorization)}</b>` }));
    facts.push(
      done
        ? t("Floor: the merchant's lowest acceptable price is private. Code rejects any offer below it; {n} offers were rejected in this negotiation.", { n: `<b>${px.offersRejectedByRules}</b>` })
        : t("Floor: the merchant's lowest acceptable price is private. Code rejects any offer below it."),
    );
    if (px.marketBest) facts.push(t('Market: the cheapest comparable offer found is {price} at {shop} (Channel3). The buyer agent uses it as leverage.', { price: `<b>${money(px.marketBest.price)}</b>`, shop: esc(px.marketBest.merchant) }));
    if (px.refundedTotal > 0) facts.push(t('Refunds: {amount} went back to earlier buyers through PayPal when the price dropped.', { amount: `<b>${money(px.refundedTotal)}</b>` }));
    if (done) {
      const save = px.listPrice - q.finalPrice;
      facts.push(t('Result: each buyer saved {amount} ({pct}%) against the list price.', { amount: `<b>${money(save)}</b>`, pct: Math.round((save / px.listPrice) * 100) }));
    }
    return `<section class="card"><h3>${done ? t('How this price was reached') : t('How the price is decided')}</h3>
      <div class="ladder">${bars}</div>
      <ul class="facts">${facts.map((f) => `<li>${f}</li>`).join('')}</ul></section>`;
  }

  // ---- Main column -------------------------------------------------------------------
  function render() {
    const q = state.quorum;
    const me = mine();
    const settled = q.finalPrice !== null && !revealPending(q) && !negotiating(q);
    const shownPrice = settled ? q.finalPrice : q.goalReached || q.status !== 'open' ? q.currentPrice : goalPrice(q);
    const priceNote = settled
      ? t('Final price')
      : q.goalReached || q.status !== 'open'
        ? t('Group price now, before negotiation')
        : t('Group price once {n} commit', { n: q.minMembers });

    let banner = '';
    if (q.status === 'closed' && settled) {
      const paid = me && me.status === 'captured'
        ? `<p><b>${t('You paid {paid}', { paid: money(me.paid) })}</b> ${t('(you had authorized {amount}).', { amount: money(me.authorized) })}${me.refunded > 0 ? ` ${t('{amount} was refunded when the price dropped.', { amount: money(me.refunded) })}` : ''}</p>`
        : '';
      const count = q.commitments.filter((c) => c.status === 'captured').length;
      banner = `<div class="result-banner ok"><h2>${t('The group formed. Everyone paid {price}.', { price: money(q.finalPrice) })}</h2>
        <p>${t('{n} buyers, {saved} below the {list} list price each.', { n: count, saved: money(q.product.listPrice - q.finalPrice), list: money(q.product.listPrice) })}${q.priceExplain.refundedTotal > 0 ? ` ${t('Late buyers unlocked a cheaper tier, so earlier buyers were refunded the difference.')}` : ''}</p>${paid}</div>`;
    } else if (q.status === 'failed') {
      banner = `<div class="result-banner fail"><h2>${t('This group did not form')}</h2><p>${t('It reached {n} of {goal} buyers. Every PayPal authorization was voided; nobody was charged.', { n: q.members, goal: q.minMembers })}</p><a class="btn btn-small" href="/">${t('Start another request')}</a></div>`;
    } else if (q.status !== 'open') {
      banner = `<div class="notice notice-warn"><b>${t('Goal reached.')}</b> ${t("The buyer agent is negotiating with {merchant}'s agent. Payments are captured right after.", { merchant: esc(q.merchant.name) })}</div>`;
    }

    const saving = q.product.listPrice - shownPrice;
    main.innerHTML = `
      ${banner}
      <section class="card">
        <div class="product-head">
          <div class="art art-${esc(q.product.category)}">${initial(q.product.title)}</div>
          <div>
            <div class="row" style="margin-bottom:.4rem">${statusPill(q.status)}<span class="muted small">${t('Sold by {merchant}', { merchant: esc(q.merchant.name) })}</span>${live ? `<span class="pill"><span class="live-dot"></span>${t('Live')}</span>` : ''}</div>
            <h1 style="font-size:1.9rem">${esc(q.product.title)}</h1>
            <p class="muted">${esc(q.product.description)}</p>
            <div class="big-price">${money(shownPrice)}<span class="strike">${money(q.product.listPrice)}</span></div>
            <p class="muted small" style="margin-top:.35rem">${priceNote}</p>
          </div>
        </div>
        ${progressBar(q, false)}
        <div class="stats">
          <div class="stat"><b>${q.members} / ${q.minMembers}</b><span>${t('committed / goal')}</span></div>
          <div class="stat"><b class="countdown" data-closes="${esc(q.closesAt)}">${q.status === 'open' ? timeLeft(q.closesAt) : '—'}</b><span>${q.status === 'open' ? t('left to join') : t('closed')}</span></div>
          <div class="stat"><b>${saving > 0 ? money(saving) : '—'}</b><span>${t('saved per buyer')}</span></div>
        </div>
      </section>

      ${negotiationCard(q)}
      ${priceCard(q)}

      <section class="card">
        <h3>${t('Price tiers')}</h3>
        <table class="tier-table"><thead><tr><th>${t('Buyers')}</th><th>${t('Price each')}</th><th>${t('Saving')}</th></tr></thead><tbody>
          ${q.tiers.map((x) => `<tr class="${q.currentPrice === x.price && x.min <= q.members ? 'current' : ''}"><td>${x.min === 1 ? t('Alone') : `${x.min}+`}</td><td>${money(x.price)}</td><td>${x.price < q.product.listPrice ? money(q.product.listPrice - x.price) : '—'}</td></tr>`).join('')}
        </tbody></table>
        <p class="muted small" style="margin-top:.6rem">${t('The merchant agent may go below the tier price when it negotiates. It is never above it.')}</p>
      </section>

      <section class="card">
        <h3>${t("Who's in")}</h3>
        <div class="members">${
          q.commitments.filter((c) => c.status !== 'created').map((c) => `<span class="member ${c.provider === 'mock' ? 'sim' : ''} ${c.status === 'voided' ? 'gone' : ''}" title="${esc(c.status)}${c.provider === 'mock' ? ` · ${t('simulated buyer')}` : ''}"><span class="avatar">${initial(c.name)}</span>${esc(c.name)}${memberBadge(c, settled)}</span>`).join('') || `<span class="muted">${t('Nobody yet. Be the first.')}</span>`
        }</div>
        ${q.commitments.some((c) => c.provider === 'mock') ? `<p class="muted small" style="margin-top:.6rem">${t('Grey avatars are simulated demo buyers.')}</p>` : ''}
      </section>

      ${marketCard(q)}
      ${agentCard()}
      ${outboxCard()}
    `;

    const key = `${q.status}|${settled}|${me ? me.status : 'none'}|${state.admin}|${q.lateJoin.open}|${q.lateJoin.price}|${q.lateJoin.nextDrop ? q.lateJoin.nextDrop.needed : ''}`;
    if (key !== sideKey) {
      sideKey = key;
      renderSide(q, me, settled);
    }
    const tr = document.getElementById('transcript');
    if (tr && (negotiating(q) || revealPending(q))) tr.lastElementChild && tr.lastElementChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    scheduleReveal();
  }

  function memberBadge(c, settled) {
    if (c.status === 'captured' && settled) return ` <span class="pill pill-ok">${t('paid {paid}', { paid: money(c.paid) })}</span>${c.refunded > 0 ? ` <span class="pill pill-accent">${t('{amount} back', { amount: money(c.refunded) })}</span>` : ''}${c.late ? ` <span class="pill">${t('late')}</span>` : ''}`;
    if (c.status === 'voided') return ` <span class="pill">${t('released')}</span>`;
    if (c.status === 'failed') return ` <span class="pill pill-danger">${t('failed')}</span>`;
    return '';
  }

  function marketCard(q) {
    if (!q.market.length) return '';
    return `<section class="card"><h3>${t('Market check')}</h3><p class="muted small">${t('Comparable live offers from Channel3. The buyer agent uses the cheapest one as leverage.')}</p><ul class="market">${q.market
      .slice(0, 5)
      .map((m) => `<li><span>${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener nofollow">${esc(m.title)}</a>` : esc(m.title)} <span class="muted small">· ${esc(m.merchant)}</span></span><b>${money(m.price)}</b></li>`)
      .join('')}</ul></section>`;
  }

  function agentCard() {
    const log = state.agentLog || [];
    if (!log.length) return '';
    return `<section class="card"><h3>${t('Why agents decided what they did')}</h3><ul class="log">${log
      .slice(-8)
      .map((l) => `<li><b>${esc(l.agent)}</b> · ${esc(l.decision)} <span class="muted">— ${esc(l.reason)}</span> <span class="pill">${esc(l.engine)}</span></li>`)
      .join('')}</ul></section>`;
  }

  function outboxCard() {
    const list = state.notifications || [];
    if (!state.admin || !list.length) return '';
    return `<section class="card admin"><p class="eyebrow">${t('Demo view')}</p><h3>${t('Messages sent to buyers')}</h3><ul class="log">${list
      .slice(0, 6)
      .map((n) => `<li><b>${esc(n.email)}</b> · ${esc(n.subject)} <span class="pill">${esc(n.status)}</span></li>`)
      .join('')}</ul></section>`;
  }

  // ---- Side column -------------------------------------------------------------------
  function renderSide(q, me, settled) {
    let html = '';
    const inGroup = me && (me.status === 'authorized' || me.status === 'captured');
    if (inGroup) {
      html += `<section class="card side-card">
        <p class="eyebrow">${t("You're in")}</p>
        <h3>${me.status === 'captured' ? t('Paid {paid}', { paid: money(me.paid) }) : t('PayPal is holding {amount}', { amount: money(me.authorized) })}</h3>
        <p class="muted">${me.status === 'captured' ? t('The group formed and you paid the final group price.') : t("Nothing has been charged. If the group forms you pay the final group price, never more than {amount}. If it doesn't, the hold is released.", { amount: money(me.authorized) })}</p>
        ${me.status === 'authorized' && q.status === 'open' && store.get(tokKey) ? `<button class="btn btn-small btn-ghost btn-danger" id="leave-group">${t('Leave the group')}</button>` : ''}
      </section>`;
      if (q.status === 'open') html += inviteShell();
    } else if (q.status === 'open') {
      html += joinCard(
        t('Join this group'),
        t('Commit now, pay only if it forms'),
        t('PayPal authorizes up to {list} and charges nothing today. When the group closes you pay the negotiated group price{hint}.', {
          list: money(q.product.listPrice),
          hint: q.goalReached ? ` (${t('{price} or less', { price: money(q.currentPrice) })})` : '',
        }),
      );
    } else if (q.status === 'closed' && q.lateJoin.open && settled) {
      const drop = q.lateJoin.nextDrop;
      html += joinCard(
        t('Still joinable'),
        t('Join late at {price}', { price: money(q.lateJoin.price) }),
        t('The group already formed, so PayPal charges {price} as soon as you approve.', { price: money(q.lateJoin.price) }) +
          (drop ? ` ${t('{n} more and the price drops to {price}: everyone already charged gets {refund} back.', { n: drop.needed, price: money(drop.price), refund: money(drop.refundEach) })}` : ''),
      );
    } else if (q.status === 'closed' || q.status === 'failed') {
      html += `<section class="card side-card"><h3>${t('Want something else?')}</h3><p class="muted">${t('Describe it and an agent will find or start a group.')}</p><a class="btn btn-primary" href="/">${t('Start a request')}</a></section>`;
    }
    if (inGroup && q.status === 'closed' && q.lateJoin.open && q.lateJoin.nextDrop) {
      const drop = q.lateJoin.nextDrop;
      html += `<section class="card side-card"><p class="eyebrow">${t('Price-drop guarantee')}</p><h3>${t('{n} more and you get {refund} back', { n: drop.needed, refund: money(drop.refundEach) })}</h3><p class="muted small">${t('The group stays open to late buyers. If it reaches the next tier, PayPal refunds the difference to everyone already charged.')}</p></section>`;
    }
    const lateAdmin = q.status === 'closed' && q.lateJoin.open;
    if (state.admin && (q.status !== 'failed' && (q.status !== 'closed' || lateAdmin))) {
      html += `<section class="card side-card admin"><p class="eyebrow">${t('Demo controls')}</p>
        <div class="row"><button class="btn btn-small" id="sim-buyer">${lateAdmin ? t('Add late buyer (simulated)') : t('Add simulated buyer')}</button>${lateAdmin ? '' : `<button class="btn btn-small btn-danger" id="force-close">${t('Close group now')}</button>`}</div>
        <p class="muted small" style="margin-top:.5rem">${t('Visible because DEMO_ADMIN=true. Closing runs negotiation and capture (or void) immediately.')}</p></section>`;
    }
    side.innerHTML = html;
    wireSide(q, me);
  }

  function joinCard(eyebrow, title, body) {
    const saved = store.get('quorum:email') || '';
    return `<section class="card side-card">
      <p class="eyebrow">${eyebrow}</p>
      <h3>${title}</h3>
      <p class="muted small">${body}</p>
      <label for="commit-email">${t('Your email')}</label>
      <input id="commit-email" type="email" value="${esc(saved)}" placeholder="you@example.com" autocomplete="email">
      <div class="paypal-slot" id="paypal-slot"></div>
      ${window.QUORUM.paypalMode === 'mock' ? `<p class="muted small">${t('PayPal is in simulation mode on this server: no sandbox credentials are set.')}</p>` : `<p class="muted small">${t('PayPal sandbox: approve with a sandbox personal account. No real money moves.')}</p>`}
    </section>`;
  }

  function inviteShell() {
    return `<section class="card side-card" id="invite-card"><p class="eyebrow">${t('Grow the group')}</p><h3 id="invite-headline">${t('Every new member lowers the price')}</h3>
      <div id="invite-body"><p class="muted small">${t('Get a ready-to-send invite with your personal link.')}</p><button class="btn btn-primary" id="draft-invite">${t('Draft my invite')}</button></div></section>`;
  }

  function wireSide(q, me) {
    const slot = document.getElementById('paypal-slot');
    if (slot) mountPayPal(slot);
    const draft = document.getElementById('draft-invite');
    if (draft) draft.onclick = () => draftInvite(me);
    const leave = document.getElementById('leave-group');
    if (leave) leave.onclick = async () => {
      if (!confirm(t('Leave this group? PayPal releases the hold and you are not charged.'))) return;
      leave.disabled = true;
      try {
        await api('POST', `/api/commitments/${encodeURIComponent(me.id)}/withdraw`, { token: store.get(tokKey) });
        store.del(cmtKey);
        store.del(tokKey);
        toast(t('You left the group. PayPal released the hold.'));
        sideKey = '';
        await load();
      } catch (e) { toast(e.message); leave.disabled = false; }
    };
    const sim = document.getElementById('sim-buyer');
    if (sim) sim.onclick = async () => {
      sim.disabled = true;
      try { await api('POST', `/api/quorums/${encodeURIComponent(id)}/simulate-buyer`, { ref: me ? me.id : undefined }); toast(t('Simulated buyer added')); await load(); } catch (e) { toast(e.message); } finally { sim.disabled = false; }
    };
    const close = document.getElementById('force-close');
    if (close) close.onclick = async () => {
      close.disabled = true;
      close.textContent = t('Closing…');
      revealed = 0;
      try { await api('POST', `/api/quorums/${encodeURIComponent(id)}/settle`); await load(); } catch (e) { toast(e.message); close.disabled = false; }
    };
  }

  async function draftInvite(me) {
    const body = document.getElementById('invite-body');
    body.innerHTML = `<p class="muted">${t('The growth agent is writing your invite…')}</p>`;
    try {
      const inv = await api('POST', `/api/quorums/${encodeURIComponent(id)}/invite`, { commitmentId: me ? me.id : undefined, lang });
      document.getElementById('invite-headline').textContent = inv.headline;
      body.innerHTML = `<div class="invite-box" id="invite-text">${esc(inv.message)}</div>
        <div class="row"><a class="btn btn-small" href="${esc(inv.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a><a class="btn btn-small" href="${esc(inv.email)}">${t('Email')}</a><button class="btn btn-small" id="copy-invite">${t('Copy')}</button></div>
        <p class="notice" style="margin-top:.8rem">${esc(inv.tip)}</p>`;
      document.getElementById('copy-invite').onclick = async () => {
        try { await navigator.clipboard.writeText(inv.message); toast(t('Invite copied')); } catch { toast(t('Copy failed: select the text instead')); }
      };
    } catch (e) {
      body.innerHTML = `<div class="notice notice-danger">${esc(e.message)}</div>`;
    }
  }

  // ---- Checkout ----------------------------------------------------------------------
  const emailValue = () => (document.getElementById('commit-email') || {}).value || '';
  const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

  async function onAuthorized(orderId) {
    const r = await api('POST', `/api/quorums/${encodeURIComponent(id)}/authorize`, { orderId });
    remember(r.commitmentId, r.token);
    if (emailValue()) store.set('quorum:email', emailValue());
    toast(r.status === 'captured' ? t('You are in. PayPal charged the final group price.') : t('You are in. PayPal is holding the payment; nothing was charged.'));
    sideKey = '';
    await load();
  }

  async function startCheckout() {
    const email = emailValue();
    if (!validEmail(email)) throw new Error(t('Enter a valid email first'));
    const r = await api('POST', `/api/quorums/${encodeURIComponent(id)}/checkout`, { email, intentId: intentId || undefined, ref: ref || undefined, lang });
    remember(r.commitmentId, r.token);
    return r;
  }

  function mountPayPal(slot) {
    if (window.QUORUM.paypalMode === 'mock') {
      slot.innerHTML = `<button class="btn btn-primary" style="width:100%" id="mock-pay">${t('Commit with PayPal (simulated)')}</button>`;
      document.getElementById('mock-pay').onclick = async () => {
        try {
          const r = await startCheckout();
          const popup = window.open(r.approveUrl, 'quorum-pay', 'width=480,height=640');
          const onMsg = async (ev) => {
            if (ev.origin !== location.origin || !ev.data || ev.data.orderId !== r.orderId) return;
            window.removeEventListener('message', onMsg);
            if (ev.data.type === 'quorum-mock-approved') {
              try { await onAuthorized(r.orderId); } catch (e) { toast(e.message); }
            } else toast(t('Payment cancelled'));
          };
          window.addEventListener('message', onMsg);
          if (!popup) toast(t('Allow pop-ups to approve the payment'));
        } catch (e) {
          toast(e.message);
        }
      };
      return;
    }
    // Real PayPal JS SDK, intent=authorize: the order is authorized, never captured at checkout.
    const render = () => {
      window.paypal
        .Buttons({
          style: { layout: 'vertical', shape: 'rect', label: 'paypal' },
          onClick: (_data, actions) => (validEmail(emailValue()) ? actions.resolve() : (toast(t('Enter a valid email first')), actions.reject())),
          createOrder: async () => (await startCheckout()).orderId,
          onApprove: async (data) => {
            try { await onAuthorized(data.orderID); } catch (e) { toast(e.message); }
          },
          onCancel: () => toast(t('Payment cancelled')),
          onError: (err) => toast(`PayPal: ${err && err.message ? err.message : err}`),
        })
        .render(slot);
    };
    if (window.paypal) return render();
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(window.QUORUM.paypalClientId)}&currency=${encodeURIComponent(window.QUORUM.currency)}&intent=authorize&components=buttons`;
    s.onload = render;
    s.onerror = () => (slot.innerHTML = `<div class="notice notice-danger">${t('Could not load PayPal. Check your connection or ad blocker.')}</div>`);
    document.head.appendChild(s);
  }

  // Returning from PayPal's approval page (redirect flow, or a link an agent sent): finish the authorization.
  async function finishReturn() {
    const orderId = params.get('token');
    if (!orderId) return;
    params.delete('token');
    params.delete('PayerID');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
    try { await onAuthorized(orderId); } catch (e) { toast(e.message); }
  }

  setInterval(() => {
    document.querySelectorAll('.countdown[data-closes]').forEach((el) => {
      if (state && state.quorum.status === 'open') el.textContent = timeLeft(el.dataset.closes);
    });
  }, 1000);

  load().then(finishReturn);
  if (params.get('live') !== '0') connect(); // ?live=0 falls back to polling (useful behind proxies that buffer streams)
})();
