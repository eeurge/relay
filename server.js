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
    if (!key) continue;
    const current = process.env[key];
    const fileIsReal = Boolean(val) && !val.includes('replace_me');
    const currentIsReal = Boolean(current && String(current).trim()) && !String(current).includes('replace_me');
    if (fileIsReal || !currentIsReal) process.env[key] = val;
  }
}

function cleanEnvValue(value) {
  return String(value || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
}

function isStripeSecretKey(value) {
  return /^(sk|rk)_(test|live)_/.test(value) && !value.includes('replace_me');
}

function stripeSecretMode(value) {
  return value.startsWith('sk_live_') || value.startsWith('rk_live_') ? 'live' : 'test';
}

const PORT = Number(process.env.PORT || 8080);
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const STRIPE_SECRET_KEY = cleanEnvValue(process.env.STRIPE_SECRET_KEY);
const STRIPE_PUBLISHABLE_KEY = cleanEnvValue(process.env.STRIPE_PUBLISHABLE_KEY);
const STRIPE_WEBHOOK_SECRET = cleanEnvValue(process.env.STRIPE_WEBHOOK_SECRET);
const PAYPAL_BUSINESS_EMAIL = cleanEnvValue(process.env.PAYPAL_BUSINESS_EMAIL || 'eurgeee@gmail.com');

const hasRealStripeKey = isStripeSecretKey(STRIPE_SECRET_KEY);

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

function makeUserRecord({ id, name, email, password, role, temp = true, expiresAt = null, note = '', vendorId = null }) {
  const salt = crypto.randomBytes(12).toString('hex');
  return {
    id,
    name,
    email: email.toLowerCase(),
    role, // 'super_admin' | 'admin' | 'operator' | 'vendor'
    vendorId,
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

function vendorLoginRecord() {
  return {
    id: 'vnd_vendor',
    name: 'Vendor',
    website: '',
    email: 'vendor@relay.dev',
    discord: '',
    contact: 'vendor@relay.dev',
    description: '',
    tier: 'growth',
    rate: 5,
    status: 'active',
    rails: { stripe: true, paypal: true },
    payoutMethod: 'USDT (TRC-20)',
    payoutDest: '',
    apiKey: 'rl_vendor_live',
    monthlyVolume: 0,
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
        starter: 5.5,
        growth: 5.0,
        enterprise: 4.5,
        paypalStarter: 7.0,
        paypalGrowth: 6.5,
        paypalEnterprise: 5.5,
        fixedFee: 0.3
      },
      discordInviteUrl: 'https://discord.com/invite/VVe5fYYT'
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

function ensureVendorLogin(store) {
  store.settings = store.settings || {};
  const discordInvite = String(store.settings.discordInviteUrl || '');
  if (!discordInvite || discordInvite.includes('your-invite-code') || discordInvite.includes('ky3qukfrA')) {
    store.settings.discordInviteUrl = 'https://discord.com/invite/VVe5fYYT';
  }
  store.settings.commissions = store.settings.commissions || {};
  const commissions = store.settings.commissions;
  const oldPublishedRates = Number(commissions.starter) === 8 && Number(commissions.growth) === 6 && Number(commissions.enterprise) === 4.5;
  if (oldPublishedRates || commissions.starter == null) {
    commissions.starter = 5.5;
    commissions.growth = 5.0;
    commissions.enterprise = 4.5;
  }
  if (oldPublishedRates || commissions.paypalStarter == null) {
    commissions.paypalStarter = 7.0;
    commissions.paypalGrowth = 6.5;
    commissions.paypalEnterprise = 5.5;
  }
  if (commissions.fixedFee == null) commissions.fixedFee = 0.3;
  store.orders = (store.orders || []).filter((order) => !String(order.id || '').startsWith('RL-EX') && !String(order.stripeRef || '').startsWith('pi_example_'));
  store.payouts = (store.payouts || []).filter((payout) => payout.id !== 'PO-EX1' && !String(payout.id || '').startsWith('PO-EX'));
  store.vendors = (store.vendors || []).filter((vendor) => vendor.id !== 'vnd_example' && vendor.name !== 'Example Store');

  if (!store.users.some((user) => user.email === 'vendor@relay.dev')) {
    store.users.push(makeUserRecord({
      id: 'usr_vendor_1',
      name: 'Vendor',
      email: 'vendor@relay.dev',
      password: 'RelayVendor!2026',
      role: 'vendor',
      vendorId: 'vnd_vendor',
      temp: true,
      expiresAt: null,
      note: 'Vendor dashboard login'
    }));
  } else {
    const existing = store.users.find((user) => user.email === 'vendor@relay.dev');
    if (existing.name === 'Example Vendor') existing.name = 'Vendor';
    if (!existing.vendorId || existing.vendorId === 'vnd_example') existing.vendorId = 'vnd_vendor';
    existing.role = 'vendor';
  }
  if (!store.vendors.some((vendor) => vendor.id === 'vnd_vendor')) store.vendors.push(vendorLoginRecord());
  return store;
}

function loadStore() {
  let loaded;
  if (!fs.existsSync(STORE_PATH)) loaded = createInitialStore();
  else {
    try { loaded = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
    catch { loaded = createInitialStore(); }
  }
  const ready = ensureVendorLogin(loaded);
  saveStore(ready);
  return ready;
}

function saveStoreFile(data) {
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

const database = require('./db');
let useDatabase = false;

function saveStore(data) {
  if (useDatabase) {
    database.queueSave(data);
    return;
  }
  saveStoreFile(data);
}

let store = null;

// Active sessions: token -> { userId, expiresAt }. Saved with the store so a restart keeps people signed in.
const sessions = new Map();

function loadSessions() {
  sessions.clear();
  const now = Date.now();
  const saved = store.sessions && typeof store.sessions === 'object' ? store.sessions : {};
  for (const [token, sess] of Object.entries(saved)) {
    if (sess && Number(sess.expiresAt) > now && sess.userId) sessions.set(token, sess);
  }
}

function persistSessions() {
  const now = Date.now();
  const saved = {};
  for (const [token, sess] of sessions) {
    if (Number(sess.expiresAt) > now) saved[token] = sess;
  }
  store.sessions = saved;
  saveStore(store);
}

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
    vendorId: user.vendorId || null,
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

function commissionRate(tier, rail) {
  const commissions = store.settings.commissions || {};
  if (rail === 'paypal') {
    const key = tier === 'enterprise' ? 'paypalEnterprise' : tier === 'growth' ? 'paypalGrowth' : 'paypalStarter';
    return Number(commissions[key] ?? commissions.growth ?? 6.5);
  }
  return Number(commissions[tier] ?? commissions.growth ?? 5);
}

function calculateCommission(gross, rail, vendor) {
  const fixed = store.settings.commissions.fixedFee || 0.3;
  const tier = vendor?.tier || 'growth';
  const effectivePct = rail === 'paypal'
    ? commissionRate(tier, 'paypal')
    : (typeof vendor?.rate === 'number' ? vendor.rate : commissionRate(tier, 'stripe'));
  const fee = Math.round(((gross * effectivePct) / 100 + fixed) * 100) / 100;
  const net = Math.max(0, Math.round((gross - fee) * 100) / 100);
  return { effectivePct, fee, net };
}

const app = express();
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Stripe Webhook Endpoint (MUST receive raw body before express.json)
// ---------------------------------------------------------------------------
function applyPaidSession(order, session, webhookStatus) {
  order.status = 'paid';
  order.stripeSessionId = order.stripeSessionId || session.id;
  order.stripeRef = session.payment_intent || session.id;
  order.webhookStatus = webhookStatus;
  const email = session.customer_details?.email || session.customer_email;
  if (email) order.customerEmail = email;
}

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
      applyPaidSession(existing, session, '200 OK');
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
    stripeMode: hasRealStripeKey ? stripeSecretMode(STRIPE_SECRET_KEY) : 'sandbox',
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
    mode: hasRealStripeKey ? stripeSecretMode(STRIPE_SECRET_KEY) : 'sandbox',
    hasPublishableKey: Boolean(STRIPE_PUBLISHABLE_KEY) && !STRIPE_PUBLISHABLE_KEY.includes('replace_me'),
    hasSecretKey: hasRealStripeKey,
    hasWebhookSecret: Boolean(STRIPE_WEBHOOK_SECRET) && !STRIPE_WEBHOOK_SECRET.includes('replace_me'),
    webhookEndpoint: `${BASE_URL}/api/stripe/webhook`,
    rails: store.settings.rails
  });
});

app.get('/api/stripe/confirm', async (req, res) => {
  const order = store.orders.find((item) => item.id === req.query.order);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const sessionId = order.stripeSessionId || (String(order.stripeRef || '').startsWith('cs_') ? order.stripeRef : '');
  if (!stripe || !sessionId) return res.json({ order });
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid' || session.status === 'complete') {
      applyPaidSession(order, session, order.webhookStatus === '200 OK' ? '200 OK' : 'Paid on return');
      saveStore(store);
    }
    return res.json({ order, paymentStatus: session.payment_status });
  } catch (err) {
    return res.status(502).json({ error: err.message, order });
  }
});

app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    const {
      vendorId = 'vnd_acme01',
      item = 'Digital Product',
      amountUsd = 49,
      rail = 'stripe',
      customerEmail = ''
    } = req.body || {};

    const gross = Math.max(1, Math.min(250000, Number(amountUsd) || 49));
    const requestedRail = rail === 'apple' ? 'wallets' : rail;
    const safeRail = ['stripe', 'paypal', 'wallets'].includes(requestedRail) ? requestedRail : 'stripe';

    if (!store.settings.rails[safeRail]) {
      return res.status(400).json({ error: `The ${safeRail} rail is currently paused by Admin.` });
    }

    const vendor = store.vendors.find((v) => v.id === vendorId) || store.vendors[0];
    const { effectivePct, fee, net } = calculateCommission(gross, safeRail, vendor);
    const orderId = `RL-${Math.floor(8500 + Math.random() * 1499)}`;

    if (safeRail === 'paypal') {
      const paypalParams = new URLSearchParams({
        cmd: '_xclick',
        business: PAYPAL_BUSINESS_EMAIL,
        item_name: String(item).slice(0, 120),
        amount: gross.toFixed(2),
        currency_code: 'USD',
        invoice: orderId,
        custom: orderId,
        return: `${BASE_URL}/?checkout=success&order=${orderId}&rail=paypal`,
        cancel_return: `${BASE_URL}/?checkout=canceled&order=${orderId}`,
        no_shipping: '1',
        charset: 'utf-8'
      });
      const order = {
        id: orderId,
        vendorId: vendor ? vendor.id : 'vnd_custom',
        vendorName: vendor ? vendor.name : 'Vendor',
        item: String(item).slice(0, 120),
        customerEmail: String(customerEmail).slice(0, 120),
        rail: 'paypal',
        gross,
        fee,
        net,
        status: 'pending_payment',
        webhookStatus: 'Waiting on PayPal',
        stripeRef: `pp_${orderId}`,
        createdAt: new Date().toISOString()
      };
      store.orders.unshift(order);
      saveStore(store);
      return res.json({
        mode: 'paypal',
        checkoutUrl: `https://www.paypal.com/cgi-bin/webscr?${paypalParams.toString()}`,
        order
      });
    }

    // Stripe Checkout hosts the card form. Apple Pay and Google Pay appear on that page when the browser has them.
    if (stripe && (safeRail === 'stripe' || safeRail === 'wallets')) {
      const sessionParams = {
        mode: 'payment',
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
      };

      let session;
      try {
        session = await stripe.checkout.sessions.create(sessionParams);
      } catch (err) {
        return res.status(400).json({ error: err.message || 'Stripe checkout failed' });
      }

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
        stripeSessionId: session.id,
        createdAt: new Date().toISOString()
      };
      store.orders.unshift(order);
      saveStore(store);

      return res.json({
        mode: stripeSecretMode(STRIPE_SECRET_KEY) === 'live' ? 'stripe_live' : 'stripe_test',
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

const APPLY_INBOX = 'relaywaitlist@gmail.com';
const CRYPTO_PAYOUTS = ['USDT (TRC-20)', 'USDT (ERC-20)', 'BTC'];

app.post('/api/public/apply', (req, res) => {
  if (!store.settings.acceptingApplications) {
    return res.status(403).json({ error: 'New vendor applications are currently paused.' });
  }
  const { name, website, email, discord, description, monthlyVolume = 15000, payoutMethod = 'USDT (TRC-20)' } = req.body || {};
  const about = String(description || '').trim();
  const mail = String(email || '').trim().toLowerCase();
  if (!website || !mail || !discord) {
    return res.status(400).json({ error: 'Website, email, and Discord are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (about.length < 90) {
    return res.status(400).json({ error: 'Describe what you sell in at least 90 characters.' });
  }
  const cashout = CRYPTO_PAYOUTS.includes(payoutMethod) ? payoutMethod : 'USDT (TRC-20)';

  const vol = Math.max(500, Number(monthlyVolume) || 15000);
  const tier = vol >= 50000 ? 'enterprise' : vol >= 10000 ? 'growth' : 'starter';
  const rate = store.settings.commissions[tier];
  const id = `vnd_${crypto.randomBytes(3).toString('hex')}`;
  const apiKey = `rl_${crypto.randomBytes(8).toString('hex')}`;

  const vendor = {
    id,
    name: (name || website.replace(/^https?:\/\//, '').split('/')[0]).slice(0, 60),
    website: String(website).slice(0, 140),
    email: mail,
    discord: String(discord).replace(/^@/, '').slice(0, 80),
    contact: `${mail} · ${String(discord).replace(/^@/, '')}`,
    description: about.slice(0, 1200),
    tier,
    rate,
    status: 'pending',
    rails: { stripe: true, paypal: true },
    payoutMethod: cashout,
    payoutDest: 'Pending crypto wallet',
    apiKey,
    monthlyVolume: vol,
    createdAt: new Date().toISOString()
  };

  store.vendors.unshift(vendor);
  saveStore(store);
  res.status(201).json({
    ok: true,
    inbox: APPLY_INBOX,
    mail: {
      _subject: `Relay vendor application — ${vendor.name}`,
      _template: 'table',
      _replyto: vendor.email,
      store: vendor.name,
      website: vendor.website,
      email: vendor.email,
      discord: vendor.discord,
      monthly_volume_usd: String(vendor.monthlyVolume),
      what_they_sell: vendor.description
    }
  });
});

// ---------------------------------------------------------------------------
// Authentication & Session Endpoints
// ---------------------------------------------------------------------------
function startSession(res, user) {
  const token = crypto.randomBytes(24).toString('hex');
  const ttlMs = 24 * 3600 * 1000;
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + ttlMs });
  persistSessions();
  res.setHeader(
    'Set-Cookie',
    `relay_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${BASE_URL.startsWith('https://') ? '; Secure' : ''}`
  );
  return token;
}

app.post('/api/auth/signup', (req, res) => {
  const { name = '', email = '', password = '', confirmPassword = '' } = req.body || {};
  const cleanName = String(name).trim().slice(0, 80);
  const normalizedEmail = String(email).trim().toLowerCase();
  const cleanPassword = String(password);
  if (cleanName.length < 2) return res.status(400).json({ error: 'Enter your name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Enter a valid email.' });
  }
  if (cleanPassword.length < 8) return res.status(400).json({ error: 'Use at least 8 characters.' });
  if (cleanPassword !== String(confirmPassword)) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (store.users.some((user) => user.email === normalizedEmail)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const user = makeUserRecord({
    id: `usr_${crypto.randomBytes(6).toString('hex')}`,
    name: cleanName,
    email: normalizedEmail,
    password: cleanPassword,
    role: 'member',
    temp: false,
    expiresAt: null,
    note: 'Signed up on the site'
  });
  store.users.push(user);
  saveStore(store);
  const token = startSession(res, user);
  res.status(201).json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role }
  });
});

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

  const token = startSession(res, user);
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

app.post('/api/auth/account', (req, res) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) return res.status(401).json({ error: 'Sign in again.' });
  const user = store.users.find((item) => item.id === sessionUser.id && item.active);
  if (!user) return res.status(401).json({ error: 'Sign in again.' });

  const { name = '', email = '', currentPassword = '', newPassword = '' } = req.body || {};
  const attemptHash = hashPassword(String(currentPassword), user.salt);
  const passwordOk = crypto.timingSafeEqual(Buffer.from(attemptHash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
  if (!passwordOk) return res.status(401).json({ error: 'Current password is wrong.' });

  const cleanName = String(name).trim().slice(0, 80);
  if (cleanName.length < 2) return res.status(400).json({ error: 'Enter your name.' });
  const nextEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
    return res.status(400).json({ error: 'Enter a valid email.' });
  }
  if (store.users.some((item) => item.email === nextEmail && item.id !== user.id)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  if (newPassword && String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  user.name = cleanName;
  user.email = nextEmail;
  if (newPassword) {
    user.salt = crypto.randomBytes(12).toString('hex');
    user.passwordHash = hashPassword(String(newPassword), user.salt);
    user.tempPasswordHint = null;
    user.isTemp = false;
  }
  saveStore(store);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.relay_session) sessions.delete(cookies.relay_session);
  persistSessions();
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
  const vendorScope = isAdmin ? null : (req.user.vendorId || null);
  const visibleOrders = isAdmin
    ? store.orders
    : store.orders.filter((o) => vendorScope && o.vendorId === vendorScope);

  const grossVolume = visibleOrders
    .filter((o) => o.status !== 'refunded')
    .reduce((s, o) => s + o.gross, 0);
  const netRevenue = visibleOrders
    .filter((o) => o.status !== 'refunded')
    .reduce((s, o) => s + o.fee, 0);
  const pendingPayouts = store.payouts
    .filter((p) => p.status === 'pending' && (isAdmin || p.vendorId === vendorScope))
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
      mode: hasRealStripeKey ? stripeSecretMode(STRIPE_SECRET_KEY) : 'sandbox',
      hasPublishableKey: Boolean(STRIPE_PUBLISHABLE_KEY) && !STRIPE_PUBLISHABLE_KEY.includes('replace_me'),
      hasSecretKey: hasRealStripeKey,
      hasWebhookSecret: Boolean(STRIPE_WEBHOOK_SECRET) && !STRIPE_WEBHOOK_SECRET.includes('replace_me'),
      webhookEndpoint: `${BASE_URL}/api/stripe/webhook`
    },
    settings: store.settings,
    orders: visibleOrders,
    vendors: isAdmin ? store.vendors : store.vendors.filter((v) => v.id === vendorScope),
    payouts: isAdmin ? store.payouts : store.payouts.filter((p) => p.vendorId === vendorScope)
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
    for (const k of ['starter', 'growth', 'enterprise', 'paypalStarter', 'paypalGrowth', 'paypalEnterprise', 'paypalMarkup', 'fixedFee']) {
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
  res.json({ ok: true, service: 'relay', storage: useDatabase ? 'mysql' : 'file' });
});

// Serve static frontend files
function sendDesk(res) {
  res.sendFile(path.join(__dirname, 'admin.html'));
}

app.get(['/login', '/dashboard'], (_req, res) => sendDesk(res));
app.get(['/admin', '/admin.html'], (req, res) => {
  res.redirect(getSessionUser(req) ? '/dashboard' : '/login');
});

app.use(express.static(__dirname, { extensions: ['html'] }));

async function start() {
  if (database.enabled()) {
    try {
      await database.init();
      useDatabase = true;
      const existing = await database.read();
      store = ensureVendorLogin(existing || createInitialStore());
      await database.writeNow(store);
    } catch (err) {
      console.error('Could not open the MySQL database. Wait until Aiven says Running, then set DATABASE_URL on the relay web service to the copied Service URI.');
      console.error(err.message);
      process.exit(1);
    }
  } else {
    store = loadStore();
    console.log('Account storage: data/store.json');
  }
  loadSessions();
  app.listen(PORT, '0.0.0.0', () => {
    const stripeMode = hasRealStripeKey ? stripeSecretMode(STRIPE_SECRET_KEY) : 'sandbox';
    console.log(`Relay server listening at ${BASE_URL} (Stripe mode: ${stripeMode})`);
  });
}

start();
