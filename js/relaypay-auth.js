(function () {
  const script = document.currentScript;
  const FALLBACK_API = (script && script.dataset.apiBase) || 'https://api.relaypayus.shop';
  let googleClientId = (script && script.dataset.googleClientId) || '';
  let apiBase = '';
  let ready = null;

  function joinUrl(base, path) {
    if (!base) return path;
    return `${String(base).replace(/\/$/, '')}${path}`;
  }

  async function readConfig(base) {
    const res = await fetch(joinUrl(base, base ? '/auth/config' : '/api/auth/google-config'), {
      credentials: 'include'
    });
    if (!res.ok) return '';
    const data = await res.json().catch(() => ({}));
    return String(data.googleClientId || '').trim();
  }

  async function resolveClientId() {
    if (googleClientId) return googleClientId;
    if (ready) return ready;
    ready = (async () => {
      try {
        const fromSite = await readConfig('');
        if (fromSite) {
          apiBase = '';
          googleClientId = fromSite;
          return googleClientId;
        }
      } catch {}
      if (FALLBACK_API) {
        try {
          const fromApi = await readConfig(FALLBACK_API);
          if (fromApi) {
            apiBase = FALLBACK_API;
            googleClientId = fromApi;
            return googleClientId;
          }
        } catch {}
      }
      return '';
    })();
    return ready;
  }

  async function csrfToken() {
    if (!apiBase) return '';
    const res = await fetch(joinUrl(apiBase, '/auth/csrf'), { credentials: 'include' });
    const data = await res.json();
    return data.csrfToken;
  }

  async function getMe() {
    const paths = apiBase
      ? [joinUrl(apiBase, '/auth/me'), '/api/auth/me']
      : ['/api/auth/me', joinUrl(FALLBACK_API, '/auth/me')];
    for (const url of paths) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) continue;
        const data = await res.json();
        if (data && data.authenticated) return data;
      } catch {}
    }
    return { authenticated: false, user: null };
  }

  async function signOut() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
    if (apiBase || FALLBACK_API) {
      try {
        await fetch(joinUrl(apiBase || FALLBACK_API, '/auth/logout'), {
          method: 'POST',
          credentials: 'include'
        });
      } catch {}
    }
  }

  function signupAccessKey() {
    const input = document.getElementById('signup-access-key');
    return input ? String(input.value || '').trim() : '';
  }

  function signupFormError() {
    const name = (document.getElementById('signup-name')?.value || '').trim();
    const email = (document.getElementById('signup-email')?.value || '').trim();
    const password = document.getElementById('signup-password')?.value || '';
    const confirm = document.getElementById('signup-confirm')?.value || '';
    const key = signupAccessKey();
    if (name.length < 2) return 'Enter your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email.';
    if (password.length < 8) return 'Use at least 8 characters.';
    if (password !== confirm) return 'Passwords do not match.';
    if (!key) return 'Access key is invalid.';
    return '';
  }

  async function exchangeCredential({ credential, accessToken }) {
    const token = await csrfToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-csrf-token'] = token;
    const body = {
      credential: credential || '',
      accessToken: accessToken || '',
      accessKey: signupAccessKey()
    };
    const urls = apiBase
      ? [joinUrl(apiBase, '/auth/google'), '/api/auth/google']
      : ['/api/auth/google', joinUrl(FALLBACK_API, '/auth/google')];
    let lastError = 'Google sign-in failed.';
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return data;
        lastError = data.error || lastError;
        if (res.status === 403) break;
      } catch {}
    }
    throw new Error(lastError);
  }

  function setError(button, message) {
    const modal = button.closest('.modal-backdrop') || document;
    const err = modal.querySelector('#signup-error, #signin-error, .alert-err');
    if (!err) return;
    err.hidden = false;
    err.textContent = message;
  }

  function waitForGoogle() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (window.google && window.google.accounts && window.google.accounts.oauth2) {
          clearInterval(timer);
          resolve();
        } else if (ticks > 80) {
          clearInterval(timer);
          reject(new Error('Google sign-in did not load.'));
        }
      }, 50);
    });
  }

  async function finishGoogle(button, payload) {
    await exchangeCredential(payload);
    if (typeof window.relaypayOnGoogleSignIn === 'function') {
      window.relaypayOnGoogleSignIn();
      return;
    }
    window.location.href = '/dashboard';
  }

  async function startGoogle(button) {
    const clientId = await resolveClientId();
    if (!clientId) {
      setError(button, 'Google sign-in is not configured.');
      return;
    }
    const inSignup = Boolean(button.closest('#signup-modal'));
    if (inSignup) {
      const formError = signupFormError();
      if (formError) {
        setError(button, formError);
        return;
      }
    }
    await waitForGoogle();
    const oauth = window.google.accounts.oauth2;
    if (!oauth || typeof oauth.initTokenClient !== 'function') {
      throw new Error('Google sign-in did not load.');
    }
    const tokenClient = oauth.initTokenClient({
      client_id: clientId,
      scope: 'openid email profile',
      callback: async (response) => {
        if (!response || response.error || !response.access_token) {
          setError(button, 'Google sign-in was cancelled.');
          return;
        }
        try {
          await finishGoogle(button, { accessToken: response.access_token });
        } catch (err) {
          setError(button, err.message || 'Google sign-in failed.');
        }
      }
    });
    tokenClient.requestAccessToken({ prompt: inSignup ? 'consent' : '' });
  }

  resolveClientId().catch(() => {});

  document.querySelectorAll('[data-google-signin]').forEach((button) => {
    button.addEventListener('click', () => {
      startGoogle(button).catch((err) => setError(button, err.message || 'Google sign-in failed.'));
    });
  });

  window.RelaypayAuth = { getMe, signOut, resolveClientId };
})();
