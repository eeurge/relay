const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mysql = require('mysql2/promise');
const { OAuth2Client } = require('google-auth-library');

const PORT = Number(process.env.PORT || 8787);
const SITE_ORIGIN = String(process.env.SITE_ORIGIN || 'https://relaypayus.shop').replace(/\/$/, '');
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const SIGNUP_ACCESS_KEY = String(process.env.SIGNUP_ACCESS_KEY || '').trim();
const SESSION_COOKIE = 'rp_session';
const CSRF_COOKIE = 'rp_csrf';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function mysqlUrl() {
  return String(process.env.DATABASE_URL || '').trim();
}

function connectionOptions(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('DATABASE_URL is not a valid mysql:// address. On Aiven, copy the Service URI.');
  }
  if (url.protocol !== 'mysql:') {
    throw new Error('DATABASE_URL must start with mysql://. Google sign-in uses the same Aiven MySQL as the site, not Postgres.');
  }
  if (!url.hostname || !url.username || !url.password) {
    throw new Error('DATABASE_URL is missing the user, the password, or the @ before the host.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'defaultdb';
  const sslMode = (url.searchParams.get('ssl-mode') || url.searchParams.get('sslmode') || '').toUpperCase();
  const options = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    waitForConnections: true,
    connectionLimit: 4,
    connectTimeout: 20000,
    enableKeepAlive: true
  };
  if (sslMode === 'REQUIRED' || url.hostname.endsWith('.aivencloud.com')) {
    options.ssl = { rejectUnauthorized: false };
  }
  return options;
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

function accessKeyMatches(provided) {
  if (!SIGNUP_ACCESS_KEY) return false;
  const left = crypto.createHash('sha256').update(String(provided || '')).digest();
  const right = crypto.createHash('sha256').update(SIGNUP_ACCESS_KEY).digest();
  return crypto.timingSafeEqual(left, right);
}

function publicUser(row) {
  return {
    id: String(row.id),
    email: row.email,
    name: row.name || '',
    picture: row.picture || null
  };
}

const DATABASE_URL = mysqlUrl();
const pool = DATABASE_URL ? mysql.createPool(connectionOptions(DATABASE_URL)) : null;
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
    storage: pool ? 'mysql' : 'unconfigured'
  });
});

app.get('/auth/config', (_req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
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
    const accessToken = String(req.body?.accessToken || '');
    let payload = {};
    if (credential) {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: GOOGLE_CLIENT_ID
      });
      payload = ticket.getPayload() || {};
    } else if (accessToken) {
      const metaRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
      const meta = await metaRes.json().catch(() => ({}));
      if (!metaRes.ok || (meta.aud !== GOOGLE_CLIENT_ID && meta.azp !== GOOGLE_CLIENT_ID)) {
        return res.status(401).json({ error: 'Google sign-in failed.' });
      }
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      payload = await profileRes.json().catch(() => ({}));
      if (!profileRes.ok) return res.status(401).json({ error: 'Google sign-in failed.' });
    } else {
      return res.status(400).json({ error: 'Missing Google credential.' });
    }
    if (!payload.email_verified && payload.email_verified !== 'true') {
      return res.status(401).json({ error: 'Google account is not verified.' });
    }
    if (!payload.sub || !payload.email) {
      return res.status(401).json({ error: 'Google account is not verified.' });
    }

    const email = String(payload.email).trim().toLowerCase();
    const name = String(payload.name || email.split('@')[0]).slice(0, 80);
    const picture = payload.picture ? String(payload.picture).slice(0, 500) : null;

    const [existing] = await pool.query(
      'SELECT id FROM rp_users WHERE google_sub = ? OR email = ? LIMIT 1',
      [payload.sub, email]
    );
    if (!existing[0] && !accessKeyMatches(req.body?.accessKey)) {
      return res.status(403).json({ error: 'Access key is invalid.' });
    }

    await pool.query(
      `INSERT INTO rp_users (google_sub, email, name, picture, last_login_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         email = VALUES(email),
         name = VALUES(name),
         picture = VALUES(picture),
         last_login_at = NOW()`,
      [payload.sub, email, name, picture]
    );
    const [users] = await pool.query(
      'SELECT id, email, name, picture FROM rp_users WHERE google_sub = ? LIMIT 1',
      [payload.sub]
    );
    const user = users[0];
    if (!user) return res.status(500).json({ error: 'Could not save the Google account.' });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_MS);
    await pool.query(
      'INSERT INTO rp_sessions (user_id, token_hash, csrf_token, expires_at) VALUES (?, ?, ?, ?)',
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
  const [rows] = await pool.query(
    `SELECT s.id AS session_id, s.csrf_token, s.expires_at, u.id, u.email, u.name, u.picture
     FROM rp_sessions s
     JOIN rp_users u ON u.id = s.user_id
     WHERE s.token_hash = ?
     LIMIT 1`,
    [hashToken(raw)]
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await pool.query('DELETE FROM rp_sessions WHERE id = ?', [row.session_id]);
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
      await pool.query('DELETE FROM rp_sessions WHERE token_hash = ?', [hashToken(req.cookies[SESSION_COOKIE])]);
    }
  } catch {}
  const clear = { ...cookieOpts(), maxAge: 0 };
  res.cookie(SESSION_COOKIE, '', clear);
  res.cookie(CSRF_COOKIE, '', { ...clear, httpOnly: false });
  res.json({ ok: true });
});

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql.split(';').map((chunk) => chunk.trim()).filter(Boolean);
  for (const statement of statements) {
    await pool.query(statement);
  }
}

async function start() {
  if (pool) {
    await pool.query('SELECT 1');
    await ensureSchema();
  } else {
    console.error('MySQL is not configured. Set DATABASE_URL to the Aiven mysql:// Service URI on the API service.');
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`relaypay-api listening on ${PORT}`);
  });
}

start().catch((err) => {
  console.error('relaypay-api failed to start');
  process.exit(1);
});
