/* ==========================================================================
   Relay Drop-In Checkout Plugin (relay-plugin.js)
   Vendors include this single script on their storefront to accept payments
   via Relay's managed Stripe & PayPal rails.
   ========================================================================== */

(function (global) {
  'use strict';

  const currentScript = document.currentScript;
  const defaultOrigin = currentScript && currentScript.src
    ? new URL(currentScript.src).origin
    : global.location.origin;

  const defaultVendorId = currentScript?.dataset?.vendor || 'vnd_acme01';

  let modalEl = null;

  function formatMoney(n) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(Number(n) || 0);
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function injectStyles() {
    if (document.getElementById('relay-plugin-styles')) return;
    const style = document.createElement('style');
    style.id = 'relay-plugin-styles';
    style.textContent = `
      .rp-backdrop {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(3, 5, 9, 0.78); backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center; padding: 20px;
        font-family: "Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif;
      }
      .rp-card {
        width: 100%; max-width: 440px; border-radius: 18px;
        background: #0e1118; border: 1px solid rgba(255,255,255,0.12);
        box-shadow: 0 30px 90px rgba(0,0,0,0.75); color: #f8fafc; overflow: hidden;
      }
      .rp-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.02);
      }
      .rp-brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; }
      .rp-badge {
        width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center;
        background: linear-gradient(135deg, #34d399, #059669); color: #04130d; font-weight: 800; font-size: 12px;
      }
      .rp-close {
        background: none; border: 0; color: #94a3b8; cursor: pointer; font-size: 20px; line-height: 1; padding: 4px;
      }
      .rp-close:hover { color: #fff; }
      .rp-body { padding: 20px; }
      .rp-summary {
        display: flex; justify-content: space-between; align-items: baseline;
        padding: 12px 14px; border-radius: 12px; background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.08); margin-bottom: 16px;
      }
      .rp-item { font-size: 14px; font-weight: 600; color: #fff; }
      .rp-vendor { font-size: 12px; color: #94a3b8; margin-top: 2px; }
      .rp-price { font-size: 18px; font-weight: 700; font-family: "JetBrains Mono", monospace; color: #34d399; }
      .rp-rails { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 14px; }
      .rp-rail {
        padding: 9px 8px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1);
        background: #080a0f; color: #94a3b8; font-size: 12px; font-weight: 600; cursor: pointer;
      }
      .rp-rail.is-active {
        border-color: rgba(16,185,129,0.55); background: rgba(16,185,129,0.12); color: #fff;
      }
      .rp-label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
      .rp-input {
        width: 100%; height: 40px; padding: 0 12px; border-radius: 10px; margin-bottom: 14px;
        background: #080a0f; border: 1px solid rgba(255,255,255,0.12); color: #fff; font-size: 14px;
      }
      .rp-btn {
        width: 100%; height: 42px; border-radius: 10px; border: 0; cursor: pointer;
        background: #10b981; color: #04130d; font-weight: 700; font-size: 14px;
      }
      .rp-btn:hover { background: #34d399; }
      .rp-btn:disabled { opacity: 0.6; cursor: wait; }
      .rp-foot { margin-top: 12px; font-size: 11px; color: #64748b; text-align: center; }
      .rp-receipt {
        padding: 14px; border-radius: 12px; background: rgba(16,185,129,0.08);
        border: 1px solid rgba(16,185,129,0.35); font-size: 13px;
      }
      .rp-code {
        margin-top: 10px; padding: 10px; border-radius: 8px; background: #06070a;
        border: 1px solid rgba(255,255,255,0.08); font-family: "JetBrains Mono", monospace;
        font-size: 11px; color: #cbd5e1; overflow-x: auto; white-space: pre-wrap;
      }
      .rp-err { color: #f87171; font-size: 12px; margin-bottom: 10px; }
    `;
    document.head.appendChild(style);
  }

  function closeModal() {
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
  }

  function openCheckout(options = {}) {
    injectStyles();
    closeModal();

    const cfg = {
      vendorId: options.vendorId || defaultVendorId,
      item: options.item || 'Digital License',
      amountUsd: Number(options.amountUsd) || 49,
      rail: options.rail || 'stripe',
      customerEmail: options.customerEmail || 'buyer@example.com',
      apiBase: options.apiBase || defaultOrigin,
      onSuccess: typeof options.onSuccess === 'function' ? options.onSuccess : null
    };

    let selectedRail = cfg.rail;

    modalEl = document.createElement('div');
    modalEl.className = 'rp-backdrop';
    modalEl.innerHTML = `
      <div class="rp-card" role="dialog" aria-modal="true" aria-label="Relay Checkout">
        <div class="rp-head">
          <div class="rp-brand"><span class="rp-badge">R</span><span>Relay Checkout</span></div>
          <button type="button" class="rp-close" aria-label="Close">&times;</button>
        </div>
        <div class="rp-body">
          <div class="rp-summary">
            <div>
              <div class="rp-item">${escapeHtml(cfg.item)}</div>
              <div class="rp-vendor">Vendor: ${escapeHtml(cfg.vendorId)}</div>
            </div>
            <div class="rp-price">${formatMoney(cfg.amountUsd)}</div>
          </div>

          <div id="rp-form-wrap">
            <label class="rp-label">Select payment rail</label>
            <div class="rp-rails">
              <button type="button" class="rp-rail ${selectedRail === 'stripe' ? 'is-active' : ''}" data-rp-rail="stripe">Stripe Card</button>
              <button type="button" class="rp-rail ${selectedRail === 'paypal' ? 'is-active' : ''}" data-rp-rail="paypal">PayPal</button>
              <button type="button" class="rp-rail ${selectedRail === 'wallets' ? 'is-active' : ''}" data-rp-rail="wallets">Apple / GPay</button>
            </div>

            <label class="rp-label" for="rp-email">Receipt email</label>
            <input id="rp-email" class="rp-input" type="email" value="${escapeHtml(cfg.customerEmail)}" required />

            <div id="rp-error" class="rp-err" hidden></div>
            <button type="button" class="rp-btn" id="rp-pay-btn">Pay ${formatMoney(cfg.amountUsd)}</button>
            <div class="rp-foot">Secured via Relay Stripe &amp; PayPal Gateway &middot; 3DS2 Protected</div>
          </div>

          <div id="rp-done-wrap" hidden></div>
        </div>
      </div>
    `;

    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) closeModal();
    });
    modalEl.querySelector('.rp-close').addEventListener('click', closeModal);

    modalEl.querySelectorAll('[data-rp-rail]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedRail = btn.dataset.rpRail;
        modalEl.querySelectorAll('[data-rp-rail]').forEach((b) => b.classList.toggle('is-active', b === btn));
      });
    });

    const payBtn = modalEl.querySelector('#rp-pay-btn');
    const errBox = modalEl.querySelector('#rp-error');

    payBtn.addEventListener('click', async () => {
      errBox.hidden = true;
      payBtn.disabled = true;
      payBtn.textContent = 'Connecting to Relay gateway...';

      try {
        const email = modalEl.querySelector('#rp-email').value.trim();
        const res = await fetch(`${cfg.apiBase}/api/stripe/create-checkout-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vendorId: cfg.vendorId,
            item: cfg.item,
            amountUsd: cfg.amountUsd,
            rail: selectedRail,
            customerEmail: email
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Checkout failed');

        if (data.checkoutUrl) {
          global.location.href = data.checkoutUrl;
          return;
        }

        const formWrap = modalEl.querySelector('#rp-form-wrap');
        const doneWrap = modalEl.querySelector('#rp-done-wrap');
        formWrap.hidden = true;
        doneWrap.hidden = false;
        doneWrap.innerHTML = `
          <div class="rp-receipt">
            <div style="font-weight:700; color:#34d399; margin-bottom:4px;">Payment recorded &middot; ${escapeHtml(data.order.id)}</div>
            <div style="color:#cbd5e1; font-size:12px;">
              Gross: ${formatMoney(data.order.gross)} &middot; Relay Fee: ${formatMoney(data.order.fee)} &middot; Vendor Net: <strong>${formatMoney(data.order.net)}</strong>
            </div>
            <div style="color:#94a3b8; font-size:11px; margin-top:6px;">
              Recorded live in Admin Panel &rarr; Transactions &amp; Payouts.
            </div>
            <pre class="rp-code">${escapeHtml(JSON.stringify(data.webhookPayload, null, 2))}</pre>
            <button type="button" class="rp-btn" style="margin-top:12px;" id="rp-done-close">Done</button>
          </div>
        `;
        doneWrap.querySelector('#rp-done-close').addEventListener('click', closeModal);
        if (cfg.onSuccess) cfg.onSuccess(data);
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        payBtn.disabled = false;
        payBtn.textContent = `Pay ${formatMoney(cfg.amountUsd)}`;
      }
    });

    document.body.appendChild(modalEl);
  }

  function bindAutoButtons() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-relay-checkout]');
      if (!btn) return;
      e.preventDefault();
      openCheckout({
        vendorId: btn.dataset.vendor || defaultVendorId,
        item: btn.dataset.item || 'Storefront Product',
        amountUsd: Number(btn.dataset.amount || 49),
        rail: btn.dataset.rail || 'stripe'
      });
    });
  }

  bindAutoButtons();
  global.RelayCheckout = { open: openCheckout, close: closeModal };
})(window);
