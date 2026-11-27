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

  let liveCommissions = {
    starter: 5.5,
    growth: 5.0,
    enterprise: 4.5,
    paypalStarter: 7.0,
    paypalGrowth: 6.5,
    paypalEnterprise: 5.5,
    fixedFee: 0.3
  };
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
        liveCommissions = { ...liveCommissions, ...data.settings.commissions };
        renderPricing();
      }
    } catch {}
  }

  loadPublicConfig();

  function closeHomeAccount() {
    const menu = $('#home-account-drop');
    const button = $('#home-account-btn');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  async function refreshHomeSession() {
    let user = null;
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      if (data.authenticated) user = data.user;
    } catch {}
    $$('[data-guest-only]').forEach((el) => { el.hidden = Boolean(user); });
    const account = $('#home-account');
    if (account) account.hidden = !user;
    if (!user) return;
    const first = String(user.name || 'Relay').split(' ')[0];
    $('#home-account-name').textContent = first;
    $('#home-avatar').textContent = first.slice(0, 1).toUpperCase();
    const settings = $('#home-account-settings');
    if (settings) settings.hidden = false;
  }

  $('#home-account-btn')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = $('#home-account-drop');
    const open = menu.hidden;
    menu.hidden = !open;
    $('#home-account-btn').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#home-account')) closeHomeAccount();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeHomeAccount();
  });

  async function homeSignOut(openSignIn) {
    closeHomeAccount();
    await fetch('/api/auth/logout', { method: 'POST' });
    await refreshHomeSession();
    if (openSignIn) $('#header-signin-btn')?.click();
  }
  $('#home-account-logout')?.addEventListener('click', () => homeSignOut(false));
  $('#home-account-switch')?.addEventListener('click', () => homeSignOut(true));

  refreshHomeSession();

  let sbRail = 'stripe';
  const sbAmount = $('#sb-amount');
  const sbPriceDisplay = $('#sb-price-display');
  const sbPayBtn = $('#sb-pay-btn');
  const sbPayLabel = $('#sb-pay-label');
  const sbConsole = $('#sb-console');

  function syncSandboxPrice() {
    const val = Math.max(1, Number(sbAmount?.value) || 49);
    if (sbPriceDisplay) sbPriceDisplay.textContent = formatUSD(val);
    if (sbPayLabel) sbPayLabel.textContent = `Pay ${formatUSD(val)}`;
  }

  sbAmount?.addEventListener('input', syncSandboxPrice);

  $$('[data-sb-rail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sbRail = btn.dataset.sbRail;
      $$('[data-sb-rail]').forEach((item) => item.classList.toggle('is-active', item === btn));
      const label = $('#sb-item-label');
      if (label) label.textContent = sbRail === 'paypal' ? 'PayPal' : sbRail === 'apple' ? 'Apple Pay' : 'Stripe';
    });
  });

  async function openHomepageCheckout() {
    const amountUsd = Math.max(1, Number(sbAmount?.value) || 49);
    const email = $('#sb-email')?.value?.trim() || '';
    const rail = sbRail === 'apple' ? 'wallets' : sbRail;
    if (sbPayBtn) sbPayBtn.disabled = true;
    if (sbConsole) {
      sbConsole.textContent = rail === 'paypal'
        ? 'Opening PayPal…'
        : rail === 'wallets'
          ? 'Opening Apple Pay…'
          : 'Opening Stripe…';
    }
    try {
      const res = await fetch('/api/stripe/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorId: 'vnd_vendor',
          item: 'Checkout',
          amountUsd,
          rail,
          customerEmail: email
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Checkout failed');
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      if (sbConsole) sbConsole.textContent = data.error || 'Checkout did not open.';
    } catch (err) {
      if (sbConsole) sbConsole.textContent = err.message || 'Checkout failed';
    } finally {
      if (sbPayBtn) sbPayBtn.disabled = false;
    }
  }

  sbPayBtn?.addEventListener('click', () => {
    openHomepageCheckout();
  });

  const checkoutParams = new URLSearchParams(window.location.search);
  if (checkoutParams.get('checkout') === 'success' && checkoutParams.get('order')) {
    const orderId = checkoutParams.get('order');
    fetch(`/api/stripe/confirm?order=${encodeURIComponent(orderId)}`)
      .then((res) => res.json())
      .then((data) => {
        const paid = data.order?.status === 'paid' || data.paymentStatus === 'paid';
        const message = data.order?.rail === 'paypal'
          ? `${orderId} was sent to PayPal.`
          : paid
            ? `${orderId} was paid.`
            : `${orderId} is waiting on Stripe.`;
        if (sbConsole) sbConsole.textContent = message;
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

  const aboutField = $('#app-about');
  const aboutCount = $('#about-count');
  aboutField?.addEventListener('input', () => {
    const count = aboutField.value.trim().length;
    aboutCount.textContent = count >= 90 ? `${count} characters` : `${count} / 90 minimum`;
    aboutCount.classList.toggle('is-met', count >= 90);
  });

  // ------------------------------------------------------------------------
  // 5. Pricing
  // ------------------------------------------------------------------------
  function rateFor(tier, rail) {
    if (rail === 'paypal') {
      const key = tier === 'enterprise' ? 'paypalEnterprise' : tier === 'growth' ? 'paypalGrowth' : 'paypalStarter';
      return Number(liveCommissions[key] ?? liveCommissions[tier]);
    }
    return Number(liveCommissions[tier]);
  }

  function renderPricing() {
    ['starter', 'growth', 'enterprise'].forEach((tier) => {
      const el = $(`[data-tier-rate="${tier}"]`);
      if (el) el.textContent = `${rateFor(tier, activePricingRail).toFixed(1)}%`;
    });
    $$('[data-rail-line]').forEach((item) => {
      const copy = activePricingRail === 'paypal' ? item.dataset.paypalCopy : item.dataset.stripeCopy;
      const label = item.querySelector('span');
      if (copy && label) label.textContent = copy;
    });
  }

  $$('[data-rail-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activePricingRail = btn.dataset.railTab;
      $$('[data-rail-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
      renderPricing();
    });
  });

  renderPricing();

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
  const signupModal = $('#signup-modal');
  const applyModal = $('#apply-modal');

  function openModal(m) {
    if (!m) return;
    m.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModals() {
    [signinModal, signupModal, applyModal].forEach((m) => { if (m) m.hidden = true; });
    document.body.style.overflow = '';
  }

  $$('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModals));
  [signinModal, signupModal, applyModal].forEach((m) => m?.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

  $$('[data-open-signin]').forEach((b) => b.addEventListener('click', () => {
    $('#signin-error').hidden = true;
    openModal(signinModal);
    setTimeout(() => $('#login-email')?.focus(), 50);
  }));

  $$('[data-open-signup]').forEach((b) => b.addEventListener('click', () => {
    $('#signup-error').hidden = true;
    openModal(signupModal);
    setTimeout(() => $('#signup-name')?.focus(), 50);
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
      window.location.href = '/dashboard';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  $('#signup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#signup-error');
    errEl.hidden = true;
    if ($('#signup-password').value !== $('#signup-confirm').value) {
      errEl.textContent = 'Passwords do not match.';
      errEl.hidden = false;
      return;
    }
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('#signup-name').value.trim(),
          email: $('#signup-email').value.trim(),
          password: $('#signup-password').value,
          confirmPassword: $('#signup-confirm').value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create the account');
      window.location.href = '/dashboard';
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
          monthlyVolume: Number($('#app-volume').value)
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
