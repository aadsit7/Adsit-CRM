// ============================================
// Login View
// ============================================

import { login, beginGoogleRedirect, takeLoginError, getOAuthRedirectUri, storeAccessToken, getRememberedAdminEmail } from '../auth.js';
import { navigate } from '../router.js';
import { CONFIG } from '../config.js';
import { el, $, mount } from '../utils/dom.js';

// After a failed Google sign-in we force the account chooser on the next tap
// so the admin can pick a different account.
let forceAccountChooser = false;

// Google "G" logo, inlined so the button renders instantly with no network
// dependency (the whole reason GIS's own button was unreliable on iPhone).
const GOOGLE_G_SVG = '<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.859-3.048.859-2.344 0-4.328-1.583-5.036-3.71H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.346l2.582-2.581C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>';

// OAuth token client for requesting Sheets API access token
let tokenClient = null;

/**
 * Initialize just the OAuth token client (no UI). Safe to call on any page
 * for returning admin sessions so the token can be refreshed without showing
 * the login screen.
 */
export function initTokenClient() {
  const clientId = CONFIG.GOOGLE_CLIENT_ID;
  if (!clientId || clientId === 'YOUR_GOOGLE_CLIENT_ID_HERE') return;

  const tryInit = () => {
    if (window.google?.accounts?.oauth2 && !tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: CONFIG.OAUTH_SCOPES,
        callback: () => {},
      });
    }
  };

  if (window.google?.accounts?.oauth2) {
    tryInit();
  } else {
    const check = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(check);
        tryInit();
      }
    }, 100);
    setTimeout(() => clearInterval(check), 8000);
  }
}

export const title = 'Login';

export async function render(container) {
  const app = document.getElementById('app');
  app.className = 'app-shell--login';

  const card = el('div', {
    class: 'login-card',
    style: {
      background: 'white',
      borderRadius: 'var(--radius-xl)',
      padding: 'var(--space-10)',
      width: '100%',
      maxWidth: '420px',
      boxShadow: 'var(--shadow-xl)',
    }
  },
    // Logo
    el('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        marginBottom: 'var(--space-8)',
      }
    },
      el('h1', {
        style: {
          fontSize: 'var(--text-2xl)',
          fontWeight: 'var(--font-bold)',
          color: 'var(--color-text-primary)',
          marginBottom: 'var(--space-2)',
        }
      }, 'Partner Portal'),
      el('p', {
        style: {
          fontSize: 'var(--text-sm)',
          color: 'var(--color-text-secondary)',
        }
      }, 'Sign in to access your dashboard')
    ),

    // Partner login form
    el('form', { id: 'login-form', onSubmit: handleLogin },
      el('div', { class: 'form-group' },
        el('label', { class: 'form-label', for: 'username' }, 'Username'),
        el('input', {
          class: 'form-input',
          type: 'text',
          id: 'username',
          name: 'username',
          placeholder: 'Enter your username',
          required: true,
          autocomplete: 'username',
          autocapitalize: 'off',
          autocorrect: 'off',
          spellcheck: 'false',
        })
      ),
      el('div', { class: 'form-group' },
        el('label', { class: 'form-label', for: 'password' }, 'Password'),
        el('input', {
          class: 'form-input',
          type: 'password',
          id: 'password',
          name: 'password',
          placeholder: 'Enter your password',
          required: true,
          autocomplete: 'current-password',
        })
      ),
      el('div', {
        id: 'login-error',
        style: {
          fontSize: 'var(--text-sm)',
          color: 'var(--color-danger)',
          marginBottom: 'var(--space-4)',
          minHeight: '20px',
        }
      }),
      el('button', {
        class: 'btn btn--primary btn--lg btn--full',
        type: 'submit',
        id: 'login-btn',
      }, 'Sign In')
    ),

    // Divider
    el('div', {
      class: 'login-divider',
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-4)',
        margin: 'var(--space-6) 0',
      }
    },
      el('div', { style: { flex: '1', height: '1px', background: 'var(--color-border)' } }),
      el('span', { style: { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'var(--font-medium)' } }, 'Admin Access'),
      el('div', { style: { flex: '1', height: '1px', background: 'var(--color-border)' } }),
    ),

    // Admin Google SSO. Our own button kicks off a full-page OAuth redirect
    // (see beginGoogleRedirect). We deliberately do NOT use Google Identity
    // Services' rendered button / One Tap here: on iPhone (where every browser
    // is WebKit) those depend on popups and partitioned third-party storage,
    // so the button silently failed to render and admins could not sign in. A
    // plain button plus a top-level redirect behaves the same on desktop and
    // iPhone, and the button — being our own HTML — always appears.
    el('div', { id: 'google-sso-section' },
      el('button', {
        class: 'btn-google',
        type: 'button',
        id: 'google-signin-btn',
        onClick: handleGoogleSignIn,
      },
        el('span', { class: 'btn-google__icon', html: GOOGLE_G_SVG }),
        el('span', { class: 'btn-google__text' }, 'Sign in with Google')
      ),
      el('div', {
        id: 'google-error',
        style: {
          fontSize: 'var(--text-sm)',
          color: 'var(--color-danger)',
          marginTop: 'var(--space-2)',
          textAlign: 'center',
          minHeight: '20px',
        }
      })
    ),

    // Footer
    el('div', {
      style: {
        marginTop: 'var(--space-6)',
        textAlign: 'center',
        fontSize: 'var(--text-xs)',
        color: 'var(--color-text-muted)',
      }
    }, 'Secure partner access')
  );

  mount(container, card);

  // Focus username field
  setTimeout(() => {
    const usernameInput = $('#username');
    if (usernameInput) usernameInput.focus();
  }, 100);

  setupGoogleSignIn();
}

/**
 * Wire up the admin Google sign-in button. No waiting on any external library:
 * the button is plain HTML and sign-in is a full-page redirect, so it works
 * even if the Google script is slow or blocked (as it effectively was on
 * iPhone). Also kicks off the OAuth token client for silent refresh when the
 * GIS library is present (best-effort; not on the login critical path).
 */
function setupGoogleSignIn() {
  const clientId = CONFIG.GOOGLE_CLIENT_ID;

  // No OAuth client configured → offer admin username/password instead.
  if (!clientId || clientId === 'YOUR_GOOGLE_CLIENT_ID_HERE') {
    showAdminFallback();
    return;
  }

  // Surface a sign-in error carried over from the redirect's return leg.
  const pending = takeLoginError();
  if (pending) {
    forceAccountChooser = true; // let them pick a different account next tap
    const errorEl = $('#google-error');
    if (errorEl) errorEl.textContent = pending;
  }

  // Log the exact redirect URI that must be registered under the OAuth
  // client's "Authorized redirect URIs" — saves digging when configuring.
  console.info('[Partner Portal] Google OAuth redirect URI to authorize:', getOAuthRedirectUri());

  // Prepare the silent-refresh token client if the GIS library is available.
  initTokenClient();
}

/**
 * Start admin sign-in: redirect the whole page to Google. The page unloads,
 * so there's nothing to await — completeGoogleRedirect() finishes the job
 * when Google sends the browser back.
 */
function handleGoogleSignIn() {
  const errorEl = $('#google-error');
  const btn = $('#google-signin-btn');
  const label = btn?.querySelector('.btn-google__text');
  try {
    if (errorEl) errorEl.textContent = '';
    if (btn) btn.disabled = true;
    if (label) label.textContent = 'Redirecting to Google…';
    // login_hint: on a device that has signed in before, Google skips the
    // account chooser and (with a live Google session) bounces straight
    // back with no UI at all. Omitted after a failed attempt, where the
    // whole point is letting the user pick a different account.
    beginGoogleRedirect({
      target: '/admin/dashboard',
      chooseAccount: forceAccountChooser,
      loginHint: forceAccountChooser ? null : getRememberedAdminEmail(),
    });
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message || 'Google sign-in is unavailable';
    if (btn) btn.disabled = false;
    if (label) label.textContent = 'Sign in with Google';
  }
}

/**
 * Show fallback admin username/password when Google SSO isn't configured.
 */
function showAdminFallback() {
  const section = $('#google-sso-section');
  if (!section) return;

  section.innerHTML = '';
  section.appendChild(
    el('button', {
      class: 'btn btn--secondary btn--lg btn--full',
      type: 'button',
      onClick: handleAdminFallbackLogin,
      id: 'admin-fallback-btn',
    }, 'Sign in as Admin')
  );
  section.appendChild(
    el('div', {
      id: 'google-error',
      style: {
        fontSize: 'var(--text-sm)',
        color: 'var(--color-danger)',
        marginTop: 'var(--space-2)',
        textAlign: 'center',
        minHeight: '20px',
      }
    })
  );
  section.appendChild(
    el('p', {
      style: {
        fontSize: 'var(--text-xs)',
        color: 'var(--color-text-muted)',
        textAlign: 'center',
        marginTop: 'var(--space-2)',
      }
    }, 'Google SSO not configured — using password login')
  );
}

/**
 * Fallback: admin logs in with username/password when Google SSO is not set up.
 */
async function handleAdminFallbackLogin() {
  const errorEl = $('#google-error');
  const btn = $('#admin-fallback-btn');

  // Prompt using the username/password fields
  const username = $('#username')?.value?.trim();
  const password = $('#password')?.value;

  if (!username || !password) {
    if (errorEl) errorEl.textContent = 'Enter admin username and password above, then click here';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in...';
  if (errorEl) errorEl.textContent = '';

  try {
    // Use direct login but allow admin in fallback mode
    const { loginAsAdmin } = await import('../auth.js');
    const user = await loginAsAdmin(username, password);
    navigate('/admin/dashboard');
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message || 'Invalid credentials';
    btn.disabled = false;
    btn.textContent = 'Sign in as Admin';
  }
}

/**
 * Wait briefly for the OAuth tokenClient to initialize. Returns true if
 * the client is ready within the timeout, false otherwise. Used by
 * refreshAccessToken so a refresh triggered immediately after page load
 * isn't lost just because the GIS library hasn't finished loading yet.
 */
function waitForTokenClient(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (tokenClient) { resolve(true); return; }
    initTokenClient();
    const start = Date.now();
    const check = setInterval(() => {
      if (tokenClient) {
        clearInterval(check);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve(false);
      }
    }, 100);
  });
}

/**
 * Refresh the access token silently (exported for use by sheets.js on 401).
 * Uses prompt: 'none' so Google never shows the account chooser here — if
 * interaction would be required, the call fails and we resolve null. The
 * caller (page-load init, scheduled refresh, or sheets.js 401 retry) treats
 * null as "stay logged in but operate without a fresh token" rather than
 * popping a chooser on the user.
 *
 * Stores the new token (with Google's actual expires_in) before resolving,
 * so callers don't have to.
 */
let refreshInFlight = null;

export async function refreshAccessToken() {
  // Coalesce concurrent callers into one GIS request. Several 401'd reads
  // retry in parallel (e.g. the dashboard's three-sheet Promise.all after
  // token expiry), and each call used to overwrite the shared
  // tokenClient.callback — earlier waiters then hung until their 10s
  // timeout and resolved null even though a fresh token arrived.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const ready = await waitForTokenClient();
    if (!ready) return null;

    return new Promise((resolve) => {
      // Hard timeout so a stuck callback can't leave the scheduler hanging
      const timeout = setTimeout(() => resolve(null), 10000);

      tokenClient.callback = (tokenResponse) => {
        clearTimeout(timeout);
        if (tokenResponse?.access_token) {
          storeAccessToken(tokenResponse.access_token, tokenResponse.expires_in);
          resolve(tokenResponse.access_token);
        } else {
          resolve(null);
        }
      };
      try {
        tokenClient.requestAccessToken({ prompt: 'none' });
      } catch {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  })().finally(() => { refreshInFlight = null; });

  return refreshInFlight;
}

/**
 * Partner login handler (username + password).
 */
async function handleLogin(e) {
  e.preventDefault();

  const username = $('#username').value.trim();
  const password = $('#password').value;
  const errorEl = $('#login-error');
  const btn = $('#login-btn');

  if (!username || !password) {
    errorEl.textContent = 'Please enter both username and password';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in...';
  errorEl.textContent = '';

  try {
    const user = await login(username, password);
    navigate('/partner/opportunities');
  } catch (err) {
    errorEl.textContent = err.message || 'Invalid username or password';
    btn.disabled = false;
    btn.textContent = 'Sign In';
    $('#password').value = '';
    $('#password').focus();
  }
}

export function cleanup() {}
