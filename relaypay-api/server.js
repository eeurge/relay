const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { OAuth2Client } = require('google-auth-library');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 8787);
const SITE_ORIGIN = String(process.env.SITE_ORIGIN || 'https://relaypayus.shop').replace(/\/$/, '');
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const SESSION_COOKIE = 'rp_session';
const CSRF_COOKIE = 'rp_csrf';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function postgresUrl() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (/^postgres(ql)?:\/\//i.test(databaseUrl)) return databaseUrl;
  return String(process.env.POSTGRES_URL || '').trim();
}

function cookieOpts() {
  let domain;
  try {
    const host = new URL(SITE_ORIGIN).hostname;
    if (host.endsWith('relaypayus.shop')) domain = '.relaypayus.shop';
  } catch {}
  const secure = SITE_ORIGIN.startsWith('https://');
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    ...(domain ? { domain } : {})
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function publicUser(row) {
  return {
    id: String(row.id),
    email: row.email,
    name: row.name || '',
    picture: row.picture || null
  };
}

const DATABASE_URL = postgresUrl();
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 4
    })
  : null;

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({
  origin: SITE_ORIGIN,
  credentials: true
}));
app.use(cookieParser());
app.use(express.json({ limit: '32kb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'relaypay-api',
    storage: pool ? 'postgres' : 'unconfigured'
  });
});

app.get('/auth/csrf', (req, res) => {
  const csrfToken = crypto.randomBytes(24).toString('hex');
  res.cookie(CSRF_COOKIE, csrfToken, { ...cookieOpts(), httpOnly: false, maxAge: SESSION_MS });
  res.json({ csrfToken });
});

function readCsrf(req) {
  const header = req.get('x-csrf-token') || '';
  const cookie = req.cookies[CSRF_COOKIE] || '';
  return safeEqual(header, cookie);
}

app.post('/auth/google', async (req, res) => {
  try {
    if (!readCsrf(req)) return res.status(403).json({ error: 'CSRF check failed.' });
    if (!pool || !googleClient || !GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: 'Google sign-in is not configured.' });
    }
    const credential = String(req.body?.credential || '');
    if (!credential) return res.status(400).json({ error: 'Missing Google credential.' });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload() || {};
    if (!payload.email_verified || !payload.sub || !payload.email) {
      return res.status(401).json({ error: 'Google account is not verified.' });
    }

    const email = String(payload.email).trim().toLowerCase();
    const name = String(payload.name || email.split('@')[0]).slice(0, 80);
    const picture = payload.picture ? String(payload.picture).slice(0, 500) : null;

    const upsert = await pool.query(
      `INSERT INTO rp_users (google_sub, email, name, picture, last_login_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (google_sub) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         picture = EXCLUDED.picture,
         last_login_at = NOW()
       RETURNING id, email, name, picture`,
      [payload.sub, email, name, picture]
    );
    const user = upsert.rows[0];

    const rawToken = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_MS);
    await pool.query(
      `INSERT INTO rp_sessions (user_id, token_hash, csrf_token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, hashToken(rawToken), csrfToken, expiresAt]
    );

    res.cookie(SESSION_COOKIE, rawToken, { ...cookieOpts(), maxAge: SESSION_MS });
    res.cookie(CSRF_COOKIE, csrfToken, { ...cookieOpts(), httpOnly: false, maxAge: SESSION_MS });
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    res.status(401).json({ error: 'Google sign-in failed.' });
  }
});

async function loadSession(req) {
  if (!pool) return null;
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const result = await pool.query(
    `SELECT s.id AS session_id, s.csrf_token, s.expires_at, u.id, u.email, u.name, u.picture
     FROM rp_sessions s
     JOIN rp_users u ON u.id = s.user_id
     WHERE s.token_hash = $1
     LIMIT 1`,
    [hashToken(raw)]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await pool.query('DELETE FROM rp_sessions WHERE id = $1', [row.session_id]);
    return null;
  }
  return row;
}

app.get('/auth/me', async (req, res) => {
  try {
    const session = await loadSession(req);
    if (!session) return res.json({ authenticated: false, user: null });
    res.json({ authenticated: true, user: publicUser(session) });
  } catch (err) {
    res.status(500).json({ error: 'Session lookup failed.' });
  }
});

app.post('/auth/logout', async (req, res) => {
  try {
    if (pool && req.cookies[SESSION_COOKIE]) {
      await pool.query('DELETE FROM rp_sessions WHERE token_hash = $1', [hashToken(req.cookies[SESSION_COOKIE])]);
    }
  } catch {}
  const clear = { ...cookieOpts(), maxAge: 0 };
  res.cookie(SESSION_COOKIE, '', clear);
  res.cookie(CSRF_COOKIE, '', { ...clear, httpOnly: false });
  res.json({ ok: true });
});

async function start() {
  if (pool) {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
  } else {
    console.error('Postgres is not configured. Set POSTGRES_URL (or a postgres:// DATABASE_URL) on the API service. Do not use the Aiven MySQL URI.');
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`relaypay-api listening on ${PORT}`);
  });
}

start().catch((err) => {
  console.error('relaypay-api failed to start');
  process.exit(1);
});
