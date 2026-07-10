// ============================================
// Authentication Module
// ============================================

import { CONFIG, getRuntimeConfig } from './config.js';
import { sha256 } from './utils/hash.js';
import { readSheetAsObjects, isConfigured } from './sheets.js';

/**
 * Attempt login with username and password (for partners).
 * @returns {Object} user object on success
 * @throws on failure
 */
export async function login(username, password) {
  const passwordHash = await sha256(password);

  // Fetch partners list
  const partners = await readSheetAsObjects(CONFIG.SHEET_PARTNERS);

  // Find matching active user
  const user = partners.find(p => {
    const usernameMatch = p.username?.toLowerCase() === username.toLowerCase();
    const statusMatch = p.status?.toLowerCase() === 'active';

    // In demo mode (no API configured), accept the known password directly
    if (!isConfigured()) {
      return usernameMatch && statusMatch && password === CONFIG.DEFAULT_PASSWORD;
    }

    const passMatch = p.password_hash === passwordHash;
    return usernameMatch && passMatch && statusMatch;
  });

  if (!user) {
    throw new Error('Invalid username or password');
  }

  // If this user is an admin, block — admin must use Google SSO
  if (String(user.is_admin).toUpperCase() === 'TRUE') {
    throw new Error('Admin accounts must sign in with Google');
  }

  // Store session (exclude password hash)
  const session = { ...user };
  delete session.password_hash;
  delete session._rowIndex;
  session.is_admin = false;

  localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(session));
  return session;
}

// ============================================
// Admin Google SSO — full-page OAuth redirect
// ============================================
//
// Why a redirect instead of Google Identity Services' rendered button / One
// Tap: on iOS every browser (Chrome included) runs on WebKit, which blocks the
// popups and partitions the third-party storage GIS relies on. The result on
// iPhone was that the "Sign in with Google" button never even rendered, so
// admins could not sign in. A full-page OAuth redirect is a plain top-level
// navigation to Google and back — no popup, no third-party cookies, no FedCM —
// so it behaves identically on desktop and iPhone.
//
// We use the OpenID implicit flow (response_type="token id_token") so a single
// sign-in returns both the admin's identity (id_token, checked against
// ADMIN_EMAILS) and a Sheets access token (for saving), with no backend to
// exchange a code — which suits this static GitHub Pages site.
//
// TOKEN RENEWAL (the "sign in once" guarantee): the access token Google
// issues lives ~1 hour, while the portal session (localStorage) lives
// indefinitely. GIS's requestAccessToken({prompt:'none'}) cannot renew it on
// iPhone — it needs a popup plus third-party Google cookies, both of which
// WebKit blocks — which is why admins kept being pushed back through the
// login screen on iOS. The fix is the same trick as sign-in: a full-page
// redirect with prompt=none and login_hint. Google answers without showing
// any UI and bounces straight back with a fresh token (<1s), because a
// top-level navigation is first-party at accounts.google.com. The only time
// an admin ever types credentials is the very first sign-in on a device (or
// after signing out of Google itself) — exactly once per device.

const OAUTH_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_STATE_KEY = 'pp_oauth_state';
const OAUTH_NONCE_KEY = 'pp_oauth_nonce';
const OAUTH_TARGET_KEY = 'pp_oauth_target';
const OAUTH_SILENT_KEY = 'pp_oauth_silent';

// Silent re-auth loop guards (sessionStorage, per-tab):
// - attempt timestamp: at most one redirect attempt per minute, so a
//   misbehaving return leg can never ping-pong the page to Google.
// - block timestamp: after Google says interaction is required
//   (login_required etc.), stop attempting for a while — the next attempt
//   would fail identically until the user signs in to Google again.
const SILENT_ATTEMPT_TS_KEY = 'pp_silent_attempt_ts';
const SILENT_BLOCK_TS_KEY = 'pp_silent_block_ts';
const SILENT_ATTEMPT_MIN_INTERVAL_MS = 60 * 1000;
const SILENT_BLOCK_MS = 15 * 60 * 1000;

// Device memory (localStorage, separate from the session): the email of the
// last admin who signed in with Google on this device. The session itself can
// be evicted outside our control — Safari's ITP purges script-writable
// storage after 7 days without a visit, and "clear on exit" browser settings
// wipe it too — which used to dump the admin on the login screen for a full
// interactive Google round-trip. The Google session at accounts.google.com
// survives those purges (it belongs to a different site), so as long as we
// remember WHO signed in here we can restore the whole session silently with
// the same prompt=none redirect used for token renewal. Cleared only by an
// explicit logout: "keep me signed in until I sign out".
const DEVICE_ADMIN_KEY = 'pp_device_admin';

/** Email of the last admin who signed in with Google on this device, or null. */
export function getRememberedAdminEmail() {
  try {
    const email = localStorage.getItem(DEVICE_ADMIN_KEY);
    return email ? String(email).toLowerCase() : null;
  } catch { return null; }
}

function rememberAdminDevice(email) {
  try { localStorage.setItem(DEVICE_ADMIN_KEY, String(email).toLowerCase()); } catch { /* private mode */ }
}

function forgetAdminDevice() {
  try { localStorage.removeItem(DEVICE_ADMIN_KEY); } catch { /* ignore */ }
}

// Carries a sign-in error from completeGoogleRedirect() (which runs on page
// load) to the login view (which renders just after), within the same load.
let _pendingLoginError = null;
export function takeLoginError() {
  const err = _pendingLoginError;
  _pendingLoginError = null;
  return err;
}

/**
 * The exact redirect URI this deployment uses. This value must be registered
 * under the OAuth client's "Authorized redirect URIs" in Google Cloud Console.
 * A trailing index.html is normalized away so one registered URI works whether
 * the user visits /Partner-Portal/ or /Partner-Portal/index.html.
 */
export function getOAuthRedirectUri() {
  let path = window.location.pathname || '/';
  if (path.endsWith('index.html')) path = path.slice(0, -'index.html'.length);
  return window.location.origin + path;
}

function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function safeSessionSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* private mode */ }
}
function safeSessionGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function clearOAuthHandshake() {
  try {
    sessionStorage.removeItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_NONCE_KEY);
    sessionStorage.removeItem(OAUTH_TARGET_KEY);
    sessionStorage.removeItem(OAUTH_SILENT_KEY);
  } catch { /* ignore */ }
}

/**
 * Begin admin sign-in by navigating the whole page to Google's OAuth screen.
 * The page unloads, so this never returns. completeGoogleRedirect() finishes
 * the flow when Google sends the browser back.
 *
 * @param {Object} [opts]
 * @param {string} [opts.target='/admin/dashboard'] - route to land on after success
 * @param {boolean} [opts.chooseAccount=false] - force Google's account chooser
 *   (used after a failed attempt so the admin can pick a different account)
 * @param {boolean} [opts.silent=false] - prompt=none: Google must answer
 *   without showing ANY UI. Used to renew an expired Sheets token for an
 *   already-signed-in admin. On iPhone this is the only refresh mechanism
 *   that works: it's a first-party top-level navigation, so WebKit's ITP
 *   (which kills GIS's popup/iframe refresh) doesn't apply.
 * @param {string} [opts.loginHint] - the admin's email, so Google renews the
 *   right account without raising account_selection_required when several
 *   Google sessions exist in the browser.
 */
export function beginGoogleRedirect({ target = '/admin/dashboard', chooseAccount = false, silent = false, loginHint = null } = {}) {
  const clientId = CONFIG.GOOGLE_CLIENT_ID;
  if (!clientId || clientId === 'YOUR_GOOGLE_CLIENT_ID_HERE') {
    throw new Error('Google sign-in is not configured');
  }

  const state = randomToken();
  const nonce = randomToken();
  safeSessionSet(OAUTH_STATE_KEY, state);
  safeSessionSet(OAUTH_NONCE_KEY, nonce);
  safeSessionSet(OAUTH_TARGET_KEY, target);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getOAuthRedirectUri(),
    response_type: 'token id_token',
    scope: CONFIG.OAUTH_LOGIN_SCOPES,
    nonce,
    state,
    include_granted_scopes: 'true',
  });
  // Omitting `prompt` gives the smoothest SSO: a returning admin with one
  // active Google session is bounced straight back, signed in, with no taps.
  // After a failure we force the chooser so they can switch accounts.
  if (chooseAccount) params.set('prompt', 'select_account');
  if (silent) {
    params.set('prompt', 'none');
    safeSessionSet(OAUTH_SILENT_KEY, '1');
    safeSessionSet(SILENT_ATTEMPT_TS_KEY, String(Date.now()));
  }
  if (loginHint) params.set('login_hint', loginHint);

  window.location.href = `${OAUTH_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Whether a silent (prompt=none) re-auth redirect is currently sensible.
 * All of these must hold:
 * - this device is known to belong to an admin: either an admin session
 *   exists, or the session was evicted but the device marker remembers a
 *   past admin Google sign-in (partners don't use Google, and a device
 *   that never signed in must see the login screen, not a surprise
 *   Google bounce)
 * - the OAuth client and a real spreadsheet are configured (in demo mode no
 *   token is needed, so a redirect would be pure churn)
 * - the browser isn't known-offline (navigating to Google while offline
 *   strands the user on a browser error page)
 * - we haven't just attempted (60s) and Google hasn't recently told us
 *   interaction is required (15min block)
 */
export function canAttemptSilentReauth() {
  const user = getCurrentUser();
  if (user ? !user.is_admin : !getRememberedAdminEmail()) return false;

  const clientId = CONFIG.GOOGLE_CLIENT_ID;
  if (!clientId || clientId === 'YOUR_GOOGLE_CLIENT_ID_HERE') return false;

  const spreadsheetId = getRuntimeConfig('SPREADSHEET_ID') || CONFIG.SPREADSHEET_ID;
  if (!spreadsheetId || spreadsheetId === 'YOUR_SPREADSHEET_ID_HERE') return false;

  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;

  const now = Date.now();
  const lastAttempt = Number(safeSessionGet(SILENT_ATTEMPT_TS_KEY)) || 0;
  if (now - lastAttempt < SILENT_ATTEMPT_MIN_INTERVAL_MS) return false;

  const blockedAt = Number(safeSessionGet(SILENT_BLOCK_TS_KEY)) || 0;
  if (now - blockedAt < SILENT_BLOCK_MS) return false;

  return true;
}

/**
 * Renew the admin's Sheets token — or restore an evicted admin session on a
 * remembered device — by silently bouncing the page through Google
 * (prompt=none) and back to the current route. Returns true when the
 * navigation has started (the page is unloading — stop doing work), false
 * when guards said no (caller should fall back or do nothing).
 */
export function attemptSilentReauth({ target } = {}) {
  if (!canAttemptSilentReauth()) return false;

  const route = target
    || (window.location.hash || '').replace(/^#/, '')
    || '/admin/dashboard';

  try {
    beginGoogleRedirect({
      target: route,
      silent: true,
      loginHint: getCurrentUser()?.email || getRememberedAdminEmail() || undefined,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * If this page load is the return leg of a Google OAuth redirect, finish
 * signing the admin in. Identity comes from the returned id_token, so this is
 * synchronous (no network call) and safe to run before the router reads the
 * URL.
 *
 * @returns {{ok: true, target: string} | {error: string} | null}
 *   - {ok, target} on success: the session is stored and the token-bearing
 *     URL fragment has been replaced with a clean route.
 *   - {error} on failure: the URL is cleaned and the message is stashed for
 *     the login view (see takeLoginError).
 *   - null when this load is not an OAuth return (normal navigation).
 */
export function completeGoogleRedirect() {
  const raw = (window.location.hash || '').replace(/^#/, '');
  // A normal route ("/admin/dashboard") parses to no recognized keys below.
  const params = new URLSearchParams(raw);
  const error = params.get('error');
  const accessToken = params.get('access_token');
  const idToken = params.get('id_token');

  if (!error && !accessToken && !idToken) return null; // not an OAuth return

  const savedState = safeSessionGet(OAUTH_STATE_KEY);
  const savedNonce = safeSessionGet(OAUTH_NONCE_KEY);
  const target = safeSessionGet(OAUTH_TARGET_KEY) || '/admin/dashboard';
  const wasSilent = safeSessionGet(OAUTH_SILENT_KEY) === '1';
  clearOAuthHandshake();

  // Strip the OAuth params out of the URL/history before doing anything else —
  // an access token must never linger in the address bar or back-button history.
  const finish = (route) => {
    const clean = `${getOAuthRedirectUri()}#${route.replace(/^#/, '')}`;
    try { history.replaceState(null, '', clean); }
    catch { window.location.hash = route; }
  };
  const fail = (message, code) => {
    // A failed SILENT renewal (e.g. the Google session is gone, so Google
    // answered login_required) must never log the admin out of the portal or
    // flash an error: keep the existing session — reads still work — block
    // further attempts for a while, and put the user back where they were.
    // The next manual save will explain that a sign-in tap is needed.
    if (wasSilent) {
      safeSessionSet(SILENT_BLOCK_TS_KEY, String(Date.now()));
      const existing = getCurrentUser();
      finish(existing ? target : '/login');
      return { error: code, silent: true };
    }
    _pendingLoginError = message;
    finish('/login');
    return { error: code };
  };

  if (error) {
    return fail(
      error === 'access_denied' ? 'Sign-in was cancelled.' : 'Google sign-in failed. Please try again.',
      error,
    );
  }

  // CSRF: the state echoed back must match the one we sent.
  if (savedState && params.get('state') !== savedState) {
    return fail('Sign-in could not be verified. Please try again.', 'state_mismatch');
  }

  const payload = decodeJwt(idToken);
  if (!payload || !payload.email) {
    return fail('Could not read your Google account. Please try again.', 'bad_id_token');
  }

  // Replay protection: the id_token's nonce must match the one we sent.
  if (savedNonce && payload.nonce && payload.nonce !== savedNonce) {
    return fail('Sign-in could not be verified. Please try again.', 'nonce_mismatch');
  }

  // Authorize the account (demo mode — no Sheets configured — allows any account).
  const email = String(payload.email).toLowerCase();
  const allowed = CONFIG.ADMIN_EMAILS.map(e => e.toLowerCase());
  if (isConfigured() && !allowed.includes(email)) {
    return fail(`${payload.email} is not an authorized admin. Try a different account.`, 'not_admin');
  }

  const session = buildAdminSession(payload, accessToken, params.get('expires_in'));
  localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(session));
  // Mark this device as an admin's: if the browser ever evicts the session
  // (ITP purge, "clear on exit"), the next cold load restores it silently
  // instead of showing the login screen (see canAttemptSilentReauth).
  rememberAdminDevice(email);
  // A successful sign-in clears any silent-renewal block: the Google session
  // demonstrably works again.
  try { sessionStorage.removeItem(SILENT_BLOCK_TS_KEY); } catch { /* ignore */ }
  finish(target);
  return { ok: true, target };
}

/**
 * Build the stored admin session from a decoded id_token payload plus the
 * Sheets access token (when one was granted).
 */
function buildAdminSession(payload, accessToken, expiresInSec) {
  return {
    partner_id: 'p_admin001',
    username: 'admin',
    display_name: payload.name || 'Admin',
    partner_type: '',
    is_admin: true,
    // Kept for login_hint on silent renewals: lets Google renew this exact
    // account without raising account_selection_required when the browser
    // holds several Google sessions.
    email: payload.email ? String(payload.email).toLowerCase() : null,
    google_picture: payload.picture || null,
    tier: 'Admin',
    status: 'active',
    access_token: accessToken || null,
    access_token_expires: accessToken
      ? Date.now() + ((Number(expiresInSec) > 0 ? Number(expiresInSec) : 3600) * 1000)
      : null,
  };
}

/**
 * Decode a JWT token without verification (client-side only).
 * The token is already verified by Google's library.
 */
function decodeJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64).split('').map(c =>
        '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
      ).join('')
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

/**
 * Fallback: Admin login with username/password when Google SSO isn't configured.
 */
export async function loginAsAdmin(username, password) {
  const passwordHash = await sha256(password);
  const partners = await readSheetAsObjects(CONFIG.SHEET_PARTNERS);

  const user = partners.find(p => {
    const usernameMatch = p.username?.toLowerCase() === username.toLowerCase();
    const isAdminUser = String(p.is_admin).toUpperCase() === 'TRUE';
    const statusMatch = p.status?.toLowerCase() === 'active';

    if (!isConfigured()) {
      return usernameMatch && isAdminUser && statusMatch && password === CONFIG.DEFAULT_PASSWORD;
    }

    const passMatch = p.password_hash === passwordHash;
    return usernameMatch && passMatch && isAdminUser && statusMatch;
  });

  if (!user) {
    throw new Error('Invalid admin credentials');
  }

  const session = { ...user };
  delete session.password_hash;
  delete session._rowIndex;
  session.is_admin = true;

  localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(session));
  return session;
}

/**
 * Get the current logged-in user, or null.
 */
export function getCurrentUser() {
  const raw = localStorage.getItem(CONFIG.SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Check if the current user is an admin.
 */
export function isAdmin() {
  const user = getCurrentUser();
  return user?.is_admin === true;
}

/**
 * Get the stored OAuth access token, or null if missing/expired.
 */
export function getAccessToken() {
  const user = getCurrentUser();
  if (!user?.access_token) return null;
  // Expired (with 5-minute buffer)?
  if (user.access_token_expires && Date.now() > user.access_token_expires - 300000) {
    return null;
  }
  return user.access_token;
}

/**
 * Update the stored access token (e.g., after a silent refresh).
 * Accepts optional expiresInSec from Google's tokenResponse so the
 * stored expiry matches what Google actually issued, not a hard-coded
 * assumption. Falls back to 3600 s (Google's default) when omitted.
 */
export function storeAccessToken(token, expiresInSec) {
  const user = getCurrentUser();
  if (!user) return;
  const lifetimeMs = (Number(expiresInSec) > 0 ? Number(expiresInSec) : 3600) * 1000;
  user.access_token = token;
  user.access_token_expires = Date.now() + lifetimeMs;
  localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(user));
}

/**
 * Drop a stored access token that Google has rejected (401/403) while
 * keeping the session itself. Subsequent reads fall back to the API key and
 * the next cold load (e.g. the reload a failed save prompts) renews the
 * token via the silent redirect. The session itself is never torn down here.
 */
export function clearAccessToken() {
  const user = getCurrentUser();
  if (!user) return;
  user.access_token = null;
  user.access_token_expires = null;
  localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(user));
}

/**
 * Log out the current user.
 */
export function logout() {
  const user = getCurrentUser();
  // Revoke Google token if present
  if (user?.access_token && window.google?.accounts?.oauth2) {
    try { google.accounts.oauth2.revoke(user.access_token); } catch {}
  }
  localStorage.removeItem(CONFIG.SESSION_KEY);
  // An explicit sign-out means this device should stop restoring the admin
  // session automatically — the next visit shows the login screen.
  forgetAdminDevice();
}

/**
 * Get the user's initials (for avatar).
 */
export function getUserInitials(user) {
  if (!user?.display_name) return '?';
  return user.display_name
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
