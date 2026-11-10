// Shared browser helpers (no framework).
(function () {
  const t = window.I18N.t;
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const money = (n) => {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (window.QUORUM && window.QUORUM.currency) || 'USD',
      maximumFractionDigits: v % 1 === 0 ? 0 : 2,
    }).format(v);
  };

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(t(data.error || `Request failed (${res.status})`));
    return data;
  }

  function timeLeft(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (ms <= 0) return t('closing…');
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${String(sec).padStart(2, '0')}s`;
    return `${m}m ${String(sec).padStart(2, '0')}s`;
  }

  function toast(msg, ms = 3200) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  const initial = (title) => esc(String(title || '?').trim().charAt(0).toUpperCase());

  const statusPill = (status) =>
    ({
      open: `<span class="pill pill-accent">${t('Open')}</span>`,
      negotiating: `<span class="pill pill-warn">${t('Negotiating')}</span>`,
      settling: `<span class="pill pill-warn">${t('Settling')}</span>`,
      closed: `<span class="pill pill-ok">${t('Closed · paid')}</span>`,
      failed: `<span class="pill">${t('Did not form')}</span>`,
    })[status] || `<span class="pill">${esc(status)}</span>`;

  /** Progress bar with a marker per discount tier. */
  function progressBar(q, mini) {
    const maxMin = Math.max(...q.tiers.map((x) => x.min), q.minMembers);
    const scale = maxMin + Math.max(1, Math.round(maxMin * 0.15));
    const pct = Math.min(100, (q.members / scale) * 100);
    const marks = q.tiers
      .filter((x) => x.min > 1)
      .map((x) => {
        const left = (x.min / scale) * 100;
        const reached = q.members >= x.min;
        return `<div class="tier-mark ${reached ? 'reached' : ''}" style="left:${left}%">${
          mini ? '' : `<span class="lbl">${money(x.price)}</span><span class="sub">${t('{n} buyers', { n: x.min })}</span>`
        }</div>`;
      })
      .join('');
    return `<div class="progress ${mini ? 'mini' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="${scale}" aria-valuenow="${q.members}" aria-label="${t('{n} buyers committed', { n: q.members })}"><div class="progress-fill" style="width:${pct}%"></div>${marks}</div>`;
  }

  window.Q = { esc, money, api, timeLeft, toast, initial, statusPill, progressBar, t, lang: window.I18N.lang };
})();
