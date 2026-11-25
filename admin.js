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

  $('#logout-btn')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    $('#app-shell').hidden = true;
    $('#auth-gate').hidden = false;
    showToast('Signed out.');
  });

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
    window.RelayCheckout.open({
      vendorId: 'vnd_acme01',
      item: 'Admin Live Stripe Plugin Test',
      amountUsd: 99,
      rail: 'stripe',
      onSuccess: () => {
        showToast('Live test payment captured — refreshing ledger!');
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

    $('#cur-user-name').textContent = `${state.user.name} (${state.user.role})`;
    $('#cur-user-meta').textContent = state.user.email;
    $('#nav-logins').hidden = !isAdmin;
    $('#nav-settings').hidden = !isAdmin;
    $('#add-vendor-panel').hidden = !isAdmin;

    const modeBadgeText = state.stripe.mode === 'live' ? 'STRIPE LIVE' : state.stripe.mode === 'test' ? 'STRIPE TEST' : 'SANDBOX';
    $('#sidebar-stripe-mode').textContent = modeBadgeText;
    $('#diag-mode-badge').textContent = modeBadgeText;

    // Counts
    $('#count-orders').textContent = state.orders.length;
    $('#count-vendors').textContent = state.vendors.length;
    $('#count-payouts').textContent = state.payouts.filter((p) => p.status === 'pending').length;

    // KPIs
    $('#kpi-gross').textContent = usd(state.kpis.grossVolume);
    $('#kpi-net').textContent = usd(state.kpis.netRevenue);
    $('#kpi-pending').textContent = usd(state.kpis.pendingPayouts);
    $('#kpi-vendors').textContent = String(state.kpis.activeVendors);
    $('#kpi-vendors-sub').textContent = `${state.kpis.pendingVendors} pending review`;

    renderChart();
    renderQuickRails(isAdmin);
    renderOrders(isAdmin);
    renderVendors(isAdmin);
    renderPayouts(isAdmin);
    renderStripeDiag();
    renderSettingsForm();
    return true;
  }

  function renderChart() {
    const max = Math.max(...state.chart7d.map((d) => d.volume), 100);
    $('#volume-chart').innerHTML = state.chart7d.map((d) => {
      const pct = Math.max(10, Math.round((d.volume / max) * 100));
      return `
        <div class="chart-col">
          <span class="chart-val">$${(d.volume / 1000).toFixed(1)}k</span>
          <div class="chart-bar-wrap"><div class="chart-bar" style="height:${pct}%;"></div></div>
          <span class="chart-day">${esc(d.day)}</span>
        </div>
      `;
    }).join('');
  }

  function renderQuickRails(isAdmin) {
    const rails = [
      ['stripe', 'Stripe Cards', 'Visa, Mastercard, Amex via Stripe SDK'],
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

    $('#overview-orders-body').innerHTML = state.orders.slice(0, 5).map((o) => `
      <tr>
        <td class="mono" style="color:#fff;font-weight:600;">${esc(o.id)}</td>
        <td>${esc(o.vendorName)}</td>
        <td><span class="badge badge--sky">${esc(o.rail)}</span></td>
        <td class="mono">${usd(o.gross)}</td>
        <td class="mono" style="color:var(--accent-text);">${usd(o.fee)}</td>
        <td class="mono">${usd(o.net)}</td>
        <td>${statusBadge(o.status)}</td>
      </tr>
    `).join('');

    $('#orders-table-body').innerHTML = filtered.map((o) => `
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
          ${isAdmin && o.status === 'paid' ? `<button class="btn btn--primary btn--xs" data-order-act="settled" data-order-id="${esc(o.id)}">Settle</button>` : ''}
          ${isAdmin && o.status !== 'refunded' ? `<button class="btn btn--danger btn--xs" data-order-act="refunded" data-order-id="${esc(o.id)}">Refund</button>` : ''}
          ${isAdmin ? `<button class="btn btn--secondary btn--xs" data-order-hook="${esc(o.id)}">Webhook</button>` : ''}
        </td>
      </tr>
    `).join('');

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
          ${isAdmin && v.status !== 'active' ? `<button class="btn btn--primary btn--xs" data-vnd-status="active" data-vnd-id="${esc(v.id)}">Approve</button>` : ''}
          ${isAdmin && v.status === 'active' ? `<button class="btn btn--secondary btn--xs" data-vnd-status="paused" data-vnd-id="${esc(v.id)}">Pause</button>` : ''}
          ${isAdmin ? `<button class="btn btn--secondary btn--xs" data-vnd-rate="${esc(v.id)}" data-cur-rate="${v.rate}">Edit %</button>` : ''}
          <button class="btn btn--secondary btn--xs" data-copy-key="${esc(v.apiKey)}">Copy Key</button>
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
        <td>
          ${isAdmin && p.status === 'pending'
            ? `<button class="btn btn--primary btn--xs" data-release-payout="${esc(p.id)}">Mark Paid</button>`
            : '<span style="font-size:0.75rem;color:var(--text-subtle);">Completed</span>'}
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

    $('#admin-embed-code').textContent = `<script src="${window.location.origin}/relay-plugin.js"\n  data-vendor="vnd_acme01"></script>\n\n<button data-relay-checkout\n  data-item="Pro License"\n  data-amount="149.00"\n  data-rail="stripe">\n  Pay with Card / PayPal\n</button>`;
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
          ${u.tempPasswordHint ? `<button class="btn btn--secondary btn--xs" data-copy-cred="${esc(u.email + ' / ' + u.tempPasswordHint)}">Copy</button>` : ''}
          ${u.active && u.id !== state.user.id ? `<button class="btn btn--danger btn--xs" data-revoke-login="${esc(u.id)}">Revoke</button>` : ''}
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
        return;
      }
    } catch {
      return;
    }
    await refreshOverview();
  }

  initDashboard();
});
