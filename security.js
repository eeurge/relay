const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

function redact(value) {
  return String(value || '')
    .replace(/(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, '$1_$2_[redacted]')
    .replace(/whsec_[A-Za-z0-9]+/g, 'whsec_[redacted]')
    .replace(/mysql:\/\/[^@\s]+@/gi, 'mysql://[redacted]@');
}

function logSafe(message) {
  console.error(redact(message));
}

const CARD_FIELD = /^(cvc|cvv|cid|csc|pan|cardnumber|card_number|cc_number|credit_card|cardcvc|exp_month|exp_year)$/i;

function containsCardData(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, nested] of Object.entries(value)) {
    if (CARD_FIELD.test(key)) return true;
    if (nested && typeof nested === 'object' && containsCardData(nested)) return true;
  }
  return false;
}

function rejectCardFields(req, res, next) {
  if (req.body && containsCardData(req.body)) {
    return res.status(400).json({ error: 'Card numbers and CVC are not accepted. Use Stripe Checkout.' });
  }
  next();
}

function cookieFlags(req) {
  const https = String(process.env.BASE_URL || '').startsWith('https://')
    || Boolean(req.secure)
    || req.headers['x-forwarded-proto'] === 'https';
  return `HttpOnly; Path=/; SameSite=Lax${https ? '; Secure' : ''}`;
}

function passwordsMatch(leftHex, rightHex) {
  const left = Buffer.from(String(leftHex || ''), 'hex');
  const right = Buffer.from(String(rightHex || ''), 'hex');
  if (!left.length || left.length !== right.length) return false;
  return require('crypto').timingSafeEqual(left, right);
}

function parseBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});
    if (!result.success) {
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Invalid request.' });
    }
    req.body = result.data;
    next();
  };
}

const emailField = z.string({ required_error: 'Enter a valid email.' }).trim().email('Enter a valid email.').max(140);
const optionalEmail = z.union([z.literal(''), emailField]).optional();

const schemas = {
  login: z.object({
    email: emailField,
    password: z.string({ required_error: 'Enter a password.' }).min(1, 'Enter a password.')
  }).strip(),
  signup: z.object({
    name: z.string({ required_error: 'Enter your name.' }).trim().min(2, 'Enter your name.').max(80),
    email: emailField,
    password: z.string({ required_error: 'Use at least 8 characters.' }).min(8, 'Use at least 8 characters.'),
    confirmPassword: z.string({ required_error: 'Use at least 8 characters.' }).min(8, 'Use at least 8 characters.'),
    accessKey: z.string({ required_error: 'Enter your access key.' }).trim().min(1, 'Enter your access key.').max(200)
  }).strip().refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword']
  }),
  google: z.object({
    credential: z.string().max(8000).optional().default(''),
    accessToken: z.string().max(8000).optional().default(''),
    accessKey: z.string().max(200).optional().default('')
  }).strip(),
  account: z.object({
    name: z.string().trim().min(2, 'Enter your name.').max(80),
    email: emailField,
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: z.string().max(200).optional().default('')
  }).strip(),
  apply: z.object({
    name: z.string().trim().max(60).optional().default(''),
    website: z.string().trim().min(1, 'Website, email, and Discord are required.').max(140),
    email: emailField,
    discord: z.string().trim().min(1, 'Website, email, and Discord are required.').max(80),
    description: z.string().trim().min(90, 'Describe what you sell in at least 90 characters.').max(1200),
    monthlyVolume: z.coerce.number().min(500).max(5000000).optional().default(15000),
    payoutMethod: z.string().trim().max(60).optional()
  }).strip(),
  checkout: z.object({
    vendorId: z.string().trim().max(40).optional().default('vnd_vendor'),
    item: z.string().trim().max(120).optional().default('Checkout'),
    amountUsd: z.coerce.number().min(1).max(250000).optional().default(49),
    rail: z.enum(['stripe', 'paypal', 'wallets', 'apple'], {
      errorMap: () => ({ message: 'Choose Stripe, PayPal, or Apple Pay.' })
    }).optional().default('stripe'),
    customerEmail: optionalEmail
  }).strip()
};

function helmetMiddleware() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com', 'https://apis.google.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https://www.gstatic.com', 'https://lh3.googleusercontent.com'],
        connectSrc: ["'self'", 'https://formsubmit.co', 'https://www.formsubmit.co', 'https://api.relaypayus.shop', 'https://accounts.google.com', 'https://oauth2.googleapis.com', 'https://www.googleapis.com', 'https://apis.google.com'],
        frameSrc: ["'self'", 'https://accounts.google.com'],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"]
      }
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  });
}

function makeLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message }
  });
}

function pluginCors(req, res, next) {
  const open = req.path === '/relay-plugin.js'
    || req.path === '/api/public/config'
    || req.path === '/api/stripe/create-checkout-session'
    || req.path === '/api/stripe/status';
  if (open) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS' && open) return res.status(204).end();
  next();
}

function errorHandler(err, _req, res, _next) {
  logSafe(err && err.message ? err.message : 'Request failed');
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: 'Something went wrong.' });
}

module.exports = {
  redact,
  logSafe,
  rejectCardFields,
  cookieFlags,
  passwordsMatch,
  parseBody,
  schemas,
  helmetMiddleware,
  makeLimiter,
  pluginCors,
  errorHandler
};
