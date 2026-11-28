# Relay

Payment middleman site for vendor applications, a drop-in checkout embed, and an admin desk for orders, payouts, and staff logins.

## Run it locally

```bash
npm install
copy .env.example .env
npm start
```

Open http://127.0.0.1:8080 . Sign in is http://127.0.0.1:8080/login .

Founder: `admin@relay.dev` / `RelayAdmin!2026`  
Partner: `partner@relay.dev` / `RelayPartner!2026`

Change these under Admin → Temp Logins before the site is public.

## Put it on the internet

1. Push this folder to https://github.com/eeurge/relay .
2. Create a Render account at https://render.com and choose New → Blueprint. Point it at that GitHub repo. `render.yaml` starts the Node server and keeps applications on a disk.
3. In the Render service, set `BASE_URL` to `https://yourdomain.com`.
4. Buy the domain at https://www.cloudflare.com/products/registrar/ (or any registrar). In Render, open the service → Custom Domains → add the domain, then copy the DNS records Render shows into Cloudflare.
5. When Stripe is ready, add `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` in Render → Environment. The webhook endpoint is `https://yourdomain.com/api/stripe/webhook`.

Routing other people's payments through one Stripe account needs Stripe Connect or written approval from Stripe. Do that before taking live vendor volume.

## Google sign-in

Relay uses Google's OAuth 2.0 / OpenID Connect authorization code flow with PKCE. The "Continue with Google" button sends the browser to Google's account picker, then Google returns to `/api/auth/google/callback`.

Set these on the main Render service (do not put values in git):

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Email/password signup still uses `SIGNUP_ACCESS_KEY`. Google sign-in does not: a new Google email creates a Relay account, and an existing Relay email is signed in and linked. Duplicate accounts are not created.

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create a **Web application** OAuth client and set:

**Authorized JavaScript origins**

- `https://relaypayus.shop`
- `https://www.relaypayus.shop`

**Authorized redirect URIs**

- `https://relaypayus.shop/api/auth/google/callback`
- `https://www.relaypayus.shop/api/auth/google/callback`

For local work, also add `http://127.0.0.1:8080` and `http://localhost:8080` as origins, and `/api/auth/google/callback` on each of those hosts as redirect URIs.

Set `BASE_URL` to `https://relaypayus.shop` in production.

## How an application becomes an embed

1. A vendor clicks Apply on the site and submits the form.
2. Relay saves it immediately. Sign in and open Admin → Vendors.
3. Click Approve. Stripe & Rails shows the embed for that vendor.
4. They paste two lines on their product page. `data-item` is the product name and `data-amount` is the price.

```html
<script src="https://yourdomain.com/relay-plugin.js" data-vendor="vnd_yourid" data-key="rl_yourkey"></script>
<button data-relay-checkout data-item="Product name" data-amount="49.00" data-rail="stripe">Pay now</button>
```

A click calls Relay, Relay opens Stripe Checkout when the keys are set, and the paid order shows up under Admin → Transactions. The vendor's net amount waits under Payout Queue until you mark it paid.
