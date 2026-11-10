// Merchant console: demand board with a pricing agent, catalog with private
// floor + volume tiers, groups, payout account and the buyer message outbox.
(function () {
  const { esc, money, api, toast, timeLeft, statusPill, t } = window.Q;
  const root = document.getElementById('merchant-root');
  let data = null;

  const tiersText = (tiers) => tiers.filter((x) => x.min > 1).map((x) => `${x.min}:${x.price}`).join(', ');
  const parseTiers = (s) =>
    String(s)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const [min, price] = x.split(':').map((v) => Number(v.trim().replace('$', '')));
        return { min, price };
      });

  async function load() {
    try {
      data = await api('GET', '/api/merchant');
      render();
    } catch (err) {
      root.innerHTML = `<div class="card"><h2>${t('Console unavailable')}</h2><p>${esc(err.message)}</p></div>`;
    }
  }

  function render() {
    const merchantOptions = data.merchants.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    const catOptions = data.categories.map((c) => `<option>${esc(c)}</option>`).join('');
    root.innerHTML = `
      <p class="eyebrow">${t('Merchant console')}</p>
      <h1>${t('Sell to groups that already committed')}</h1>
      <p class="lead muted">${t('Set a private floor and public volume tiers. Your agent negotiates within them. You only fulfil groups whose payments PayPal already holds.')}</p>
      <div class="console-grid">
        <section class="card">
          <div class="section-head"><h2>${t('Demand board')}</h2><span class="muted small">${t('Requests no product covers yet, grouped by the intent agent')}</span></div>
          ${
            data.demand.length
              ? `<div class="demand-list">${data.demand.map((d, i) => demandCard(d, i, merchantOptions, catOptions)).join('')}</div>`
              : `<p class="muted">${t('No unmet demand right now.')}</p>`
          }
        </section>

        <section class="card">
          <div class="section-head"><h2>${t('Your catalog')}</h2><span class="muted small">${t('Floor price is private: only your agent knows it')}</span></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>${t('Product')}</th><th>${t('List')}</th><th>${t('Floor (private)')}</th><th>${t('Tiers (buyers:price)')}</th><th>${t('Stock')}</th><th></th></tr></thead>
            <tbody>${data.products.map(productRow).join('')}</tbody>
          </table></div>
        </section>

        <section class="card">
          <div class="section-head"><h2>${t('Groups')}</h2><span class="muted small">${t('Open groups lock their tiers; buyers committed to them')}</span></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>${t('Product')}</th><th>${t('Status')}</th><th>${t('Committed')}</th><th>${t('Price now')}</th><th>${t('Final')}</th><th>${t('Closes')}</th></tr></thead>
            <tbody>${data.quorums.map(groupRow).join('') || `<tr><td colspan="6" class="muted">${t('No groups yet.')}</td></tr>`}</tbody>
          </table></div>
        </section>

        <section class="card">
          <div class="section-head"><h2>${t('Where you get paid')}</h2><span class="muted small">${data.payeeRouting ? t('Orders name this PayPal account as the payee') : t('Payee routing is off: payments settle in the platform account')}</span></div>
          <div class="payee-list">${data.merchants.map(payeeRow).join('')}</div>
        </section>

        ${
          data.notifications.length
            ? `<section class="card"><div class="section-head"><h2>${t('Messages sent to buyers')}</h2><span class="muted small">${t('Joined, charged, released, refunded, matched')}</span></div>
          <ul class="log">${data.notifications.map((n) => `<li><b>${esc(n.email)}</b> · ${esc(n.subject)} <span class="pill">${esc(n.status)}</span></li>`).join('')}</ul></section>`
            : ''
        }
      </div>`;
    wire();
  }

  function demandCard(d, i, merchantOptions, catOptions) {
    const suggestedList = d.medianMax ? Math.round(d.medianMax * 1.1) : '';
    const suggestedTier = d.medianMax ? Math.round(d.medianMax * 0.95) : '';
    return `<div class="demand" data-demand-card="${i}">
      <div class="row" style="justify-content:space-between"><span class="count">${d.count}</span><span class="pill">${esc(d.category)}</span></div>
      <h3 style="margin-top:.3rem">${esc(d.label)}</h3>
      <p class="muted small">${d.count === 1 ? t('request') : t('requests')}${d.medianMax ? ` · ${t('median max {price}', { price: money(d.medianMax) })}` : ''}${d.earliestDeadline ? ` · ${t('earliest deadline {date}', { date: esc(d.earliestDeadline) })}` : ''}</p>
      ${d.samples.map((s) => `<blockquote>${esc(s)}</blockquote>`).join('')}
      <div class="row" style="margin-top:.6rem"><button class="btn btn-small btn-primary" data-draft="${i}">${t('Draft an offer with the pricing agent')}</button></div>
      <div class="draft-note" data-draft-note="${i}"></div>
      <details><summary class="btn btn-small" style="margin-top:.5rem">${t('Create a group offer')}</summary>
        <form class="offer-form" data-demand="${i}">
          <div class="full"><label>${t('Product title')}</label><input name="title" required maxlength="120" value=""></div>
          <div><label>${t('Merchant')}</label><select name="merchantId">${merchantOptions}</select></div>
          <div><label>${t('Category')}</label><select name="category">${catOptions.replace(`<option>${esc(d.category)}</option>`, `<option selected>${esc(d.category)}</option>`)}</select></div>
          <div><label>${t('List price')}</label><input name="listPrice" type="number" min="1" step="0.01" required value="${suggestedList}"></div>
          <div><label>${t('Floor (private)')}</label><input name="floorPrice" type="number" min="1" step="0.01" required value="${d.medianMax ? Math.round(d.medianMax * 0.75) : ''}"></div>
          <div class="full"><label>${t('Tiers (buyers:price)')}</label><input name="tiers" required placeholder="3:${suggestedTier || 99}, 6:${suggestedTier ? Math.round(suggestedTier * 0.92) : 89}" value="${d.count > 1 ? `${Math.max(2, d.count)}:${suggestedTier}` : ''}"></div>
          <div><label>${t('Stock')}</label><input name="stock" type="number" min="0" value="20"></div>
          <div><label>${t('Open for (hours)')}</label><input name="hours" type="number" min="0.1" step="0.1" value="72"></div>
          <div class="full"><label>${t('Description')}</label><input name="description" maxlength="600" value=""></div>
          <div class="full"><label>${t('Keywords')}</label><input name="keywords" value="${esc(d.label)}"></div>
          <div class="full" style="margin-top:.8rem"><button class="btn btn-primary" type="submit">${t('Create product and open group')}</button></div>
        </form>
      </details>
    </div>`;
  }

  function productRow(p) {
    return `<tr data-product="${esc(p.id)}">
      <td><b>${esc(p.title)}</b><br><span class="muted small">${esc(p.category)}${p.active ? '' : ` · ${t('inactive')}`}</span></td>
      <td>${money(p.listPrice)}</td>
      <td><input name="floorPrice" type="number" min="1" step="0.01" value="${p.floorPrice}" aria-label="${t('Floor (private)')}: ${esc(p.title)}"></td>
      <td><input name="tiers" value="${esc(tiersText(p.tiers))}" ${p.openQuorumId ? `disabled title="${t('Locked while a group is open')}"` : ''} aria-label="${t('Tiers (buyers:price)')}: ${esc(p.title)}"></td>
      <td><input name="stock" type="number" min="0" value="${p.stock}" aria-label="${t('Stock')}: ${esc(p.title)}"></td>
      <td><div class="row" style="flex-wrap:nowrap"><button class="btn btn-small" data-save="${esc(p.id)}">${t('Save')}</button>${
        p.openQuorumId
          ? `<a class="btn btn-small btn-ghost" href="/q/${esc(p.openQuorumId)}">${t('See group')}</a>`
          : `<button class="btn btn-small btn-ghost" data-open="${esc(p.id)}">${t('Open group')}</button>`
      }</div></td>
    </tr>`;
  }

  function groupRow(q) {
    return `<tr>
      <td><a href="/q/${esc(q.id)}">${esc(q.product.title)}</a></td>
      <td>${statusPill(q.status)}</td>
      <td>${q.members} / ${q.minMembers}</td>
      <td>${money(q.currentPrice)}</td>
      <td>${q.finalPrice ? money(q.finalPrice) : '—'}</td>
      <td class="muted small">${q.status === 'open' ? timeLeft(q.closesAt) : esc((q.closedAt || '').slice(0, 16).replace('T', ' '))}</td>
    </tr>`;
  }

  function payeeRow(m) {
    return `<div class="payee-row" data-merchant="${esc(m.id)}">
      <b>${esc(m.name)}</b>
      <input name="paypalEmail" type="email" placeholder="merchant@business.example.com" value="${esc(m.paypal_email || '')}" aria-label="${t('PayPal email')}: ${esc(m.name)}">
      <button class="btn btn-small" data-payee="${esc(m.id)}">${t('Save')}</button>
    </div>`;
  }

  async function draftOffer(i, btn) {
    const d = data.demand[i];
    const note = root.querySelector(`[data-draft-note="${i}"]`);
    btn.disabled = true;
    btn.textContent = t('The pricing agent is reading demand and market prices…');
    try {
      const { draft } = await api('POST', '/api/merchant/demand/draft', { intentIds: d.intentIds });
      const card = root.querySelector(`[data-demand-card="${i}"]`);
      const form = card.querySelector('form');
      const set = (name, value) => { form.querySelector(`[name=${name}]`).value = value; };
      set('title', draft.title);
      set('listPrice', draft.listPrice);
      set('floorPrice', draft.floorPrice);
      set('tiers', draft.tiers.map((x) => `${x.min}:${x.price}`).join(', '));
      set('hours', draft.hours);
      set('description', draft.description);
      set('keywords', draft.keywords);
      form.querySelector('[name=category]').value = draft.category;
      card.querySelector('details').open = true;
      const comps = draft.market.length
        ? `<ul class="market">${draft.market.slice(0, 3).map((m) => `<li><span>${esc(m.title)} <span class="muted small">· ${esc(m.merchant)}</span></span><b>${money(m.price)}</b></li>`).join('')}</ul>`
        : '';
      note.innerHTML = `<div class="notice"><b>${draft.engine === 'llm' ? t('Pricing agent (Claude)') : t('Pricing agent (rules)')}</b> · ${esc(draft.rationale)}
        <p style="margin:.5rem 0 0"><b>${t('{reach} of {count} waiting buyers can afford the goal price of {price}.', { reach: draft.reach, count: d.count, price: money(draft.tiers[0].price) })}</b> ${t('Review the numbers below, especially the floor, before publishing.')}</p>${comps}</div>`;
    } catch (e) {
      note.innerHTML = `<div class="notice notice-danger">${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = t('Draft an offer with the pricing agent');
    }
  }

  function wire() {
    root.querySelectorAll('[data-draft]').forEach((b) => b.addEventListener('click', () => draftOffer(Number(b.dataset.draft), b)));
    root.querySelectorAll('[data-payee]').forEach((b) =>
      b.addEventListener('click', async () => {
        const row = b.closest('[data-merchant]');
        try {
          await api('PUT', `/api/merchant/merchants/${encodeURIComponent(b.dataset.payee)}`, { paypalEmail: row.querySelector('[name=paypalEmail]').value });
          toast(t('Saved'));
        } catch (e) {
          toast(e.message);
        }
      }),
    );
    root.querySelectorAll('[data-save]').forEach((b) =>
      b.addEventListener('click', async () => {
        const row = b.closest('tr');
        const body = {
          floorPrice: Number(row.querySelector('[name=floorPrice]').value),
          stock: Number(row.querySelector('[name=stock]').value),
        };
        const tiersInput = row.querySelector('[name=tiers]');
        if (!tiersInput.disabled) body.tiers = parseTiers(tiersInput.value);
        try {
          await api('PUT', `/api/merchant/products/${encodeURIComponent(b.dataset.save)}`, body);
          toast(t('Saved'));
          load();
        } catch (e) {
          toast(e.message);
        }
      }),
    );
    root.querySelectorAll('[data-open]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          const r = await api('POST', `/api/merchant/products/${encodeURIComponent(b.dataset.open)}/open-group`, {});
          toast(r.attachedIntents ? t('Group opened; {n} waiting requests matched', { n: r.attachedIntents }) : t('Group opened'));
          load();
        } catch (e) {
          toast(e.message);
        }
      }),
    );
    root.querySelectorAll('form[data-demand]').forEach((f) =>
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(f);
        const body = Object.fromEntries(fd.entries());
        body.tiers = parseTiers(body.tiers);
        body.openGroup = true;
        try {
          const r = await api('POST', '/api/merchant/products', body);
          toast(t('Group opened; {n} waiting requests matched', { n: r.attachedIntents }));
          if (r.quorumId) location.href = `/q/${encodeURIComponent(r.quorumId)}`;
        } catch (e) {
          toast(e.message);
        }
      }),
    );
  }

  load();
})();
