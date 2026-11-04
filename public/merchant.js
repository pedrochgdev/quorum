// Merchant console: demand board, catalog with private floor + volume tiers, groups.
(function () {
  const { esc, money, api, toast, timeLeft, statusPill } = window.Q;
  const root = document.getElementById('merchant-root');
  let data = null;

  const tiersText = (tiers) => tiers.filter((t) => t.min > 1).map((t) => `${t.min}:${t.price}`).join(', ');
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
      root.innerHTML = `<div class="card"><h2>Console unavailable</h2><p>${esc(err.message)}</p></div>`;
    }
  }

  function render() {
    const merchantOptions = data.merchants.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    const catOptions = data.categories.map((c) => `<option>${esc(c)}</option>`).join('');
    root.innerHTML = `
      <p class="eyebrow">Merchant console</p>
      <h1>Sell to groups that already committed</h1>
      <p class="lead muted">Set a private floor and public volume tiers. Your agent negotiates within them. You only fulfil groups whose payments PayPal already holds.</p>
      <div class="console-grid">
        <section class="card">
          <div class="section-head"><h2>Demand board</h2><span class="muted small">Requests no product covers yet, grouped by the intent agent</span></div>
          ${
            data.demand.length
              ? `<div class="demand-list">${data.demand.map((d, i) => demandCard(d, i, merchantOptions, catOptions)).join('')}</div>`
              : '<p class="muted">No unmet demand right now.</p>'
          }
        </section>

        <section class="card">
          <div class="section-head"><h2>Your catalog</h2><span class="muted small">Floor price is private: only your agent knows it</span></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Product</th><th>List</th><th>Floor (private)</th><th>Tiers (buyers:price)</th><th>Stock</th><th></th></tr></thead>
            <tbody>${data.products.map(productRow).join('')}</tbody>
          </table></div>
        </section>

        <section class="card">
          <div class="section-head"><h2>Groups</h2><span class="muted small">Open groups lock their tiers; buyers committed to them</span></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Product</th><th>Status</th><th>Committed</th><th>Price now</th><th>Final</th><th>Closes</th></tr></thead>
            <tbody>${data.quorums.map(groupRow).join('') || '<tr><td colspan="6" class="muted">No groups yet.</td></tr>'}</tbody>
          </table></div>
        </section>
      </div>`;
    wire();
  }

  function demandCard(d, i, merchantOptions, catOptions) {
    const suggestedList = d.medianMax ? Math.round(d.medianMax * 1.1) : '';
    const suggestedTier = d.medianMax ? Math.round(d.medianMax * 0.95) : '';
    return `<div class="demand">
      <div class="row" style="justify-content:space-between"><span class="count">${d.count}</span><span class="pill">${esc(d.category)}</span></div>
      <h3 style="margin-top:.3rem">${esc(d.label)}</h3>
      <p class="muted small">${d.count === 1 ? 'request' : 'requests'}${d.medianMax ? ` · median max ${money(d.medianMax)}` : ''}${d.earliestDeadline ? ` · earliest deadline ${esc(d.earliestDeadline)}` : ''}</p>
      ${d.samples.map((s) => `<blockquote>${esc(s)}</blockquote>`).join('')}
      <details><summary class="btn btn-small" style="margin-top:.5rem">Create a group offer</summary>
        <form class="offer-form" data-demand="${i}">
          <div class="full"><label>Product title</label><input name="title" required maxlength="120" value=""></div>
          <div><label>Merchant</label><select name="merchantId">${merchantOptions}</select></div>
          <div><label>Category</label><select name="category">${catOptions.replace(`<option>${esc(d.category)}</option>`, `<option selected>${esc(d.category)}</option>`)}</select></div>
          <div><label>List price</label><input name="listPrice" type="number" min="1" step="0.01" required value="${suggestedList}"></div>
          <div><label>Floor (private)</label><input name="floorPrice" type="number" min="1" step="0.01" required value="${d.medianMax ? Math.round(d.medianMax * 0.75) : ''}"></div>
          <div class="full"><label>Tiers (buyers:price)</label><input name="tiers" required placeholder="3:${suggestedTier || 99}, 6:${suggestedTier ? Math.round(suggestedTier * 0.92) : 89}" value="${d.count > 1 ? `${Math.max(2, d.count)}:${suggestedTier}` : ''}"></div>
          <div><label>Stock</label><input name="stock" type="number" min="0" value="20"></div>
          <div><label>Open for (hours)</label><input name="hours" type="number" min="0.1" step="0.1" value="72"></div>
          <div class="full"><label>Keywords</label><input name="keywords" value="${esc(d.label)}"></div>
          <div class="full" style="margin-top:.8rem"><button class="btn btn-primary" type="submit">Create product and open group</button></div>
        </form>
      </details>
    </div>`;
  }

  function productRow(p) {
    return `<tr data-product="${esc(p.id)}">
      <td><b>${esc(p.title)}</b><br><span class="muted small">${esc(p.category)}${p.active ? '' : ' · inactive'}</span></td>
      <td>${money(p.listPrice)}</td>
      <td><input name="floorPrice" type="number" min="1" step="0.01" value="${p.floorPrice}" aria-label="Floor price for ${esc(p.title)}"></td>
      <td><input name="tiers" value="${esc(tiersText(p.tiers))}" ${p.openQuorumId ? 'disabled title="Locked while a group is open"' : ''} aria-label="Tiers for ${esc(p.title)}"></td>
      <td><input name="stock" type="number" min="0" value="${p.stock}" aria-label="Stock for ${esc(p.title)}"></td>
      <td><div class="row" style="flex-wrap:nowrap"><button class="btn btn-small" data-save="${esc(p.id)}">Save</button>${
        p.openQuorumId
          ? `<a class="btn btn-small btn-ghost" href="/q/${esc(p.openQuorumId)}">Open group</a>`
          : `<button class="btn btn-small btn-ghost" data-open="${esc(p.id)}">Open group</button>`
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

  function wire() {
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
          toast('Saved');
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
          toast(`Group opened${r.attachedIntents ? `; ${r.attachedIntents} waiting requests matched` : ''}`);
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
          toast(`Group opened; ${r.attachedIntents} waiting ${r.attachedIntents === 1 ? 'request' : 'requests'} moved in`);
          if (r.quorumId) location.href = `/q/${encodeURIComponent(r.quorumId)}`;
        } catch (e) {
          toast(e.message);
        }
      }),
    );
  }

  load();
})();
