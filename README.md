# Relay

Payment middleman site for vendor applications, a drop-in checkout embed, and an admin desk for orders, payouts, and staff logins.

## Run it locally

```bash
npm install
copy .env.example .env
npm start
```

Open http://127.0.0.1:8080 . Admin is http://127.0.0.1:8080/admin.html .

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
