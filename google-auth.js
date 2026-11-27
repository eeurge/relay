const crypto = require('crypto');

function googleClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || '').trim();
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

function publicGoogleProfile(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  const sub = String(payload.sub || '').trim();
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!sub || !email || !emailVerified) {
    const err = new Error('Google account is not verified.');
    err.status = 401;
    throw err;
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

async function verifyGoogleUser({ credential = '', accessToken = '' }) {
  const clientId = googleClientId();
  if (!clientId) {
    const err = new Error('Google sign-in is not configured.');
    err.status = 503;
    throw err;
  }

  const idToken = String(credential || '').trim();
  if (idToken) {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !audienceMatches(payload, clientId)) {
      const err = new Error('Google sign-in failed.');
      err.status = 401;
      throw err;
    }
    return publicGoogleProfile(payload);
  }

  const token = String(accessToken || '').trim();
  if (!token) {
    const err = new Error('Missing Google credential.');
    err.status = 400;
    throw err;
  }

  const metaRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !audienceMatches(meta, clientId)) {
    const err = new Error('Google sign-in failed.');
    err.status = 401;
    throw err;
  }

  const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const payload = await profileRes.json().catch(() => ({}));
  if (!profileRes.ok) {
    const err = new Error('Google sign-in failed.');
    err.status = 401;
    throw err;
  }
  return publicGoogleProfile(payload);
}

module.exports = {
  googleClientId,
  signupAccessKey,
  accessKeyMatches,
  verifyGoogleUser
};
