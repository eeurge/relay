(function () {
  const AUTH_ERRORS = {
    cancelled: 'Google sign-in was cancelled.',
    not_configured: 'Google sign-in is not configured.',
    failed: 'Google sign-in failed. Try again.',
    denied: 'Google did not authorize this sign-in.',
    expired: 'Google sign-in expired. Try again.'
  };

  function authErrorMessage(code) {
    return AUTH_ERRORS[String(code || '').trim()] || AUTH_ERRORS.failed;
  }

  async function getMe() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (!res.ok) return { authenticated: false, user: null };
      const data = await res.json();
      if (data && data.authenticated) return data;
    } catch {}
    return { authenticated: false, user: null };
  }

  async function signOut() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {}
  }

  function setError(button, message) {
    const modal = (button && button.closest('.modal-backdrop, .auth-gate')) || document;
    const err = modal.querySelector('#signup-error, #signin-error, #gate-error, .alert-err');
    if (!err) return;
    err.hidden = false;
    err.textContent = message;
  }

  function startGoogle(button) {
    const next = (button && button.getAttribute('data-google-next')) || '/';
    window.location.assign(`/api/auth/google/start?next=${encodeURIComponent(next)}`);
  }

  document.querySelectorAll('[data-google-signin]').forEach((button) => {
    button.addEventListener('click', () => {
      startGoogle(button);
    });
  });

  window.RelaypayAuth = { getMe, signOut, authErrorMessage, startGoogle, setError };
})();
