const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load simple .env file if present (zero extra dependencies)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

const PORT = Number(process.env.PORT || 8080);
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
const STRIPE_PUBLISHABLE_KEY = (process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
const STRIPE_WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();

const hasRealStripeKey =
  Boolean(STRIPE_SECRET_KEY) &&
  !STRIPE_SECRET_KEY.includes('replace_me') &&
  (STRIPE_SECRET_KEY.startsWith('sk_test_') || STRIPE_SECRET_KEY.startsWith('sk_live_'));

let stripe = null;
if (hasRealStripeKey) {
  const Stripe = require('stripe');
  stripe = new Stripe(STRIPE_SECRET_KEY);
}

const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function makeUserRecord({ id, name, email, password, role, temp = true, expiresAt = null, note = '' }) {
  const salt = crypto.randomBytes(12).toString('hex');
  return {
    id,
    name,
    email: email.toLowerCase(),
    role, // 'super_admin' | 'admin' | 'operator' | 'vendor'
    salt,
    passwordHash: hashPassword(password, salt),
    tempPasswordHint: temp ? password : null,
    isTemp: temp,
    expiresAt,
    note,
    active: true,
    createdAt: new Date().toISOString()
  };
}

function createInitialStore() {
  return {
    settings: {
      brandName: 'Relay',
      statusText: 'Accepting vendor applications',
      acceptingApplications: true,
      rails: {
        stripe: true,
        paypal: true,
        wallets: true,
        radar3ds: true
      },
      commissions: {
        starter: 8.0,
        growth: 6.0,
        enterprise: 4.5,
        paypalMarkup: 1.0,
        fixedFee: 0.3
      },
      discordInviteUrl: 'https://discord.gg/your-invite-code'
    },
    users: [
      makeUserRecord({
        id: 'usr_admin_1',
        name: 'Founder Admin',
        email: 'admin@relay.dev',
        password: 'RelayAdmin!2026',
        role: 'super_admin',
        temp: true,
        expiresAt: null,
        note: 'Founder login'
      }),
      makeUserRecord({
        id: 'usr_partner_2',
        name: 'Partner',
        email: 'partner@relay.dev',
        password: 'RelayPartner!2026',
        role: 'admin',
        temp: true,
        expiresAt: null,
        note: 'Partner login'
      })
    ],
    vendors: [],
    orders: [],
    payouts: []
  };
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) {
    const seeded = createInitialStore();
    saveStore(seeded);
    return seeded;
  }
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    const seeded = createInitialStore();
    saveStore(seeded);
    return seeded;
  }
}

function saveStore(data) {
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

let store = loadStore();

// In-memory active sessions map: token -> { userId, expiresAt }
const sessions = new Map();

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const token = bearer || cookies.relay_session;
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess) return null;
  if (Date.now() > sess.expiresAt) {
    sessions.delete(token);
    return null;
  }
  const user = store.users.find((u) => u.id === sess.userId && u.active);
  if (!user) return null;
  if (user.expiresAt && Date.now() > new Date(user.expiresAt).getTime()) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isTemp: user.isTemp,
    expiresAt: user.expiresAt
  };
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (!['super_admin', 'admin', 'operator'].includes(user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.user = user;
  next();
}

function calculateCommission(gross, rail, vendorRate) {
  const fixed = store.settings.commissions.fixedFee || 0.3;
  const baseRate = typeof vendorRate === 'number' ? vendorRate : store.settings.commissions.growth;
  const markup = rail === 'paypal' ? (store.settings.commissions.paypalMarkup || 1.0) : 0;
  const effectivePct = baseRate + markup;
  const fee = Math.round(((gross * effectivePct) / 100 + fixed) * 100) / 100;
  const net = Math.max(0, Math.round((gross - fee) * 100) / 100);
  return { effectivePct, fee, net };
}

const app = express();
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Stripe Webhook Endpoint (MUST receive raw body before express.json)
// ---------------------------------------------------------------------------
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET || STRIPE_WEBHOOK_SECRET.includes('replace_me')) {
    return res.status(200).json({ received: true, mode: 'sandbox_unverified' });
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;
    const existing = store.orders.find((o) => o.id === orderId);
    if (existing) {
      existing.status = 'paid';
      existing.stripeRef = session.payment_intent || session.id;
      existing.webhookStatus = '200 OK';
      saveStore(store);
    }
  } else if (event.type === 'charge.dispute.created') {
    const dispute = event.data.object;
    const match = store.orders.find((o) => o.stripeRef === dispute.payment_intent);
    if (match) {
      match.status = 'disputed';
      saveStore(store);
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Public Config, Stripe Status & Checkout Plugin API
// ---------------------------------------------------------------------------
app.get('/api/public/config', (req, res) => {
  const totalVolume = store.orders
    .filter((o) => o.status !== 'refunded')
    .reduce((sum, o) => sum + o.gross, 0);

  res.json({
    settings: store.settings,
    stripeMode: hasRealStripeKey
      ? STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test'
      : 'sandbox',
    hasPublishableKey: Boolean(STRIPE_PUBLISHABLE_KEY) && !STRIPE_PUBLISHABLE_KEY.includes('replace_me'),
    hasWebhookSecret: Boolean(STRIPE_WEBHOOK_SECRET) && !STRIPE_WEBHOOK_SECRET.includes('replace_me'),
    liveStats: {
      ordersCount: store.orders.length,
      activeVendors: store.vendors.filter((v) => v.status === 'active').length,
      sampleVolume: Math.round(totalVolume * 100) / 100
    }
  });
});

app.get('/api/stripe/status', (req, res) => {
  res.json({
    connected: hasRealStripeKey,
    mode: hasRealStripeKey
      ? STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test'
      : 'sandbox',
    hasPublishableKey: Boolean(STRIPE_PUBLISHABLE_KEY) && !STRIPE_PUBLISHABLE_KEY.includes('replace_me'),
    hasSecretKey: hasRealStripeKey,
    hasWebhookSecret: Boolean(STRIPE_WEBHOOK_SECRET) && !STRIPE_WEBHOOK_SECRET.includes('replace_me'),
    webhookEndpoint: `${BASE_URL}/api/stripe/webhook`,
    rails: store.settings.rails
  });
});

app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    const {
      vendorId = 'vnd_acme01',
      item = 'Digital Product',
      amountUsd = 49,
      rail = 'stripe',
      customerEmail = 'customer@example.com'
    } = req.body || {};

    const gross = Math.max(1, Math.min(250000, Number(amountUsd) || 49));
    const safeRail = ['stripe', 'paypal', 'wallets'].includes(rail) ? rail : 'stripe';

    if (!store.settings.rails[safeRail]) {
      return res.status(400).json({ error: `The ${safeRail} rail is currently paused by Admin.` });
    }

    const vendor = store.vendors.find((v) => v.id === vendorId) || store.vendors[0];
    const { effectivePct, fee, net } = calculateCommission(gross, safeRail, vendor?.rate);
    const orderId = `RL-${Math.floor(8500 + Math.random() * 1499)}`;

    // Real Stripe Checkout when STRIPE_SECRET_KEY is configured and rail uses Stripe
    if (stripe && (safeRail === 'stripe' || safeRail === 'wallets')) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: customerEmail || undefined,
        payment_method_types: ['card'],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: Math.round(gross * 100),
              product_data: {
                name: String(item).slice(0, 120),
                description: `Processed via Relay for ${vendor ? vendor.name : 'Verified Vendor'}`
              }
            }
          }
        ],
        metadata: {
          orderId,
          vendorId: vendor ? vendor.id : 'vnd_custom',
          relayFee: String(fee),
          vendorNet: String(net)
        },
        success_url: `${BASE_URL}/?checkout=success&order=${orderId}`,
        cancel_url: `${BASE_URL}/?checkout=canceled&order=${orderId}`
      });

      const order = {
        id: orderId,
        vendorId: vendor ? vendor.id : 'vnd_custom',
        vendorName: vendor ? vendor.name : 'Demo Vendor',
        item: String(item).slice(0, 120),
        customerEmail: String(customerEmail).slice(0, 120),
        rail: safeRail,
        gross,
        fee,
        net,
        status: 'pending_payment',
        webhookStatus: 'Waiting on Stripe',
        stripeRef: session.id,
        createdAt: new Date().toISOString()
      };
      store.orders.unshift(order);
      saveStore(store);

      return res.json({
        mode: STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'stripe_live' : 'stripe_test',
        checkoutUrl: session.url,
        sessionId: session.id,
        order
      });
    }

    // Relay Sandbox Simulator (runs immediately with zero API keys needed)
    const prefix = safeRail === 'paypal' ? 'pp_sbx_' : 'pi_sbx_';
    const stripeRef = `${prefix}${crypto.randomBytes(6).toString('hex')}`;
    const order = {
      id: orderId,
      vendorId: vendor ? vendor.id : 'vnd_acme01',
      vendorName: vendor ? vendor.name : 'Acme Digital',
      item: String(item).slice(0, 120),
      customerEmail: String(customerEmail).slice(0, 120),
      rail: safeRail,
      gross,
      fee,
      net,
      status: 'paid',
      webhookStatus: '200 OK',
      stripeRef,
      createdAt: new Date().toISOString()
    };

    store.orders.unshift(order);

    // Add to vendor's pending payout queue
    const pendingPayout = store.payouts.find(
      (p) => p.vendorId === order.vendorId && p.status === 'pending'
    );
    if (pendingPayout) {
      pendingPayout.amount = Math.round((pendingPayout.amount + net) * 100) / 100;
    } else if (vendor) {
      store.payouts.unshift({
        id: `PO-${Math.floor(2050 + Math.random() * 890)}`,
        vendorId: vendor.id,
        vendorName: vendor.name,
        amount: net,
        method: vendor.payoutMethod,
        destination: vendor.payoutDest,
        status: 'pending',
        txHash: null,
        createdAt: new Date().toISOString()
      });
    }

    saveStore(store);

    return res.json({
      mode: 'sandbox',
      order,
      commissionRate: effectivePct,
      webhookPayload: {
        event: 'checkout.completed',
        order_id: order.id,
        vendor_id: order.vendorId,
        rail: order.rail,
        gross_usd: order.gross,
        relay_fee_usd: order.fee,
        vendor_net_usd: order.net,
        payment_ref: order.stripeRef,
        signature: `sha256=${crypto.randomBytes(16).toString('hex')}`
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Checkout session failed' });
  }
});

// Public Vendor Application -> lands directly inside Admin Panel!
app.post('/api/public/apply', (req, res) => {
  if (!store.settings.acceptingApplications) {
    return res.status(403).json({ error: 'New vendor applications are currently paused.' });
  }
  const { name, website, contact, monthlyVolume = 15000, payoutMethod = 'USDT (TRC-20)', rails = 'stripe,paypal' } = req.body || {};
  if (!website || !contact) {
    return res.status(400).json({ error: 'Website URL and contact handle are required.' });
  }

  const vol = Math.max(500, Number(monthlyVolume) || 15000);
  const tier = vol >= 50000 ? 'enterprise' : vol >= 10000 ? 'growth' : 'starter';
  const rate = store.settings.commissions[tier];
  const id = `vnd_${crypto.randomBytes(3).toString('hex')}`;
  const apiKey = `rl_${crypto.randomBytes(8).toString('hex')}`;

  const vendor = {
    id,
    name: (name || website.replace(/^https?:\/\//, '').split('/')[0]).slice(0, 60),
    website: String(website).slice(0, 140),
    contact: String(contact).slice(0, 80),
    tier,
    rate,
    status: 'pending',
    rails: {
      stripe: String(rails).includes('stripe'),
      paypal: String(rails).includes('paypal')
    },
    payoutMethod: String(payoutMethod).slice(0, 60),
    payoutDest: 'Pending wallet verification',
    apiKey,
    monthlyVolume: vol,
    createdAt: new Date().toISOString()
  };

  store.vendors.unshift(vendor);
  saveStore(store);

  res.status(201).json({
    vendor,
    embedSnippet: `<script src="${BASE_URL}/relay-plugin.js" data-vendor="${vendor.id}" data-key="${vendor.apiKey}"></script>\n<button data-relay-checkout data-item="Example Product" data-amount="49.00" data-rail="stripe">Pay now</button>`
  });
});

// ---------------------------------------------------------------------------
// Authentication & Session Endpoints
// ---------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { email = '', password = '' } = req.body || {};
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = store.users.find((u) => u.email === normalizedEmail && u.active);

  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (user.expiresAt && Date.now() > new Date(user.expiresAt).getTime()) {
    return res.status(401).json({ error: 'This temporary login has expired.' });
  }

  const attemptHash = hashPassword(String(password), user.salt);
  const match = crypto.timingSafeEqual(
    Buffer.from(attemptHash, 'hex'),
    Buffer.from(user.passwordHash, 'hex')
  );
  if (!match) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  const ttlMs = 24 * 3600 * 1000;
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + ttlMs });

  res.setHeader(
    'Set-Cookie',
    `relay_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${BASE_URL.startsWith('https://') ? '; Secure' : ''}`
  );
  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isTemp: user.isTemp,
      expiresAt: user.expiresAt
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.relay_session) sessions.delete(cookies.relay_session);
  res.setHeader('Set-Cookie', 'relay_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req);
  res.json({ authenticated: Boolean(user), user });
});

// ---------------------------------------------------------------------------
// Admin Control Plane API
// ---------------------------------------------------------------------------
app.get('/api/admin/overview', requireAuth, (req, res) => {
  const isAdmin = ['super_admin', 'admin', 'operator'].includes(req.user.role);
  const visibleOrders = isAdmin
    ? store.orders
    : store.orders.filter((o) => o.vendorId === 'vnd_acme01');

  const grossVolume = visibleOrders
    .filter((o) => o.status !== 'refunded')
    .reduce((s, o) => s + o.gross, 0);
  const netRevenue = visibleOrders
    .filter((o) => o.status !== 'refunded')
    .reduce((s, o) => s + o.fee, 0);
  const pendingPayouts = store.payouts
    .filter((p) => p.status === 'pending' && (isAdmin || p.vendorId === 'vnd_acme01'))
    .reduce((s, p) => s + p.amount, 0);

  res.json({
    user: req.user,
    kpis: {
      grossVolume: Math.round(grossVolume * 100) / 100,
      netRevenue: Math.round(netRevenue * 100) / 100,
      pendingPayouts: Math.round(pendingPayouts * 100) / 100,
      activeVendors: store.vendors.filter((v) => v.status === 'active').length,
      pendingVendors: store.vendors.filter((v) => v.status === 'pending').length,
      totalOrders: visibleOrders.length
    },
    chart7d: buildChart7d(visibleOrders),
    stripe: {
      connected: hasRealStripeKey,
      mode: hasRealStripeKey
        ? STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test'
        : 'sandbox',
      hasPublishableKey: Boolean(STRIPE_PUBLISHABLE_KEY) && !STRIPE_PUBLISHABLE_KEY.includes('replace_me'),
      hasSecretKey: hasRealStripeKey,
      hasWebhookSecret: Boolean(STRIPE_WEBHOOK_SECRET) && !STRIPE_WEBHOOK_SECRET.includes('replace_me'),
      webhookEndpoint: `${BASE_URL}/api/stripe/webhook`
    },
    settings: store.settings,
    orders: visibleOrders,
    vendors: isAdmin ? store.vendors : store.vendors.filter((v) => v.id === 'vnd_acme01'),
    payouts: isAdmin ? store.payouts : store.payouts.filter((p) => p.vendorId === 'vnd_acme01')
  });
});

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const order = store.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { status, resendWebhook } = req.body || {};
  if (['paid', 'settled', 'refunded', 'disputed'].includes(status)) {
    order.status = status;
  }
  if (resendWebhook) {
    order.webhookStatus = `200 OK (resent ${new Date().toTimeString().slice(0, 8)})`;
  }
  saveStore(store);
  res.json({ order });
});

app.post('/api/admin/vendors', requireAdmin, (req, res) => {
  const { name, website, contact, rate = 6.0, payoutMethod = 'USDT (TRC-20)', payoutDest = '' } = req.body || {};
  if (!name || !website) return res.status(400).json({ error: 'Vendor name and website required' });
  const vendor = {
    id: `vnd_${crypto.randomBytes(3).toString('hex')}`,
    name: String(name).slice(0, 60),
    website: String(website).slice(0, 140),
    contact: String(contact || '@vendor').slice(0, 80),
    tier: rate <= 5 ? 'enterprise' : rate <= 6.5 ? 'growth' : 'starter',
    rate: Math.max(0.5, Math.min(25, Number(rate) || 6.0)),
    status: 'active',
    rails: { stripe: true, paypal: true },
    payoutMethod: String(payoutMethod).slice(0, 60),
    payoutDest: String(payoutDest || 'Pending wallet').slice(0, 120),
    apiKey: `rl_live_${crypto.randomBytes(8).toString('hex')}`,
    monthlyVolume: 0,
    createdAt: new Date().toISOString()
  };
  store.vendors.unshift(vendor);
  saveStore(store);
  res.status(201).json({ vendor });
});

app.patch('/api/admin/vendors/:id', requireAdmin, (req, res) => {
  const vendor = store.vendors.find((v) => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  const { status, rate, rails, rotateKey } = req.body || {};
  if (['active', 'pending', 'paused', 'rejected'].includes(status)) vendor.status = status;
  if (typeof rate === 'number' && rate >= 0.5 && rate <= 25) vendor.rate = rate;
  if (rails && typeof rails === 'object') {
    if (typeof rails.stripe === 'boolean') vendor.rails.stripe = rails.stripe;
    if (typeof rails.paypal === 'boolean') vendor.rails.paypal = rails.paypal;
  }
  if (rotateKey) vendor.apiKey = `rl_live_${crypto.randomBytes(8).toString('hex')}`;
  saveStore(store);
  res.json({ vendor });
});

app.post('/api/admin/payouts/:id/release', requireAdmin, (req, res) => {
  const payout = store.payouts.find((p) => p.id === req.params.id);
  if (!payout) return res.status(404).json({ error: 'Payout not found' });
  payout.status = 'paid';
  payout.txHash = (req.body?.txHash || `0x${crypto.randomBytes(8).toString('hex')}...settled`).slice(0, 80);
  // Mark associated paid orders as settled
  store.orders.forEach((o) => {
    if (o.vendorId === payout.vendorId && o.status === 'paid') o.status = 'settled';
  });
  saveStore(store);
  res.json({ payout });
});

app.patch('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (typeof body.statusText === 'string') store.settings.statusText = body.statusText.slice(0, 120);
  if (typeof body.acceptingApplications === 'boolean') {
    store.settings.acceptingApplications = body.acceptingApplications;
  }
  if (typeof body.discordInviteUrl === 'string') {
    store.settings.discordInviteUrl = body.discordInviteUrl.slice(0, 140);
  }
  if (body.rails && typeof body.rails === 'object') {
    for (const k of ['stripe', 'paypal', 'wallets', 'radar3ds']) {
      if (typeof body.rails[k] === 'boolean') store.settings.rails[k] = body.rails[k];
    }
  }
  if (body.commissions && typeof body.commissions === 'object') {
    for (const k of ['starter', 'growth', 'enterprise', 'paypalMarkup', 'fixedFee']) {
      const n = Number(body.commissions[k]);
      if (!Number.isNaN(n) && n >= 0 && n <= 30) store.settings.commissions[k] = n;
    }
  }
  saveStore(store);
  res.json({ settings: store.settings });
});

app.get('/api/admin/temp-logins', requireAdmin, (req, res) => {
  const list = store.users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    isTemp: u.isTemp,
    tempPasswordHint: u.tempPasswordHint,
    expiresAt: u.expiresAt,
    note: u.note,
    active: u.active,
    createdAt: u.createdAt
  }));
  res.json({ logins: list });
});

app.post('/api/admin/temp-logins', requireAdmin, (req, res) => {
  const { name = 'Temp Collaborator', email, role = 'admin', expiresHours = 168, note = '' } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return res.status(400).json({ error: 'Valid email is required.' });
  }
  if (store.users.some((u) => u.email === cleanEmail && u.active)) {
    return res.status(409).json({ error: 'An active login with this email already exists.' });
  }
  const safeRole = ['super_admin', 'admin', 'operator', 'vendor'].includes(role) ? role : 'admin';
  const generatedPassword = `Relay-${crypto.randomBytes(4).toString('hex').toUpperCase()}!`;
  const hours = Math.max(1, Math.min(2160, Number(expiresHours) || 168));
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();

  const record = makeUserRecord({
    id: `usr_${crypto.randomBytes(4).toString('hex')}`,
    name: String(name).slice(0, 60),
    email: cleanEmail,
    password: generatedPassword,
    role: safeRole,
    temp: true,
    expiresAt,
    note: String(note || `Created by ${req.user.email}`).slice(0, 120)
  });

  store.users.unshift(record);
  saveStore(store);

  res.status(201).json({
    login: {
      id: record.id,
      name: record.name,
      email: record.email,
      role: record.role,
      password: generatedPassword,
      expiresAt: record.expiresAt,
      note: record.note,
      active: record.active
    }
  });
});

app.delete('/api/admin/temp-logins/:id', requireAdmin, (req, res) => {
  const target = store.users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Login not found' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot revoke your own active session account.' });
  }
  target.active = false;
  saveStore(store);
  res.json({ ok: true });
});

function buildChart7d(orders) {
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - i);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    const volume = orders
      .filter((order) => order.status !== 'refunded')
      .filter((order) => {
        const created = new Date(order.createdAt).getTime();
        return created >= start.getTime() && created < end.getTime();
      })
      .reduce((sum, order) => sum + Number(order.gross || 0), 0);
    days.push({
      day: i === 0 ? 'Today' : start.toLocaleDateString('en-US', { weekday: 'short' }),
      volume: Math.round(volume * 100) / 100
    });
  }
  return days;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'relay' });
});

// Serve static frontend files
app.use(express.static(__dirname, { extensions: ['html'] }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Relay server listening at ${BASE_URL} (Stripe ${hasRealStripeKey ? 'connected' : 'not connected'})`);
});
