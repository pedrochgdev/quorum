// Home page: submit an intent, list open groups.
(function () {
  const { esc, money, api, timeLeft, initial, statusPill, progressBar } = window.Q;
  const form = document.getElementById('intent-form');
  const text = document.getElementById('intent-text');
  const email = document.getElementById('intent-email');
  const out = document.getElementById('intent-result');

  document.querySelectorAll('[data-example]').forEach((b) =>
    b.addEventListener('click', () => {
      text.value = b.dataset.example;
      text.focus();
    }),
  );

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Reading your request…';
    out.innerHTML = '';
    try {
      const r = await api('POST', '/api/intents', { text: text.value, email: email.value || undefined });
      try { localStorage.setItem('quorum:email', email.value || ''); } catch {}
      const p = r.parsed || {};
      const chips = [
        p.category && `<span class="pill">${esc(p.category)}</span>`,
        p.max_price && `<span class="pill">max ${money(p.max_price)}</span>`,
        p.deadline && `<span class="pill">by ${esc(p.deadline)}</span>`,
        ...(p.must_have || []).slice(0, 4).map((m) => `<span class="pill">${esc(m)}</span>`),
      ].filter(Boolean).join('');
      if (r.quorumId) {
        out.innerHTML = `<div class="result-card">
          <h3>${r.outcome === 'opened' ? 'We opened a new group for you' : 'We found your group'}</h3>
          <div class="parsed">${chips}</div>
          <p>${esc(r.explanation)}</p>
          <a class="btn btn-primary" href="/q/${encodeURIComponent(r.quorumId)}?intent=${encodeURIComponent(r.intentId)}">See the group and commit</a>
        </div>`;
      } else {
        out.innerHTML = `<div class="result-card">
          <h3>You're on the demand board</h3>
          <div class="parsed">${chips}</div>
          <p>${esc(r.explanation)}</p>
          <p class="muted small">Merchants see requests like yours grouped together and can open a group for them.</p>
        </div>`;
      }
      loadGroups();
    } catch (err) {
      out.innerHTML = `<div class="notice notice-danger">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Find my group';
    }
  });

  async function loadGroups() {
    const grid = document.getElementById('group-grid');
    try {
      const { quorums } = await api('GET', '/api/quorums');
      const open = quorums.filter((q) => q.status === 'open');
      const recent = quorums.filter((q) => q.status !== 'open').slice(0, 3);
      const list = [...open, ...recent];
      if (!list.length) {
        grid.innerHTML = '<p class="muted">No groups yet. Describe what you want above to start one.</p>';
        return;
      }
      grid.innerHTML = list
        .map((q) => {
          const goalPrice = (q.tiers.find((t) => t.min === q.minMembers) || {}).price;
          const price = q.finalPrice ?? (q.goalReached ? q.currentPrice : goalPrice);
          return `<a class="card group-card" href="/q/${encodeURIComponent(q.id)}">
            <div class="art art-${esc(q.product.category)}">${initial(q.product.title)}</div>
            <div class="row" style="justify-content:space-between">${statusPill(q.status)}<span class="muted small countdown" data-closes="${esc(q.closesAt)}">${q.status === 'open' ? timeLeft(q.closesAt) : ''}</span></div>
            <h3>${esc(q.product.title)}</h3>
            <div><span class="price">${money(price)}</span><span class="strike">${money(q.product.listPrice)}</span></div>
            ${progressBar(q, true)}
            <span class="muted small">${q.members} of ${q.minMembers} committed · ${esc(q.merchant.name)}</span>
          </a>`;
        })
        .join('');
    } catch (err) {
      grid.innerHTML = `<p class="muted">Could not load groups: ${esc(err.message)}</p>`;
    }
  }

  setInterval(() => {
    document.querySelectorAll('.countdown[data-closes]').forEach((el) => {
      if (el.textContent) el.textContent = timeLeft(el.dataset.closes);
    });
  }, 1000);
  loadGroups();
  setInterval(loadGroups, 15000);
})();
