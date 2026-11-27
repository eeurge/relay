(function () {
  const script = document.currentScript;
  const API_BASE = (script && script.dataset.apiBase) || 'https://api.relaypayus.shop';
  const GOOGLE_CLIENT_ID = (script && script.dataset.googleClientId) || '';

  async function csrfToken() {
    const res = await fetch(`${API_BASE}/auth/csrf`, { credentials: 'include' });
    const data = await res.json();
    return data.csrfToken;
  }

  async function getMe() {
    const res = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' });
    if (!res.ok) return { authenticated: false, user: null };
    return res.json();
  }

  async function signOut() {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
  }

  async function exchangeCredential(credential) {
    const token = await csrfToken();
    const res = await fetch(`${API_BASE}/auth/google`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': token
      },
      body: JSON.stringify({ credential })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Google sign-in failed.');
    return data;
  }

  function setError(button, message) {
    const form = button.closest('form');
    const err = form && form.querySelector('.alert-err, [id$="-error"]');
    if (!err) return;
    err.hidden = false;
    err.textContent = message;
  }

  function waitForGoogle() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.id) return resolve();
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (window.google && window.google.accounts && window.google.accounts.id) {
          clearInterval(timer);
          resolve();
        } else if (ticks > 80) {
          clearInterval(timer);
          reject(new Error('Google sign-in did not load.'));
        }
      }, 50);
    });
  }

  async function startGoogle(button) {
    if (!GOOGLE_CLIENT_ID) {
      setError(button, 'Set your Google client ID on the page to enable Google sign-in.');
      return;
    }
    await waitForGoogle();
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response) => {
        try {
          await exchangeCredential(response.credential);
          if (typeof window.relaypayOnGoogleSignIn === 'function') {
            window.relaypayOnGoogleSignIn();
            return;
          }
          window.location.reload();
        } catch (err) {
          setError(button, err.message || 'Google sign-in failed.');
        }
      },
      ux_mode: 'popup',
      auto_select: false
    });
    window.google.accounts.id.prompt((notification) => {
      if (notification && (notification.isNotDisplayed() || notification.isSkippedMoment())) {
        const host = button.parentElement;
        let slot = host.querySelector('[data-google-fallback]');
        if (!slot) {
          slot = document.createElement('div');
          slot.dataset.googleFallback = '1';
          slot.style.width = '100%';
          host.insertBefore(slot, button);
        }
        button.hidden = true;
        window.google.accounts.id.renderButton(slot, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          width: slot.offsetWidth || 320,
          text: 'continue_with',
          shape: 'rectangular'
        });
      }
    });
  }

  document.querySelectorAll('[data-google-signin]').forEach((button) => {
    button.addEventListener('click', () => {
      startGoogle(button).catch((err) => setError(button, err.message || 'Google sign-in failed.'));
    });
  });

  window.RelaypayAuth = { API_BASE, getMe, signOut };
})();
