/* ==========================================================================
   Relay Admin Control Plane Controller (admin.js)
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  let state = null;
  let toastTimer = null;

  function showToast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-visible'), 2800);
  }

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function usd(n) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);
  }

  function statusBadge(status) {
    const map = {
      paid: ['badge--sky', 'Paid'],
      settled: ['badge--green', 'Settled'],
      active: ['badge--green', 'Active'],
      pending: ['badge--amber', 'Pending'],
      pending_payment: ['badge--amber', 'Awaiting Stripe'],
      paused: ['badge--amber', 'Paused'],
      refunded: ['badge--red', 'Refunded'],
      disputed: ['badge--red', 'Disputed'],
      rejected: ['badge--red', 'Rejected']
    };
    const [cls, label] = map[status] || ['badge--sky', status];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  }

  // ------------------------------------------------------------------------
  // Auth Gate
  // ------------------------------------------------------------------------
  $$('[data-gate-fill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#gate-email').value = btn.dataset.gateFill;
      $('#gate-password').value = btn.dataset.gatePass;
    });
  });

  $('#gate-login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#gate-error');
    err.hidden = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: $('#gate-email').value.trim(),
          password: $('#gate-password').value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      await initDashboard();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  function showDeskPath(path) {
    if (location.pathname !== path) history.replaceState({}, '', path);
  }

  async function signOut() {
    closeAccountMenu();
    await fetch('/api/auth/logout', { method: 'POST' });
    $('#app-shell').hidden = true;
    $('#auth-gate').hidden = false;
    showDeskPath('/login');
    showToast('Signed out.');
  }

  function closeAccountMenu() {
    const menu = $('#account-drop');
    const button = $('#account-btn');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  $('#account-btn')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = $('#account-drop');
    const open = menu.hidden;
    menu.hidden = !open;
    $('#account-btn').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.account-menu')) closeAccountMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAccountMenu();
  });
  $('#account-settings')?.addEventListener('click', () => {
    closeAccountMenu();
    switchView('settings');
  });
  $('#account-switch')?.addEventListener('click', signOut);
  $('#account-logout')?.addEventListener('click', signOut);
  $('#logout-btn')?.addEventListener('click', signOut);

  // ------------------------------------------------------------------------
  // Navigation Tabs
  // ------------------------------------------------------------------------
  const viewTitles = {
    overview: 'Overview',
    orders: 'Transactions & Webhooks',
    vendors: 'Vendors & Applications',
    payouts: 'Payout Settlement Queue',
    stripe: 'Stripe & Payment Rails',
    logins: 'Temporary Logins & Access',
    settings: 'Live Site Controls'
  };

  function switchView(view) {
    $$('.side-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
    $('#topbar-title').textContent = viewTitles[view] || 'Admin';
    if (view === 'logins') loadTempLogins();
  }

  $$('.side-btn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $$('[data-jump-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.jumpView)));

  // Live Stripe Plugin Test launcher inside Admin
  $('#admin-test-checkout-btn')?.addEventListener('click', () => {
    const vendor = state?.vendors?.find((v) => v.status === 'active') || state?.vendors?.[0];
    if (!vendor) {
      showToast('Approve a vendor first. Applications show up under Vendors.');
      return;
    }
    window.RelayCheckout.open({
      vendorId: vendor.id,
      item: 'Product',
      amountUsd: 99,
      rail: 'stripe',
      onSuccess: () => {
        showToast('Checkout recorded. Refreshing the ledger.');
        refreshOverview();
      }
    });
  });

  // ------------------------------------------------------------------------
  // Load & Render Overview + All Tables
  // ------------------------------------------------------------------------
  async function refreshOverview() {
    const res = await fetch('/api/admin/overview');
    if (res.status === 401) {
      $('#app-shell').hidden = true;
      $('#auth-gate').hidden = false;
      return false;
    }
    state = await res.json();
    const isAdmin = ['super_admin', 'admin', 'operator'].includes(state.user.role);

    $('#auth-gate').hidden = true;
    $('#app-shell').hidden = false;

    const firstName = String(state.user.name || 'Relay').split(' ')[0];
    $('#cur-user-name').textContent = firstName;
    const avatar = $('#user-avatar');
    if (avatar) avatar.textContent = firstName.slice(0, 1).toUpperCase();
    const meta = $('#cur-user-meta');
    if (meta) meta.textContent = state.user.email;
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(new Date()));
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    if ($('#welcome-title')) $('#welcome-title').textContent = `${greet}, ${firstName}`;
    if ($('#welcome-sub')) {
      $('#welcome-sub').textContent = isAdmin
        ? 'Sales, vendor applications, and crypto cashouts.'
        : 'Your sales, fees, and what is ready to cash out.';
    }
    $('#nav-logins').hidden = !isAdmin;
    $('#nav-settings').hidden = !isAdmin;
    $('#nav-vendors').hidden = !isAdmin;
    $('#nav-control').hidden = !isAdmin;
    $('#nav-control-label').hidden = !isAdmin;
    $('#add-vendor-panel').hidden = !isAdmin;
    $('#admin-test-checkout-btn').hidden = !isAdmin;
    $('#rails-panel').hidden = !isAdmin;
    $('#nav-payouts-label').textContent = 'Cashouts';
    $('#chart-title').textContent = isAdmin ? 'Volume' : 'Your sales';
    $('#kpi-gross-label').textContent = isAdmin ? 'Gross volume' : 'Your sales';
    $('#kpi-gross-sub').textContent = isAdmin ? 'Card, PayPal, wallets' : 'Paid through your checkout';
    $('#kpi-net-label').textContent = 'Relay fee';
    $('#kpi-net-sub').textContent = isAdmin ? 'Platform margin' : 'Taken from your sales';
    $('#kpi-pending-label').textContent = isAdmin ? 'Cashouts waiting' : 'Ready to cash out';
    $('#kpi-pending-sub').textContent = 'USDT / BTC';
    $('#kpi-vendors-label').textContent = isAdmin ? 'Vendors' : 'Orders';

    const modeBadgeText = state.stripe.mode === 'live' ? 'LIVE' : state.stripe.mode === 'test' ? 'TEST KEYS' : 'NOT CONNECTED';
    if ($('#sidebar-stripe-mode')) $('#sidebar-stripe-mode').textContent = modeBadgeText;
    const settingsItem = $('#account-settings');
    if (settingsItem) settingsItem.hidden = !isAdmin;
    if ($('#diag-mode-badge')) $('#diag-mode-badge').textContent = modeBadgeText;
    if ($('#mix-mode-badge')) $('#mix-mode-badge').textContent = modeBadgeText;

    // Counts
    $('#count-orders').textContent = state.orders.length;
    $('#count-vendors').textContent = state.vendors.length;
    $('#count-payouts').textContent = state.payouts.filter((p) => p.status === 'pending').length;

    // KPIs
    $('#kpi-gross').textContent = usd(state.kpis.grossVolume);
    $('#kpi-net').textContent = usd(state.kpis.netRevenue);
    $('#kpi-pending').textContent = usd(state.kpis.pendingPayouts);
    $('#kpi-vendors').textContent = isAdmin ? String(state.kpis.activeVendors) : String(state.orders.length);
    $('#kpi-vendors-sub').textContent = isAdmin ? `${state.kpis.pendingVendors} pending review` : 'On your ledger';

    renderChart();
    renderMix();
    renderQuickRails(isAdmin);
    renderOrders(isAdmin);
    renderVendors(isAdmin);
    renderPayouts(isAdmin);
    renderStripeDiag();
    renderSettingsForm();
    return true;
  }

  function smoothLine(points) {
    if (points.length < 2) return `M${points[0].x},${points[0].y}`;
    let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return d;
  }

  function renderChart() {
    const data = state.chart7d.length ? state.chart7d : [{ day: 'Today', volume: 0 }];
    const width = 720;
    const height = 248;
    const pad = { l: 12, r: 12, t: 28, b: 28 };
    const max = Math.max(...data.map((point) => point.volume), 1);
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    const points = data.map((point, index) => {
      const x = pad.l + (data.length === 1 ? innerW / 2 : (index / (data.length - 1)) * innerW);
      const y = pad.t + innerH - (point.volume / max) * (innerH - 6);
      return { ...point, x, y };
    });
    const line = smoothLine(points);
    const base = pad.t + innerH;
    const area = `${line} L${points[points.length - 1].x.toFixed(1)},${base} L${points[0].x.toFixed(1)},${base} Z`;
    const labels = points.map((point) => `<text x="${point.x}" y="${height - 8}" text-anchor="middle">${esc(point.day)}</text>`).join('');
    const host = $('#volume-chart');
    host.innerHTML = `
      <svg class="volume-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Volume over the last 7 days">
        <defs>
          <linearGradient id="volume-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#6ea2ff" stop-opacity="0.28" />
            <stop offset="100%" stop-color="#6ea2ff" stop-opacity="0" />
          </linearGradient>
        </defs>
        <line x1="${pad.l}" y1="${base}" x2="${width - pad.r}" y2="${base}" stroke="rgba(140,170,210,0.12)" />
        <path d="${area}" fill="url(#volume-fill)" />
        <path d="${line}" fill="none" stroke="#8eb4ff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <line id="chart-guide" x1="0" y1="${pad.t}" x2="0" y2="${base}" stroke="rgba(180,205,240,0.35)" stroke-dasharray="3 3" hidden />
        <circle id="chart-dot" r="4.5" fill="#dbe7ff" stroke="#07101c" stroke-width="2" hidden />
        ${labels}
      </svg>
      <div class="chart-tip" id="chart-tip" hidden></div>
    `;
    const svg = host.querySelector('svg');
    const tip = host.querySelector('#chart-tip');
    const guide = host.querySelector('#chart-guide');
    const dot = host.querySelector('#chart-dot');
    const focus = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * width;
      let nearest = points[0];
      points.forEach((point) => {
        if (Math.abs(point.x - x) < Math.abs(nearest.x - x)) nearest = point;
      });
      guide.removeAttribute('hidden');
      dot.removeAttribute('hidden');
      guide.setAttribute('x1', nearest.x);
      guide.setAttribute('x2', nearest.x);
      dot.setAttribute('cx', nearest.x);
      dot.setAttribute('cy', nearest.y);
      tip.hidden = false;
      tip.textContent = `${nearest.day} · ${usd(nearest.volume)}`;
      tip.style.left = `${(nearest.x / width) * rect.width}px`;
    };
    svg.addEventListener('mousemove', (event) => focus(event.clientX));
    svg.addEventListener('mouseleave', () => {
      tip.hidden = true;
      guide.setAttribute('hidden', '');
      dot.setAttribute('hidden', '');
    });
  }

  function renderMix() {
    const colors = { stripe: '#8eb4ff', paypal: '#5b7fd6', wallets: '#c5d2e4' };
    const labels = { stripe: 'Card', paypal: 'PayPal', wallets: 'Wallets' };
    const totals = { stripe: 0, paypal: 0, wallets: 0 };
    state.orders.forEach((order) => {
      if (order.status !== 'paid' && order.status !== 'settled') return;
      if (totals[order.rail] != null) totals[order.rail] += Number(order.gross) || 0;
    });
    const entries = Object.entries(totals);
    const sum = entries.reduce((total, [, value]) => total + value, 0);
    let angle = -90;
    const arcs = entries.map(([key, value]) => {
      const start = angle;
      angle += sum ? (value / sum) * 360 : 0;
      return { key, value, start, end: angle, color: colors[key] };
    }).filter((arc) => arc.value > 0);
    const point = (deg) => {
      const rad = (deg * Math.PI) / 180;
      return [56 + 42 * Math.cos(rad), 56 + 42 * Math.sin(rad)];
    };
    const paths = arcs.map((arc) => {
      if (arc.end - arc.start >= 359.5) {
        return `<circle cx="56" cy="56" r="42" fill="none" stroke="${arc.color}" stroke-width="12" />`;
      }
      const [x1, y1] = point(arc.start);
      const [x2, y2] = point(arc.end - 0.2);
      const large = arc.end - arc.start > 180 ? 1 : 0;
      return `<path d="M${x1},${y1} A42,42 0 ${large} 1 ${x2},${y2}" fill="none" stroke="${arc.color}" stroke-width="12" stroke-linecap="butt" />`;
    }).join('');
    const lead = entries.slice().sort((a, b) => b[1] - a[1])[0];
    const leadPct = sum ? Math.round((lead[1] / sum) * 100) : 0;
    const host = $('#rail-mix');
    if (!host) return;
    host.innerHTML = `
      <svg class="mix-svg" viewBox="0 0 112 112" aria-hidden="true">
        <circle cx="56" cy="56" r="42" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="12" />
        ${paths}
        <text x="56" y="60" text-anchor="middle" fill="#fff" font-size="16" font-family="Plus Jakarta Sans, sans-serif" font-weight="700">${leadPct}%</text>
      </svg>
      <div class="mix-legend">
        ${entries.map(([key, value]) => `<div class="mix-row"><span><i class="mix-dot" style="background:${colors[key]}"></i>${labels[key]}</span><strong>${usd(value)}</strong></div>`).join('')}
      </div>
    `;
  }

  function renderQuickRails(isAdmin) {
    const rails = [
      ['stripe', 'Stripe', 'Card payments through Stripe'],
      ['paypal', 'PayPal Express', 'PayPal checkout rail'],
      ['wallets', 'Apple & Google Pay', 'Biometric express wallets'],
      ['radar3ds', '3DS2 Fraud Shield', 'Enforce 3D Secure & risk scoring']
    ];
    $('#quick-rails-panel').innerHTML = rails.map(([key, title, desc]) => `
      <div class="switch-row">
        <div>
          <div class="switch-title">${title}</div>
          <div class="switch-desc">${desc}</div>
        </div>
        <button type="button" class="switch-btn ${state.settings.rails[key] ? 'is-on' : ''}" data-toggle-rail="${key}" ${!isAdmin ? 'disabled' : ''}></button>
      </div>
    `).join('');

    if (isAdmin) {
      $$('[data-toggle-rail]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const key = btn.dataset.toggleRail;
          const next = !state.settings.rails[key];
          await fetch('/api/admin/settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rails: { [key]: next } })
          });
          showToast(`${key} rail ${next ? 'enabled' : 'paused'}.`);
          refreshOverview();
        });
      });
    }
  }

  function renderOrders(isAdmin) {
    const query = ($('#orders-search')?.value || '').trim().toLowerCase();
    const filtered = state.orders.filter((o) =>
      !query ||
      o.id.toLowerCase().includes(query) ||
      o.vendorName.toLowerCase().includes(query) ||
      o.item.toLowerCase().includes(query) ||
      o.customerEmail.toLowerCase().includes(query)
    );

    const recentHost = $('#overview-orders-body');
    if (recentHost) {
      const recent = state.orders.slice(0, 5);
      recentHost.innerHTML = recent.length ? recent.map((o) => `
        <button type="button" class="tx-row" data-jump-view="orders">
          <span>
            <strong>${esc(o.id)}</strong>
            <span class="tx-meta">${esc(o.vendorName)} · ${esc(o.rail)}</span>
          </span>
          <span class="tx-amt">${usd(o.gross)}</span>
        </button>
      `).join('') : '<div class="tx-empty">No transactions yet.</div>';
      $$('[data-jump-view]', recentHost).forEach((button) => {
        button.addEventListener('click', () => switchView(button.dataset.jumpView));
      });
    }

    $('#orders-table-body').innerHTML = filtered.length ? filtered.map((o) => `
      <tr>
        <td class="mono" style="color:#fff;font-weight:600;">${esc(o.id)}</td>
        <td>
          <div style="color:#fff;font-weight:600;">${esc(o.vendorName)}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);">${esc(o.item)} &middot; ${esc(o.customerEmail)}</div>
        </td>
        <td>
          <span class="badge badge--sky">${esc(o.rail)}</span>
          <div class="mono" style="font-size:0.7rem;color:var(--text-subtle);margin-top:3px;">${esc(o.stripeRef)}</div>
        </td>
        <td class="mono">${usd(o.gross)}</td>
        <td class="mono" style="color:var(--accent-text);">${usd(o.fee)}</td>
        <td class="mono">${usd(o.net)}</td>
        <td class="mono" style="font-size:0.74rem;">${esc(o.webhookStatus)}</td>
        <td>${statusBadge(o.status)}</td>
        <td class="actions-cell">
          <div class="row-actions">
            ${isAdmin && o.status === 'paid' ? `<button class="btn btn--primary btn--xs" data-order-act="settled" data-order-id="${esc(o.id)}">Settle</button>` : ''}
            ${isAdmin && o.status !== 'refunded' ? `<button class="btn btn--danger btn--xs" data-order-act="refunded" data-order-id="${esc(o.id)}">Refund</button>` : ''}
            ${isAdmin ? `<button class="btn btn--secondary btn--xs" data-order-hook="${esc(o.id)}">Webhook</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('') : '<tr><td colspan="9" style="color:var(--text-muted);">No transactions yet.</td></tr>';

    $$('[data-order-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        await fetch(`/api/admin/orders/${b.dataset.orderId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: b.dataset.orderAct })
        });
        showToast(`Order ${b.dataset.orderId} marked ${b.dataset.orderAct}.`);
        refreshOverview();
      });
    });

    $$('[data-order-hook]').forEach((b) => {
      b.addEventListener('click', async () => {
        await fetch(`/api/admin/orders/${b.dataset.orderHook}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resendWebhook: true })
        });
        showToast(`Webhook resent for ${b.dataset.orderHook}.`);
        refreshOverview();
      });
    });
  }

  $('#orders-search')?.addEventListener('input', () => {
    if (state) renderOrders(['super_admin', 'admin', 'operator'].includes(state.user.role));
  });

  function renderVendors(isAdmin) {
    if (!state.vendors.length) {
      $('#vendors-table-body').innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);">No applications yet. They appear here as soon as someone applies on the site.</td></tr>';
      return;
    }
    $('#vendors-table-body').innerHTML = state.vendors.map((v) => `
      <tr>
        <td>
          <div style="color:#fff;font-weight:600;">${esc(v.name)}</div>
          <div class="mono" style="font-size:0.72rem;color:var(--text-muted);">${esc(v.website)} &middot; ${esc(v.contact)}</div>
        </td>
        <td>${statusBadge(v.status)}</td>
        <td class="mono" style="color:var(--accent-text);">${Number(v.rate).toFixed(1)}%</td>
        <td>
          <span class="badge ${v.rails.stripe ? 'badge--green' : 'badge--amber'}">Stripe</span>
          <span class="badge ${v.rails.paypal ? 'badge--sky' : 'badge--amber'}">PayPal</span>
        </td>
        <td class="mono" style="font-size:0.72rem;">${esc(v.apiKey)}</td>
        <td style="font-size:0.78rem;">${esc(v.payoutMethod)}</td>
        <td class="actions-cell">
          <div class="row-actions">
            ${isAdmin && v.status !== 'active' ? `<button class="btn btn--primary btn--xs" data-vnd-status="active" data-vnd-id="${esc(v.id)}">Approve</button>` : ''}
            ${isAdmin && v.status === 'active' ? `<button class="btn btn--secondary btn--xs" data-vnd-status="paused" data-vnd-id="${esc(v.id)}">Pause</button>` : ''}
            ${isAdmin ? `<button class="btn btn--secondary btn--xs" data-vnd-rate="${esc(v.id)}" data-cur-rate="${v.rate}">Edit %</button>` : ''}
            <button class="btn btn--secondary btn--xs" data-copy-key="${esc(v.apiKey)}">Copy Key</button>
          </div>
        </td>
      </tr>
    `).join('');

    $$('[data-vnd-status]').forEach((b) => {
      b.addEventListener('click', async () => {
        await fetch(`/api/admin/vendors/${b.dataset.vndId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: b.dataset.vndStatus })
        });
        showToast(`Vendor updated to ${b.dataset.vndStatus}.`);
        refreshOverview();
      });
    });

    $$('[data-vnd-rate]').forEach((b) => {
      b.addEventListener('click', async () => {
        const next = prompt('Set custom commission % for this vendor:', b.dataset.curRate);
        if (next === null) return;
        const rate = Number(next);
        if (Number.isNaN(rate) || rate < 0.5 || rate > 25) return showToast('Enter a rate between 0.5 and 25.');
        await fetch(`/api/admin/vendors/${b.dataset.vndRate}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rate })
        });
        showToast(`Commission updated to ${rate.toFixed(1)}%.`);
        refreshOverview();
      });
    });

    $$('[data-copy-key]').forEach((b) => {
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(b.dataset.copyKey); } catch {}
        showToast('Vendor API key copied.');
      });
    });
  }

  $('#add-vendor-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/api/admin/vendors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('#nv-name').value.trim(),
        website: $('#nv-url').value.trim(),
        rate: Number($('#nv-rate').value),
        contact: $('#nv-contact').value.trim(),
        payoutDest: $('#nv-dest').value.trim()
      })
    });
    if (res.ok) {
      e.target.reset();
      $('#nv-rate').value = '6.0';
      showToast('Vendor created and activated.');
      refreshOverview();
    }
  });

  function renderPayouts(isAdmin) {
    $('#payouts-table-body').innerHTML = state.payouts.map((p) => `
      <tr>
        <td class="mono" style="color:#fff;font-weight:600;">${esc(p.id)}</td>
        <td>${esc(p.vendorName)}</td>
        <td class="mono" style="color:var(--accent-text);font-weight:700;">${usd(p.amount)}</td>
        <td>
          <div>${esc(p.method)}</div>
          <div class="mono" style="font-size:0.72rem;color:var(--text-muted);">${esc(p.destination)}</div>
        </td>
        <td>
          ${statusBadge(p.status)}
          ${p.txHash ? `<div class="mono" style="font-size:0.7rem;color:var(--text-subtle);margin-top:3px;">${esc(p.txHash)}</div>` : ''}
        </td>
        <td class="actions-cell">
          <div class="row-actions">
            ${isAdmin && p.status === 'pending'
              ? `<button class="btn btn--primary btn--xs" data-release-payout="${esc(p.id)}">Mark Paid</button>`
              : '<span style="font-size:0.75rem;color:var(--text-subtle);">Completed</span>'}
          </div>
        </td>
      </tr>
    `).join('');

    $$('[data-release-payout]').forEach((b) => {
      b.addEventListener('click', async () => {
        await fetch(`/api/admin/payouts/${b.dataset.releasePayout}/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        showToast(`Payout ${b.dataset.releasePayout} marked settled!`);
        refreshOverview();
      });
    });
  }

  function renderStripeDiag() {
    const s = state.stripe;
    const item = (label, ok, detail) => `
      <div class="switch-row">
        <div>
          <div class="switch-title">${label}</div>
          <div class="switch-desc mono">${esc(detail)}</div>
        </div>
        <span class="badge ${ok ? 'badge--green' : 'badge--amber'}">${ok ? 'Configured' : 'Set in .env'}</span>
      </div>
    `;
    $('#stripe-diag-body').innerHTML =
      item('STRIPE_SECRET_KEY', s.hasSecretKey, s.hasSecretKey ? 'Loaded from environment' : 'Add sk_test_... or sk_live_... to .env') +
      item('STRIPE_PUBLISHABLE_KEY', s.hasPublishableKey, s.hasPublishableKey ? 'Loaded from environment' : 'Add pk_test_... or pk_live_... to .env') +
      item('STRIPE_WEBHOOK_SECRET', s.hasWebhookSecret, s.webhookEndpoint);

    const sample = state.vendors[0];
    const vendorId = sample ? sample.id : 'vnd_yourid';
    const vendorKey = sample ? sample.apiKey : 'rl_yourkey';
    $('#admin-embed-code').textContent = `<script src="${window.location.origin}/relay-plugin.js"\n  data-vendor="${vendorId}"\n  data-key="${vendorKey}"></script>\n\n<button data-relay-checkout\n  data-item="Product name"\n  data-amount="49.00"\n  data-rail="stripe">\n  Pay now\n</button>`;
  }

  // ------------------------------------------------------------------------
  // Temp Logins Management
  // ------------------------------------------------------------------------
  async function loadTempLogins() {
    const res = await fetch('/api/admin/temp-logins');
    if (!res.ok) return;
    const { logins } = await res.json();
    $('#logins-table-body').innerHTML = logins.map((u) => `
      <tr>
        <td>
          <div style="color:#fff;font-weight:600;">${esc(u.name)}</div>
          <div class="mono" style="font-size:0.74rem;color:var(--text-muted);">${esc(u.email)}</div>
        </td>
        <td><span class="badge badge--sky">${esc(u.role)}</span></td>
        <td class="mono" style="font-size:0.76rem;color:var(--accent-text);">${esc(u.tempPasswordHint || '••••••••')}</td>
        <td class="mono" style="font-size:0.74rem;">${u.expiresAt ? new Date(u.expiresAt).toLocaleDateString() : 'Never'}</td>
        <td>${u.active ? '<span class="badge badge--green">Active</span>' : '<span class="badge badge--red">Revoked</span>'}</td>
        <td class="actions-cell">
          <div class="row-actions">
            ${u.tempPasswordHint ? `<button class="btn btn--secondary btn--xs" data-copy-cred="${esc(u.email + ' / ' + u.tempPasswordHint)}">Copy</button>` : ''}
            ${u.active && u.id !== state.user.id ? `<button class="btn btn--danger btn--xs" data-revoke-login="${esc(u.id)}">Revoke</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');

    $$('[data-copy-cred]').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copyCred); } catch {}
      showToast('Temporary credentials copied.');
    }));

    $$('[data-revoke-login]').forEach((b) => b.addEventListener('click', async () => {
      const r = await fetch(`/api/admin/temp-logins/${b.dataset.revokeLogin}`, { method: 'DELETE' });
      if (r.ok) {
        showToast('Temporary login revoked.');
        loadTempLogins();
      }
    }));
  }

  $('#create-temp-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/api/admin/temp-logins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('#tl-name').value.trim(),
        email: $('#tl-email').value.trim(),
        role: $('#tl-role').value,
        expiresHours: Number($('#tl-hours').value),
        note: $('#tl-note').value.trim()
      })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Could not create login.');

    const banner = $('#new-login-banner');
    banner.hidden = false;
    banner.innerHTML = `
      <div style="font-weight:700;color:var(--accent-text);margin-bottom:4px;">Temporary Login Created</div>
      <div class="mono" style="font-size:0.82rem;color:#fff;">
        Email: ${esc(data.login.email)} &nbsp;|&nbsp; Password: <strong>${esc(data.login.password)}</strong> &nbsp;|&nbsp; Role: ${esc(data.login.role)}
      </div>
    `;
    e.target.reset();
    showToast('New temporary login minted!');
    loadTempLogins();
  });

  // ------------------------------------------------------------------------
  // Live Site Controls Form
  // ------------------------------------------------------------------------
  let acceptingState = true;
  function renderSettingsForm() {
    const s = state.settings;
    $('#set-status-text').value = s.statusText || '';
    $('#set-starter').value = s.commissions.starter;
    $('#set-growth').value = s.commissions.growth;
    $('#set-enterprise').value = s.commissions.enterprise;
    $('#set-paypal-markup').value = s.commissions.paypalMarkup;
    $('#set-fixed').value = s.commissions.fixedFee;
    acceptingState = Boolean(s.acceptingApplications);
    $('#set-accepting-toggle').classList.toggle('is-on', acceptingState);
  }

  $('#set-accepting-toggle')?.addEventListener('click', () => {
    acceptingState = !acceptingState;
    $('#set-accepting-toggle').classList.toggle('is-on', acceptingState);
  });

  $('#settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statusText: $('#set-status-text').value.trim(),
        acceptingApplications: acceptingState,
        commissions: {
          starter: Number($('#set-starter').value),
          growth: Number($('#set-growth').value),
          enterprise: Number($('#set-enterprise').value),
          paypalMarkup: Number($('#set-paypal-markup').value),
          fixedFee: Number($('#set-fixed').value)
        }
      })
    });
    if (res.ok) {
      showToast('Live website settings & commission rates updated!');
      refreshOverview();
    }
  });

  async function initDashboard() {
    try {
      const meRes = await fetch('/api/auth/me');
      const me = await meRes.json();
      if (!me.authenticated) {
        $('#app-shell').hidden = true;
        $('#auth-gate').hidden = false;
        showDeskPath('/login');
        return;
      }
      showDeskPath('/dashboard');
    } catch {
      return;
    }
    await refreshOverview();
  }

  initDashboard();
});
