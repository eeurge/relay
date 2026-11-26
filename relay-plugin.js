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
        display: flex; align-items: center; justify-content: center; gap: 6px;
        min-height: 42px; padding: 8px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1);
        background: #080a0f; color: #94a3b8; font-size: 12px; font-weight: 600; cursor: pointer;
      }
      .rp-mark { width: 16px; height: 16px; display: block; flex-shrink: 0; }
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
      customerEmail: options.customerEmail || '',
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
              <button type="button" class="rp-rail ${selectedRail === 'stripe' ? 'is-active' : ''}" data-rp-rail="stripe" aria-label="Stripe"><svg class="rp-mark" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#635bff"/><path fill="#fff" d="M11.1 9.55c0-.55.48-.82 1.28-.82 1.08 0 2.44.34 3.5.94V7.55c-1.16-.5-2.32-.74-3.5-.74-2.86 0-4.76 1.5-4.76 4 0 3.9 5.28 3.28 5.28 4.96 0 .68-.58.96-1.4.96-1.22 0-2.78-.5-3.96-1.18v2.2c1.32.56 2.66.86 3.96.86 2.94 0 4.96-1.46 4.96-4.04 0-4.2-5.36-3.46-5.36-5.02z"/></svg><span>Stripe</span></button>
              <button type="button" class="rp-rail ${selectedRail === 'paypal' ? 'is-active' : ''}" data-rp-rail="paypal" aria-label="PayPal"><svg class="rp-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="#003087" d="M7.08 21.34H2.47a.64.64 0 0 1-.63-.74L4.94.9A.7.7 0 0 1 6 0h7.46c2.57 0 4.58.54 5.69 1.81 1.01 1.15 1.3 2.42 1.01 4.29-.02.14-.06.29-.1.44-.98 5.05-4.35 6.8-8.65 6.8H9.22a.69.69 0 0 0-.68.58l-1.12 7.1a.56.56 0 0 1-.55.45l.21-.13z"/><path fill="#009cde" d="M19.2 6.9a3.3 3.3 0 0 0-.6-.54c-.02.08-.03.18-.05.26-.59 3.02-2.56 6.08-8.56 6.08H7.83a.9.9 0 0 0-.9.9l-1.12 7.1-.5 3.1a.5.5 0 0 0 .5.6h3.47a.8.8 0 0 0 .8-.7l.03-.2.6-3.8.04-.2a.8.8 0 0 1 .8-.7h.5c3.26 0 5.81-1.32 6.55-5.15.31-1.6.15-2.93-.64-3.87a2.7 2.7 0 0 0-.77-.68z"/></svg></button>
              <button type="button" class="rp-rail ${selectedRail === 'wallets' ? 'is-active' : ''}" data-rp-rail="wallets" aria-label="Apple Pay and Google Pay"><svg class="rp-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="#f5f5f7" d="M16.37 12.72c-.03-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.83-.81-3.01-.79-1.55.02-2.98.9-3.78 2.29-1.61 2.8-.41 6.94 1.16 9.21.77 1.11 1.68 2.36 2.88 2.31 1.16-.05 1.6-.74 3-.74s1.8.74 3.02.72c1.25-.02 2.03-1.13 2.79-2.25.88-1.28 1.24-2.52 1.26-2.58-.03-.01-2.42-.93-2.48-3.74zM14.7 6.3c.64-.77 1.07-1.85.95-2.92-.92.04-2.03.61-2.69 1.38-.59.68-1.1 1.77-.96 2.81 1.02.08 2.06-.52 2.7-1.27z"/></svg><svg class="rp-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.68-.06-1.34-.17-1.96H12v3.71h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.23c1.89-1.74 2.99-4.3 2.99-7.27z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.61-2.42l-3.23-2.5c-.9.6-2.04.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.58A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.41 13.92A6 6 0 0 1 6.1 12c0-.67.11-1.31.31-1.92V7.5H3.07a10 10 0 0 0 0 9l3.34-2.58z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87C16.95 2.96 14.7 2 12 2A10 10 0 0 0 3.07 7.5l3.34 2.58c.79-2.36 2.99-4.12 5.59-4.12z"/></svg></button>
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
