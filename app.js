/* ==========================================================================
   Relay Public Site Controller (app.js)
   Connects to Express backend + Stripe Checkout Plugin + Sign In flow.
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  let toastTimer = null;
  function showToast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2800);
  }

  function formatUSD(n) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);
  }

  let liveCommissions = { starter: 8.0, growth: 6.0, enterprise: 4.5, paypalMarkup: 1.0, fixedFee: 0.3 };
  let activePricingRail = 'stripe';

  // ------------------------------------------------------------------------
  // 1. Hydrate Live Config & Session State from Backend
  // ------------------------------------------------------------------------
  async function loadPublicConfig() {
    try {
      const res = await fetch('/api/public/config');
      if (!res.ok) return;
      const data = await res.json();
      if (data.settings?.statusText && $('#hero-status-text')) {
        $('#hero-status-text').textContent = data.settings.statusText;
      }
      if (data.settings?.commissions) {
        liveCommissions = data.settings.commissions;
        renderPricing();
        updateCalculator();
      }
      const badge = $('#stripe-mode-badge');
      if (badge) {
        if (data.stripeMode === 'live') badge.textContent = 'STRIPE LIVE';
        else if (data.stripeMode === 'test') badge.textContent = 'STRIPE TEST MODE';
        else badge.textContent = 'SANDBOX READY';
      }
    } catch {}
  }

  async function checkSession() {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) return;
      const data = await res.json();
      if (data.authenticated && data.user) {
        const pill = $('#header-admin-pill');
        const signinBtn = $('#header-signin-btn');
        if (pill) pill.hidden = false;
        if (signinBtn) signinBtn.hidden = true;
      }
    } catch {}
  }

  loadPublicConfig();
  checkSession();

  // Check URL query for Stripe Checkout redirect result
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'success') {
    showToast(`Stripe Checkout completed (${params.get('order') || 'verified'})!`);
  } else if (params.get('checkout') === 'canceled') {
    showToast('Stripe Checkout canceled.');
  }

  // ------------------------------------------------------------------------
  // 2. Mobile Navigation Drawer
  // ------------------------------------------------------------------------
  const mobileToggle = $('#mobile-toggle');
  const mobileDrawer = $('#mobile-drawer');
  if (mobileToggle && mobileDrawer) {
    mobileToggle.addEventListener('click', () => {
      const open = mobileDrawer.classList.toggle('is-open');
      mobileToggle.setAttribute('aria-expanded', String(open));
    });
    $$('a, button', mobileDrawer).forEach((el) => {
      el.addEventListener('click', () => {
        mobileDrawer.classList.remove('is-open');
        mobileToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // ------------------------------------------------------------------------
  // 3. Hero Live Interactive Stripe Checkout Sandbox
  // ------------------------------------------------------------------------
  let sbRail = 'stripe';
  const sbAmount = $('#sb-amount');
  const sbEmail = $('#sb-email');
  const sbPriceDisplay = $('#sb-price-display');
  const sbPayBtn = $('#sb-pay-btn');
  const sbConsole = $('#sb-console');

  function syncSandboxPrice() {
    const val = Math.max(1, Number(sbAmount?.value) || 149);
    if (sbPriceDisplay) sbPriceDisplay.textContent = formatUSD(val);
    if (sbPayBtn) sbPayBtn.textContent = `Run Live Checkout (${formatUSD(val)})`;
  }

  sbAmount?.addEventListener('input', syncSandboxPrice);

  $$('[data-sb-rail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sbRail = btn.dataset.sbRail;
      $$('[data-sb-rail]').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
  });

  sbPayBtn?.addEventListener('click', async () => {
    const amountUsd = Math.max(1, Number(sbAmount?.value) || 149);
    const customerEmail = sbEmail?.value?.trim() || 'buyer@example.com';
    sbPayBtn.disabled = true;
    sbPayBtn.textContent = 'Creating checkout session...';

    try {
      const res = await fetch('/api/stripe/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorId: 'vnd_acme01',
          item: 'Pro Suite Annual License',
          amountUsd,
          rail: sbRail,
          customerEmail
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Checkout failed');

      if (data.checkoutUrl) {
        sbConsole.innerHTML = `<div><strong>[stripe]</strong> Redirecting to real Stripe Checkout (${data.sessionId})...</div>`;
        window.location.href = data.checkoutUrl;
        return;
      }

      sbConsole.innerHTML = `
        <div><strong>[${data.order.rail}]</strong> Order <strong>${data.order.id}</strong> captured (${formatUSD(data.order.gross)}) &middot; ref <code>${data.order.stripeRef}</code></div>
        <div><strong>[ledger]</strong> Relay fee ${formatUSD(data.order.fee)} &rarr; Vendor net <strong>${formatUSD(data.order.net)}</strong> queued in Admin Panel.</div>
      `;
      showToast(`Order ${data.order.id} recorded in Admin Panel!`);
    } catch (err) {
      sbConsole.innerHTML = `<div style="color:#f87171;"><strong>[error]</strong> ${err.message}</div>`;
    } finally {
      sbPayBtn.disabled = false;
      syncSandboxPrice();
    }
  });

  // ------------------------------------------------------------------------
  // 4. How the Stripe Plugin Works — Interactive Code Explorer
  // ------------------------------------------------------------------------
  const codeTabs = {
    embed: {
      title: 'Zero PCI burden on the vendor',
      desc: 'Your vendor adds two lines of HTML onto any product page. Clicking the button invokes RelayCheckout.open(), calling your Relay backend to create a Stripe Checkout or PayPal session.',
      code: `<!-- 1. Include Relay plugin once on the vendor website -->
<script src="https://pay.yourdomain.com/relay-plugin.js"
  data-vendor="vnd_acme01"
  data-key="rl_live_acme_98a4f2c10b"></script>

<!-- 2. Attach checkout to any Buy button -->
<button
  data-relay-checkout
  data-item="Pro Suite Annual License"
  data-amount="149.00"
  data-rail="stripe">
  Pay with Card or PayPal
</button>`
    },
    backend: {
      title: 'Your server holds the Stripe Secret Key',
      desc: 'Relay calls the official Stripe Node SDK on your server, tagging each Checkout Session with the vendor ID, calculated commission, and net vendor payout so accounting is automatic.',
      code: `// server.js — POST /api/stripe/create-checkout-session
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  payment_method_types: ['card'],
  line_items: [{
    quantity: 1,
    price_data: {
      currency: 'usd',
      unit_amount: Math.round(amountUsd * 100),
      product_data: { name: item }
    }
  }],
  metadata: { orderId, vendorId, relayFee, vendorNet },
  success_url: BASE_URL + '/?checkout=success&order=' + orderId,
  cancel_url: BASE_URL + '/?checkout=canceled'
});
res.json({ checkoutUrl: session.url, sessionId: session.id });`
    },
    webhook: {
      title: 'Cryptographically verified fulfillment & ledger',
      desc: 'Stripe signs every webhook with STRIPE_WEBHOOK_SECRET. Relay verifies the signature, marks the order paid, dispatches an HMAC webhook to the vendor site, and queues their net payout.',
      code: `// server.js — POST /api/stripe/webhook (raw body)
const event = stripe.webhooks.constructEvent(
  req.body,
  req.headers['stripe-signature'],
  process.env.STRIPE_WEBHOOK_SECRET
);

if (event.type === 'checkout.session.completed') {
  const { orderId, vendorId, vendorNet } = event.data.object.metadata;
  markOrderPaid(orderId);
  queueVendorPayout(vendorId, Number(vendorNet));
  dispatchSignedVendorWebhook(vendorId, orderId);
}`
    }
  };

  let activeCodeKey = 'embed';
  const codeDisplay = $('#code-display');
  const codeTitle = $('#code-aside-title');
  const codeDesc = $('#code-aside-desc');

  function renderCodeTab(key) {
    activeCodeKey = key;
    const item = codeTabs[key];
    if (codeDisplay) codeDisplay.textContent = item.code;
    if (codeTitle) codeTitle.textContent = item.title;
    if (codeDesc) codeDesc.textContent = item.desc;
    $$('[data-code-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.codeTab === key));
  }

  $$('[data-code-tab]').forEach((btn) => btn.addEventListener('click', () => renderCodeTab(btn.dataset.codeTab)));
  renderCodeTab('embed');

  $('#copy-code-btn')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeTabs[activeCodeKey].code);
      showToast('Code snippet copied.');
    } catch {
      showToast('Copy ready from code panel.');
    }
  });

  // ------------------------------------------------------------------------
  // 5. Pricing & Payout Calculator
  // ------------------------------------------------------------------------
  function renderPricing() {
    const markup = activePricingRail === 'paypal' ? liveCommissions.paypalMarkup : 0;
    ['starter', 'growth', 'enterprise'].forEach((tier) => {
      const el = $(`[data-tier-rate="${tier}"]`);
      if (el) el.textContent = `${(Number(liveCommissions[tier]) + markup).toFixed(1)}%`;
    });
  }

  const calcVol = $('#calc-volume');
  const calcRail = $('#calc-rail');
  const calcSlider = $('#calc-slider');

  function updateCalculator() {
    if (!calcVol) return;
    const vol = Math.max(500, Number(calcVol.value) || 0);
    const rail = calcRail?.value || 'stripe';
    const tierKey = vol >= 50000 ? 'enterprise' : vol >= 10000 ? 'growth' : 'starter';
    const tierLabel = tierKey.charAt(0).toUpperCase() + tierKey.slice(1);
    const rate = Number(liveCommissions[tierKey]) + (rail === 'paypal' ? liveCommissions.paypalMarkup : 0);
    const fee = (vol * rate) / 100;
    const net = Math.max(0, vol - fee);

    $('#calc-tier').textContent = `${tierLabel} · ${rate.toFixed(1)}%`;
    $('#calc-gross').textContent = formatUSD(vol);
    $('#calc-fee').textContent = formatUSD(fee);
    $('#calc-net').textContent = formatUSD(net);
  }

  $$('[data-rail-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activePricingRail = btn.dataset.railTab;
      $$('[data-rail-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
      if (calcRail) calcRail.value = activePricingRail;
      renderPricing();
      updateCalculator();
    });
  });

  calcVol?.addEventListener('input', () => {
    if (calcSlider) calcSlider.value = String(Math.min(100000, Math.max(500, Number(calcVol.value) || 500)));
    updateCalculator();
  });

  calcSlider?.addEventListener('input', () => {
    if (calcVol) calcVol.value = calcSlider.value;
    updateCalculator();
  });

  calcRail?.addEventListener('change', () => {
    activePricingRail = calcRail.value;
    $$('[data-rail-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.railTab === activePricingRail));
    renderPricing();
    updateCalculator();
  });

  renderPricing();
  updateCalculator();

  // ------------------------------------------------------------------------
  // 6. FAQ Accordion
  // ------------------------------------------------------------------------
  const faqItems = $$('.faq-item');
  function syncFaq(item) {
    const p = $('.faq-panel', item);
    if (p) p.style.maxHeight = item.classList.contains('is-open') ? `${p.scrollHeight}px` : '0px';
  }
  faqItems.forEach((item) => {
    syncFaq(item);
    $('.faq-trigger', item)?.addEventListener('click', () => {
      const open = !item.classList.contains('is-open');
      faqItems.forEach((o) => {
        o.classList.remove('is-open');
        $('.faq-trigger', o)?.setAttribute('aria-expanded', 'false');
        syncFaq(o);
      });
      if (open) {
        item.classList.add('is-open');
        $('.faq-trigger', item)?.setAttribute('aria-expanded', 'true');
        syncFaq(item);
      }
    });
  });

  // ------------------------------------------------------------------------
  // 7. Modals: Sign In & Vendor Application
  // ------------------------------------------------------------------------
  const signinModal = $('#signin-modal');
  const applyModal = $('#apply-modal');

  function openModal(m) {
    if (!m) return;
    m.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModals() {
    [signinModal, applyModal].forEach((m) => { if (m) m.hidden = true; });
    document.body.style.overflow = '';
  }

  $$('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModals));
  [signinModal, applyModal].forEach((m) => m?.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

  $$('[data-open-signin]').forEach((b) => b.addEventListener('click', () => {
    $('#signin-error').hidden = true;
    openModal(signinModal);
    setTimeout(() => $('#login-email')?.focus(), 50);
  }));

  $$('[data-fill-login]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#login-email').value = chip.dataset.fillLogin;
      $('#login-password').value = chip.dataset.fillPass;
    });
  });

  $('#signin-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#signin-error');
    errEl.hidden = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: $('#login-email').value.trim(),
          password: $('#login-password').value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sign in failed');
      window.location.href = '/admin.html';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // Vendor Application
  $$('[data-open-apply]').forEach((b) => b.addEventListener('click', () => {
    $('#apply-form').hidden = false;
    $('#apply-result').hidden = true;
    $('#apply-error').hidden = true;
    if (b.dataset.volume) $('#app-volume').value = b.dataset.volume;
    openModal(applyModal);
  }));

  $('#apply-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#apply-error');
    errEl.hidden = true;
    try {
      const res = await fetch('/api/public/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('#app-name').value.trim(),
          website: $('#app-url').value.trim(),
          contact: $('#app-contact').value.trim(),
          monthlyVolume: Number($('#app-volume').value),
          rails: $('#app-rails').value,
          payoutMethod: $('#app-payout').value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Application failed');
      $('#apply-snippet').textContent = data.embedSnippet;
      $('#apply-form').hidden = true;
      $('#apply-result').hidden = false;
      showToast('Vendor application submitted to Admin Panel!');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  $('#copy-apply-snippet')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#apply-snippet').textContent);
      showToast('Embed snippet copied.');
    } catch {
      showToast('Select the snippet box to copy.');
    }
  });
});
