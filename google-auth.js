const crypto = require('crypto');

const OAUTH_COOKIE = 'relay_oauth';
const OAUTH_TTL_MS = 10 * 60 * 1000;
const AUTH_SCOPE = 'openid email profile';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PRODUCTION_ORIGINS = [
  'https://relaypayus.shop',
  'https://www.relaypayus.shop'
];

const AUTH_ERROR_MESSAGES = {
  cancelled: 'Google sign-in was cancelled.',
  not_configured: 'Google sign-in is not configured.',
  failed: 'Google sign-in failed. Try again.',
  denied: 'Google did not authorize this sign-in.',
  expired: 'Google sign-in expired. Try again.'
};

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function googleClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || '').trim();
}

function googleClientSecret() {
  return String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
}

function googleOAuthConfigured() {
  return Boolean(googleClientId() && googleClientSecret());
}

function signupAccessKey() {
  return String(process.env.SIGNUP_ACCESS_KEY || '').trim();
}

function accessKeyMatches(provided) {
  const expected = signupAccessKey();
  if (!expected) return false;
  const left = crypto.createHash('sha256').update(String(provided || '')).digest();
  const right = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

function extraOrigins() {
  const extras = ['http://127.0.0.1:8080', 'http://localhost:8080'];
  const base = String(process.env.BASE_URL || '').replace(/\/$/, '').trim();
  if (base) extras.push(base);
  return extras;
}

function allowedOrigins() {
  return new Set([...PRODUCTION_ORIGINS, ...extraOrigins()]);
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http'))
    .split(',')[0]
    .trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  if (!host) return '';
  return `${proto}://${host}`.replace(/\/$/, '');
}

function publicOrigin(req) {
  const allowed = allowedOrigins();
  const fromReq = requestOrigin(req);
  if (fromReq && allowed.has(fromReq)) return fromReq;
  const base = String(process.env.BASE_URL || '').replace(/\/$/, '').trim();
  if (base && allowed.has(base)) return base;
  return PRODUCTION_ORIGINS[0];
}

function oauthRedirectUri(req) {
  return `${publicOrigin(req)}/api/auth/google/callback`;
}

function authorizedJavaScriptOrigins() {
  return [...allowedOrigins()];
}

function authorizedRedirectUris() {
  return [...allowedOrigins()].map((origin) => `${origin}/api/auth/google/callback`);
}

function safeNextPath(raw) {
  const value = String(raw || '').trim();
  if (value === '/login' || value === '/') return value;
  return '/';
}

function dashboardPathFor(_user) {
  return '/dashboard';
}

function authErrorMessage(code) {
  return AUTH_ERROR_MESSAGES[code] || AUTH_ERROR_MESSAGES.failed;
}

function oauthSigningKey() {
  return googleClientSecret() || googleClientId() || 'relay-oauth';
}

function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', oauthSigningKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function readSigned(raw) {
  const text = String(raw || '');
  const idx = text.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = text.slice(0, idx);
  const mac = text.slice(idx + 1);
  const expected = crypto.createHmac('sha256', oauthSigningKey()).update(body).digest('base64url');
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (!left.length || left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function createOauthHandshake(nextPath) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return {
    s: crypto.randomBytes(16).toString('hex'),
    v: verifier,
    n: crypto.randomBytes(16).toString('hex'),
    p: safeNextPath(nextPath),
    t: Date.now(),
    c: challenge
  };
}

function serializeHandshake(handshake) {
  return signPayload({
    s: handshake.s,
    v: handshake.v,
    n: handshake.n,
    p: handshake.p,
    t: handshake.t
  });
}

function readHandshake(raw) {
  const payload = readSigned(raw);
  if (!payload || !payload.s || !payload.v || !payload.n || !payload.t) return null;
  if (Date.now() - Number(payload.t) > OAUTH_TTL_MS) return null;
  return {
    s: String(payload.s),
    v: String(payload.v),
    n: String(payload.n),
    p: safeNextPath(payload.p),
    t: Number(payload.t)
  };
}

function buildAuthorizeUrl({ state, challenge, nonce, redirectUri }) {
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: AUTH_SCOPE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    access_type: 'online'
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

function publicGoogleProfile(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  const sub = String(payload.sub || '').trim();
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!sub || !email || !emailVerified) {
    throw fail(401, 'Google account is not verified.');
  }
  return {
    googleSub: sub,
    email,
    name: String(payload.name || email.split('@')[0]).slice(0, 80),
    picture: payload.picture ? String(payload.picture).slice(0, 500) : null
  };
}

function audienceMatches(payload, clientId) {
  return payload.aud === clientId || payload.azp === clientId;
}

async function verifyGoogleIdToken(idToken, { nonce = '' } = {}) {
  const clientId = googleClientId();
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !audienceMatches(payload, clientId)) {
    throw fail(401, 'Google sign-in failed.');
  }
  const iss = String(payload.iss || '');
  if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') {
    throw fail(401, 'Google sign-in failed.');
  }
  if (nonce) {
    if (String(payload.nonce || '') !== nonce) throw fail(401, 'Google sign-in failed.');
  }
  return publicGoogleProfile(payload);
}

async function exchangeAuthorizationCode({ code, verifier, redirectUri }) {
  const body = new URLSearchParams({
    code: String(code || ''),
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.id_token) {
    throw fail(401, 'Google sign-in failed.');
  }
  return payload;
}

async function completeOAuthLogin({ code, handshake, redirectUri }) {
  const tokens = await exchangeAuthorizationCode({
    code,
    verifier: handshake.v,
    redirectUri
  });
  return verifyGoogleIdToken(tokens.id_token, { nonce: handshake.n });
}

async function verifyGoogleUser({ credential = '', accessToken = '' }) {
  const clientId = googleClientId();
  if (!clientId) throw fail(503, 'Google sign-in is not configured.');

  const idToken = String(credential || '').trim();
  if (idToken) return verifyGoogleIdToken(idToken);

  const token = String(accessToken || '').trim();
  if (!token) throw fail(400, 'Missing Google credential.');

  const metaRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !audienceMatches(meta, clientId)) {
    throw fail(401, 'Google sign-in failed.');
  }

  const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const payload = await profileRes.json().catch(() => ({}));
  if (!profileRes.ok) throw fail(401, 'Google sign-in failed.');
  return publicGoogleProfile(payload);
}

function mapGoogleCallbackError(queryError) {
  const code = String(queryError || '').trim();
  if (code === 'access_denied') return 'cancelled';
  if (code) return 'denied';
  return 'failed';
}

module.exports = {
  OAUTH_COOKIE,
  OAUTH_TTL_MS,
  AUTH_ERROR_MESSAGES,
  googleClientId,
  googleClientSecret,
  googleOAuthConfigured,
  signupAccessKey,
  accessKeyMatches,
  publicOrigin,
  oauthRedirectUri,
  authorizedJavaScriptOrigins,
  authorizedRedirectUris,
  safeNextPath,
  dashboardPathFor,
  authErrorMessage,
  createOauthHandshake,
  serializeHandshake,
  readHandshake,
  buildAuthorizeUrl,
  completeOAuthLogin,
  verifyGoogleUser,
  mapGoogleCallbackError
};
