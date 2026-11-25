# Relay — Managed Stripe & PayPal Payment Middleman Platform

Full-stack payment middleman website, drop-in vendor Stripe/PayPal checkout plugin, Sign In system with temporary logins, and Admin Control Plane.

## Features

- **Public Storefront (`index.html`, `styles.css`, `app.js`)**: Original dark obsidian & emerald fintech UI with interactive Stripe plugin sandbox, code walkthrough, volume commission tiers, payout estimator, and vendor onboarding modal.
- **Drop-In Vendor Plugin (`relay-plugin.js`)**: Vendors paste one `<script>` tag and attach `data-relay-checkout` to any Buy button. Calls `POST /api/stripe/create-checkout-session` on your Relay backend.
- **Node/Express + Official Stripe SDK Backend (`server.js`)**:
  - Real `stripe.checkout.sessions.create()` + signed `POST /api/stripe/webhook` handler when Stripe keys are present in `.env`.
  - Automatic interactive **Sandbox Mode** when keys are not yet configured, recording every test order into `data/store.json` and the Admin Panel.
- **Sign In & Admin Control Plane (`admin.html`, `admin.css`, `admin.js`)**:
  - Monitor gross volume, Relay commission revenue, pending payouts, and 7-day charts.
  - Manage orders (settle, refund, resend webhooks), approve/pause vendors, customize vendor `%` rates, release payout batches, toggle Stripe/PayPal rails live, edit site-wide pricing/status, and mint/revoke temporary logins.

## Temporary Logins (Pre-Seeded)

| Role | Email | Temporary Password |
| :--- | :--- | :--- |
| Super Admin | `admin@relay.dev` | `RelayAdmin!2026` |
| Partner Admin | `partner@relay.dev` | `RelayPartner!2026` |
| Vendor Demo | `vendor@acme.io` | `VendorDemo!2026` |

Generate or revoke additional temporary logins anytime under **Admin Panel → Temp Logins**.

## Quick Start

```bash
npm install
cp .env.example .env
npm start
# Open http://127.0.0.1:8080/ and http://127.0.0.1:8080/admin.html
```

## Connecting Live Stripe

1. Copy `.env.example` to `.env`.
2. Add `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` from your Stripe Dashboard (or run `stripe listen --forward-to localhost:8080/api/stripe/webhook` for local testing).
3. Restart `npm start`. Relay automatically switches from `SANDBOX` to `STRIPE TEST` or `STRIPE LIVE`.

> **Compliance note:** When routing payments for multiple independent third-party vendors on Stripe, use **Stripe Connect** (or formally approved Merchant-of-Record underwriting) so your account remains compliant with Stripe's Terms of Service.

## Pushing to GitHub to Collaborate

```bash
git remote add origin https://github.com/eeurge/relay.git
git push -u origin main
```

Then invite your friend under **GitHub Repo → Settings → Collaborators**.
