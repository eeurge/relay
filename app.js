/* ==========================================================================
   Relay Public Site Controller (app.js)
   Connects to Express backend + Stripe Checkout Plugin + Sign In flow.
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

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
    } catch {}
  }

  loadPublicConfig();

  let sbRail = 'stripe';
  const sbAmount = $('#sb-amount');
  const sbPriceDisplay = $('#sb-price-display');
  const sbPayBtn = $('#sb-pay-btn');
  const sbConsole = $('#sb-console');

  function syncSandboxPrice() {
    const val = Math.max(1, Number(sbAmount?.value) || 49);
    if (sbPriceDisplay) sbPriceDisplay.textContent = formatUSD(val);
    if (sbPayBtn) sbPayBtn.textContent = `Pay ${formatUSD(val)}`;
  }

  sbAmount?.addEventListener('input', syncSandboxPrice);

  $$('[data-sb-rail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sbRail = btn.dataset.sbRail;
      $$('[data-sb-rail]').forEach((item) => item.classList.toggle('is-active', item === btn));
      const label = $('#sb-item-label');
      if (label) label.textContent = sbRail === 'paypal' ? 'PayPal' : sbRail === 'wallets' ? 'Wallets' : 'Stripe';
    });
  });

  async function openStripeCheckout({ amountUsd, email, item, rail, button, status }) {
    if (button) button.disabled = true;
    if (status) status.textContent = 'Opening Stripe…';
    try {
      const res = await fetch('/api/stripe/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorId: 'vnd_vendor',
          item,
          amountUsd,
          rail,
          customerEmail: email
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Stripe checkout failed');
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      if (status) status.textContent = `${formatUSD(amountUsd)} recorded. Stripe did not return a checkout page.`;
    } catch (err) {
      if (status) status.textContent = err.message || 'Stripe checkout failed';
    } finally {
      if (button) button.disabled = false;
    }
  }

  sbPayBtn?.addEventListener('click', () => {
    const amountUsd = Math.max(1, Number(sbAmount?.value) || 49);
    const email = $('#sb-email')?.value?.trim() || '';
    if (sbRail === 'stripe') {
      openStripeCheckout({
        amountUsd,
        email,
        item: 'Checkout',
        rail: 'stripe',
        button: sbPayBtn,
        status: sbConsole
      });
      return;
    }
    const railLabel = sbRail === 'paypal' ? 'PayPal' : 'Apple Pay or Google Pay';
    if (sbConsole) {
      sbConsole.textContent = `${formatUSD(amountUsd)} via ${railLabel}. Stripe is the live payment option.`;
    }
  });

  const checkoutParams = new URLSearchParams(window.location.search);
  if (checkoutParams.get('checkout') === 'success' && checkoutParams.get('order')) {
    const orderId = checkoutParams.get('order');
    fetch(`/api/stripe/confirm?order=${encodeURIComponent(orderId)}`)
      .then((res) => res.json())
      .then((data) => {
        const paid = data.order?.status === 'paid' || data.paymentStatus === 'paid';
        const message = paid
          ? `${orderId} was paid and sent to your Stripe account.`
          : `${orderId} is waiting on Stripe.`;
        if (sbConsole) sbConsole.textContent = message;
        const pluginStatus = $('#plugin-stripe-status');
        if (pluginStatus) pluginStatus.textContent = message;
      })
      .catch(() => {});
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
  // 4. How the Stripe Plugin Works — Interactive Code Explorer
  // ------------------------------------------------------------------------
  const codeTabs = {
    embed: {
      title: 'Zero PCI burden on the vendor',
      desc: 'The vendor adds the script and a buy button. The button opens checkout, Relay creates the Stripe or PayPal session, and the customer pays there.',
      code: `<!-- 1. Include Relay once on the vendor website -->
<script src="${window.location.origin}/relay-plugin.js"
  data-vendor="vnd_yourid"
  data-key="rl_yourkey"></script>

<!-- 2. Attach checkout to the product button -->
<button
  data-relay-checkout
  data-item="Product name"
  data-amount="49.00"
  data-rail="stripe">
  Pay now
</button>`
    },
    backend: {
      title: 'Relay creates the Checkout session',
      desc: 'Relay calls Stripe with the platform key, tags the session with the vendor, the fee, and the vendor net, then sends the customer to Stripe.',
      code: `// server.js — POST /api/stripe/create-checkout-session
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
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

  function highlightCode(code) {
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const pattern = /(&lt;!--[\s\S]*?--&gt;)|(\/\/.*)|(&lt;\/?)([a-zA-Z][\w-]*)|(\b(?:const|let|await|if|return|function)\b)|(\b[A-Za-z_][\w.]*(?=\())|([\w-]+)(?==)|('(?:\\'|[^'])*'|"(?:\\"|[^"])*")|(\b\d+\.?\d*\b)/g;
    return escaped.replace(pattern, (match, comment, line, tagOpen, tagName, keyword, fn, attr, str, num) => {
      if (comment || line) return `<span class="tok-cmt">${comment || line}</span>`;
      if (tagName) return `${tagOpen}<span class="tok-tag">${tagName}</span>`;
      if (keyword) return `<span class="tok-key">${keyword}</span>`;
      if (fn) return `<span class="tok-fn">${fn}</span>`;
      if (attr) return `<span class="tok-attr">${attr}</span>`;
      if (str) return `<span class="tok-str">${str}</span>`;
      if (num) return `<span class="tok-num">${num}</span>`;
      return match;
    });
  }

  function renderCodeTab(key) {
    activeCodeKey = key;
    const item = codeTabs[key];
    if (codeDisplay) codeDisplay.innerHTML = highlightCode(item.code);
    if (codeTitle) codeTitle.textContent = item.title;
    if (codeDesc) codeDesc.textContent = item.desc;
    $$('[data-code-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.codeTab === key));
  }

  $$('[data-code-tab]').forEach((btn) => btn.addEventListener('click', () => renderCodeTab(btn.dataset.codeTab)));
  renderCodeTab('embed');

  $('#copy-code-btn')?.addEventListener('click', async () => {
    const btn = $('#copy-code-btn');
    try {
      await navigator.clipboard.writeText(codeTabs[activeCodeKey].code);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Select the code';
    }
    setTimeout(() => { btn.textContent = 'Copy snippet'; }, 1600);
  });

  $$('[data-cselect]').forEach((root) => {
    const trigger = $('.cselect-btn', root);
    const menu = $('.cselect-menu', root);
    const hidden = $('input[type="hidden"]', root);
    const label = $('.cselect-value', root);
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = menu.hidden;
      $$('.cselect-menu').forEach((other) => { other.hidden = true; });
      $$('[data-cselect]').forEach((other) => {
        other.classList.remove('is-open');
        $('.cselect-btn', other)?.setAttribute('aria-expanded', 'false');
      });
      menu.hidden = !willOpen;
      root.classList.toggle('is-open', willOpen);
      trigger.setAttribute('aria-expanded', String(willOpen));
    });
    $$('[data-value]', menu).forEach((option) => {
      option.addEventListener('click', () => {
        hidden.value = option.dataset.value;
        label.textContent = option.textContent.trim();
        $$('[data-value]', menu).forEach((item) => item.setAttribute('aria-selected', String(item === option)));
        menu.hidden = true;
        root.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  });
  document.addEventListener('click', () => {
    $$('.cselect-menu').forEach((menu) => { menu.hidden = true; });
    $$('[data-cselect]').forEach((root) => {
      root.classList.remove('is-open');
      $('.cselect-btn', root)?.setAttribute('aria-expanded', 'false');
    });
  });

  const aboutField = $('#app-about');
  const aboutCount = $('#about-count');
  aboutField?.addEventListener('input', () => {
    const count = aboutField.value.trim().length;
    aboutCount.textContent = count >= 90 ? `${count} characters` : `${count} / 90 minimum`;
    aboutCount.classList.toggle('is-met', count >= 90);
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
      const about = $('#app-about').value.trim();
      if (about.length < 90) throw new Error('Describe what you sell in at least 90 characters.');
      const res = await fetch('/api/public/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('#app-name').value.trim(),
          website: $('#app-url').value.trim(),
          email: $('#app-email').value.trim(),
          discord: $('#app-discord').value.trim(),
          description: about,
          monthlyVolume: Number($('#app-volume').value),
          payoutMethod: $('#app-payout').value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Application failed');
      $('#apply-form').hidden = true;
      $('#apply-result').hidden = false;
      if (data.mail) {
        fetch(`https://formsubmit.co/ajax/${data.inbox}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(data.mail)
        }).catch(() => {});
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
});
