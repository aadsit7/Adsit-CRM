// Tests for the admin Google SSO full-page redirect flow (js/auth.js).
//
// This flow replaced Google Identity Services' popup/One-Tap button, which
// silently failed to render on iPhone (every iOS browser is WebKit). These
// tests lock in the security-critical return-leg logic — CSRF (state) and
// replay (nonce) checks, admin authorization, and stripping the access token
// out of the URL — none of which we want to regress.

import './_setup.mjs'; // shims localStorage + document for the module imports
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attemptSilentReauth,
  beginGoogleRedirect,
  canAttemptSilentReauth,
  completeGoogleRedirect,
  getOAuthRedirectUri,
  getRememberedAdminEmail,
  logout,
  takeLoginError,
} from '../js/auth.js';
import { CONFIG } from '../js/config.js';

// ---- Browser-environment shims (installed per test) ----

function setupBrowser({ hash = '', pathname = '/Partner-Portal/', origin = 'https://aadsit7.github.io' } = {}) {
  const session = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (session.has(k) ? session.get(k) : null),
    setItem: (k, v) => session.set(k, String(v)),
    removeItem: (k) => session.delete(k),
  };
  let href = '';
  globalThis.window = {
    location: {
      hash,
      pathname,
      origin,
      get href() { return href; },
      set href(v) { href = v; },
    },
  };
  globalThis.history = {
    replaceState: (_s, _t, url) => {
      const i = String(url).indexOf('#');
      globalThis.window.location.hash = i >= 0 ? String(url).slice(i) : '';
    },
  };
  // Node 21+ exposes a getter-only navigator global — defineProperty so the
  // silent-reauth onLine guard can be driven from tests on any Node version.
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true },
    configurable: true,
    writable: true,
  });
  localStorage.clear();
  takeLoginError(); // clear any error left from a previous test
  return { session, getHref: () => href };
}

/** Store an existing signed-in admin session, as a prior sign-in would have. */
function seedAdminSession({ email = ADMIN_EMAIL, accessToken = null, expires = null } = {}) {
  localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify({
    partner_id: 'p_admin001',
    username: 'admin',
    display_name: 'Portal Admin',
    is_admin: true,
    email,
    access_token: accessToken,
    access_token_expires: expires,
  }));
}

// Build a JWT whose payload decodes via auth.js's decodeJwt(). Google uses
// base64url (URL-safe, unpadded) for id_token segments — match that so the
// token survives URLSearchParams parsing of the URL fragment.
function makeIdToken(payload) {
  const seg = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${seg}.signature`;
}

function buildReturnHash({ accessToken = 'AT123', idToken, state, expiresIn = 3599 }) {
  const parts = [];
  if (accessToken) parts.push(`access_token=${accessToken}`);
  parts.push('token_type=Bearer');
  if (expiresIn != null) parts.push(`expires_in=${expiresIn}`);
  if (idToken) parts.push(`id_token=${idToken}`);
  if (state) parts.push(`state=${state}`);
  return `#${parts.join('&')}`;
}

const ADMIN_EMAIL = CONFIG.ADMIN_EMAILS[0]; // an authorized admin

// ---- getOAuthRedirectUri ----

test('getOAuthRedirectUri returns origin + path', () => {
  setupBrowser({ pathname: '/Partner-Portal/' });
  assert.equal(getOAuthRedirectUri(), 'https://aadsit7.github.io/Partner-Portal/');
});

test('getOAuthRedirectUri normalizes away a trailing index.html', () => {
  setupBrowser({ pathname: '/Partner-Portal/index.html' });
  assert.equal(getOAuthRedirectUri(), 'https://aadsit7.github.io/Partner-Portal/');
});

// ---- beginGoogleRedirect ----

test('beginGoogleRedirect navigates to Google with the right params and stashes state/nonce', () => {
  const { session, getHref } = setupBrowser();
  beginGoogleRedirect({ target: '/admin/dashboard' });

  const url = new URL(getHref());
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = url.searchParams;
  assert.equal(p.get('client_id'), CONFIG.GOOGLE_CLIENT_ID);
  assert.equal(p.get('redirect_uri'), 'https://aadsit7.github.io/Partner-Portal/');
  assert.equal(p.get('response_type'), 'token id_token');
  assert.equal(p.get('scope'), CONFIG.OAUTH_LOGIN_SCOPES);
  assert.ok(p.get('scope').includes('spreadsheets'), 'requests the Sheets scope for saving');
  assert.ok(p.get('state'), 'sends a state');
  assert.ok(p.get('nonce'), 'sends a nonce');
  assert.equal(p.get('prompt'), null, 'no prompt by default → smoothest SSO');

  // state/nonce/target persisted for the return leg
  assert.equal(session.get('pp_oauth_state'), p.get('state'));
  assert.equal(session.get('pp_oauth_nonce'), p.get('nonce'));
  assert.equal(session.get('pp_oauth_target'), '/admin/dashboard');
});

test('beginGoogleRedirect forces the chooser when chooseAccount is set', () => {
  const { getHref } = setupBrowser();
  beginGoogleRedirect({ chooseAccount: true });
  assert.equal(new URL(getHref()).searchParams.get('prompt'), 'select_account');
});

// ---- completeGoogleRedirect ----

test('completeGoogleRedirect ignores a normal route hash', () => {
  setupBrowser({ hash: '#/admin/dashboard' });
  assert.equal(completeGoogleRedirect(), null);
});

test('completeGoogleRedirect signs in an authorized admin and cleans the URL', () => {
  const state = 'state-xyz';
  const nonce = 'nonce-abc';
  const idToken = makeIdToken({ email: ADMIN_EMAIL, name: 'Portal Admin', nonce, picture: 'http://p/a.png' });
  const { session } = setupBrowser({ hash: buildReturnHash({ idToken, state }) });
  session.set('pp_oauth_state', state);
  session.set('pp_oauth_nonce', nonce);
  session.set('pp_oauth_target', '/admin/dashboard');

  const result = completeGoogleRedirect();
  assert.deepEqual(result, { ok: true, target: '/admin/dashboard' });

  // Session stored, marked admin, with the Sheets access token.
  const stored = JSON.parse(localStorage.getItem(CONFIG.SESSION_KEY));
  assert.equal(stored.is_admin, true);
  assert.equal(stored.display_name, 'Portal Admin');
  assert.equal(stored.access_token, 'AT123');
  assert.ok(stored.access_token_expires > Date.now(), 'token expiry set in the future');

  // The token-bearing fragment is gone; URL points at a clean route.
  assert.equal(globalThis.window.location.hash, '#/admin/dashboard');
  // Handshake values consumed.
  assert.equal(session.get('pp_oauth_state'), undefined);
  assert.equal(takeLoginError(), null, 'no error on success');
});

test('completeGoogleRedirect rejects a non-admin Google account', () => {
  const state = 's1';
  const nonce = 'n1';
  const idToken = makeIdToken({ email: 'stranger@example.com', name: 'Nope', nonce });
  const { session } = setupBrowser({ hash: buildReturnHash({ idToken, state }) });
  session.set('pp_oauth_state', state);
  session.set('pp_oauth_nonce', nonce);

  const result = completeGoogleRedirect();
  assert.equal(result.error, 'not_admin');
  assert.equal(localStorage.getItem(CONFIG.SESSION_KEY), null, 'no session stored');
  assert.match(takeLoginError(), /not an authorized admin/i);
  assert.equal(globalThis.window.location.hash, '#/login', 'bounced back to login');
});

test('completeGoogleRedirect rejects a state (CSRF) mismatch', () => {
  const nonce = 'n2';
  const idToken = makeIdToken({ email: ADMIN_EMAIL, nonce });
  const { session } = setupBrowser({ hash: buildReturnHash({ idToken, state: 'attacker-state' }) });
  session.set('pp_oauth_state', 'real-state');
  session.set('pp_oauth_nonce', nonce);

  const result = completeGoogleRedirect();
  assert.equal(result.error, 'state_mismatch');
  assert.equal(localStorage.getItem(CONFIG.SESSION_KEY), null);
});

test('completeGoogleRedirect rejects a nonce (replay) mismatch', () => {
  const state = 's3';
  const idToken = makeIdToken({ email: ADMIN_EMAIL, nonce: 'stale-nonce' });
  const { session } = setupBrowser({ hash: buildReturnHash({ idToken, state }) });
  session.set('pp_oauth_state', state);
  session.set('pp_oauth_nonce', 'fresh-nonce');

  const result = completeGoogleRedirect();
  assert.equal(result.error, 'nonce_mismatch');
  assert.equal(localStorage.getItem(CONFIG.SESSION_KEY), null);
});

test('completeGoogleRedirect surfaces a Google-returned error', () => {
  setupBrowser({ hash: '#error=access_denied&state=s4' });
  const result = completeGoogleRedirect();
  assert.equal(result.error, 'access_denied');
  assert.match(takeLoginError(), /cancelled/i);
  assert.equal(globalThis.window.location.hash, '#/login');
});

test('completeGoogleRedirect stores the admin email for future login_hint use', () => {
  const state = 's-email';
  const nonce = 'n-email';
  const idToken = makeIdToken({ email: ADMIN_EMAIL.toUpperCase(), name: 'Portal Admin', nonce });
  const { session } = setupBrowser({ hash: buildReturnHash({ idToken, state }) });
  session.set('pp_oauth_state', state);
  session.set('pp_oauth_nonce', nonce);

  completeGoogleRedirect();
  const stored = JSON.parse(localStorage.getItem(CONFIG.SESSION_KEY));
  assert.equal(stored.email, ADMIN_EMAIL.toLowerCase());
});

// ---- Silent token renewal (prompt=none full-page redirect) ----
//
// On iPhone, GIS's popup-based requestAccessToken({prompt:'none'}) can never
// renew the hourly Sheets token (WebKit blocks gestureless popups and
// third-party cookies), which used to push admins back through the login
// screen every visit. These tests lock in the redirect-based renewal: it must
// be invisible, loop-proof, and must NEVER tear down an existing session.

test('beginGoogleRedirect silent mode sends prompt=none + login_hint and marks the attempt', () => {
  const { session, getHref } = setupBrowser();
  beginGoogleRedirect({ target: '/admin/events', silent: true, loginHint: ADMIN_EMAIL });

  const p = new URL(getHref()).searchParams;
  assert.equal(p.get('prompt'), 'none', 'must not show any Google UI');
  assert.equal(p.get('login_hint'), ADMIN_EMAIL, 'renews the right account');
  assert.equal(session.get('pp_oauth_silent'), '1', 'return leg knows it was silent');
  assert.ok(Number(session.get('pp_silent_attempt_ts')) > 0, 'attempt throttle armed');
  assert.equal(session.get('pp_oauth_target'), '/admin/events');
});

test('silent renewal success refreshes the token and lands on the original route', () => {
  const state = 'st-renew';
  const nonce = 'nc-renew';
  const idToken = makeIdToken({ email: ADMIN_EMAIL, name: 'Portal Admin', nonce });
  const { session } = setupBrowser({ hash: buildReturnHash({ accessToken: 'FRESH', idToken, state }) });
  seedAdminSession({ accessToken: 'STALE', expires: Date.now() - 1000 });
  session.set('pp_oauth_state', state);
  session.set('pp_oauth_nonce', nonce);
  session.set('pp_oauth_target', '/admin/partners');
  session.set('pp_oauth_silent', '1');
  session.set('pp_silent_block_ts', String(Date.now())); // stale block from an earlier failure

  const result = completeGoogleRedirect();
  assert.deepEqual(result, { ok: true, target: '/admin/partners' });

  const stored = JSON.parse(localStorage.getItem(CONFIG.SESSION_KEY));
  assert.equal(stored.access_token, 'FRESH');
  assert.ok(stored.access_token_expires > Date.now());
  assert.equal(globalThis.window.location.hash, '#/admin/partners', 'back where the user was');
  assert.equal(session.get('pp_silent_block_ts'), undefined, 'success clears the failure block');
});

test('silent renewal failure keeps the session, returns to the route, and blocks retries', () => {
  const { session } = setupBrowser({ hash: '#error=login_required&state=st-fail' });
  seedAdminSession();
  session.set('pp_oauth_state', 'st-fail');
  session.set('pp_oauth_target', '/admin/comp');
  session.set('pp_oauth_silent', '1');

  const result = completeGoogleRedirect();
  assert.equal(result.error, 'login_required');
  assert.equal(result.silent, true);

  // The admin is STILL signed in to the portal — no logout, no error flash.
  const stored = JSON.parse(localStorage.getItem(CONFIG.SESSION_KEY));
  assert.equal(stored.is_admin, true);
  assert.equal(globalThis.window.location.hash, '#/admin/comp', 'not bounced to /login');
  assert.equal(takeLoginError(), null, 'no scary error message queued');
  assert.ok(Number(session.get('pp_silent_block_ts')) > 0, 'further attempts blocked');
});

test('silent renewal failure without any session falls back to the login screen quietly', () => {
  const { session } = setupBrowser({ hash: '#error=interaction_required&state=st-nosess' });
  session.set('pp_oauth_state', 'st-nosess');
  session.set('pp_oauth_silent', '1');

  const result = completeGoogleRedirect();
  assert.equal(result.silent, true);
  assert.equal(globalThis.window.location.hash, '#/login');
  assert.equal(takeLoginError(), null, 'silent attempts never surface errors');
});

test('attemptSilentReauth navigates with the current route as target', () => {
  const { getHref } = setupBrowser({ hash: '#/admin/partner-detail?id=p_acme01' });
  seedAdminSession();

  assert.equal(attemptSilentReauth(), true);
  const url = new URL(getHref());
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('prompt'), 'none');
  assert.equal(url.searchParams.get('login_hint'), ADMIN_EMAIL);
  assert.equal(
    globalThis.sessionStorage.getItem('pp_oauth_target'),
    '/admin/partner-detail?id=p_acme01',
    'returns to the exact route, query params included',
  );
});

test('attemptSilentReauth refuses without an admin session', () => {
  setupBrowser();
  assert.equal(canAttemptSilentReauth(), false);
  assert.equal(attemptSilentReauth(), false);

  localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify({ username: 'partner1', is_admin: false }));
  assert.equal(attemptSilentReauth(), false, 'partners never get Google-bounced');
});

test('attemptSilentReauth is throttled after a recent attempt', () => {
  const { session, getHref } = setupBrowser();
  seedAdminSession();
  session.set('pp_silent_attempt_ts', String(Date.now() - 5000));

  assert.equal(attemptSilentReauth(), false, 'attempted 5s ago → wait');
  assert.equal(getHref(), '', 'no navigation started');

  session.set('pp_silent_attempt_ts', String(Date.now() - 120000));
  assert.equal(attemptSilentReauth(), true, 'attempt window passed → allowed');
});

test('attemptSilentReauth is blocked after Google said interaction is required', () => {
  const { session } = setupBrowser();
  seedAdminSession();
  session.set('pp_silent_block_ts', String(Date.now() - 60000));

  assert.equal(attemptSilentReauth(), false, 'blocked 1 min ago → still blocked');

  session.set('pp_silent_block_ts', String(Date.now() - 16 * 60000));
  assert.equal(attemptSilentReauth(), true, 'block expired after 15 min');
});

test('attemptSilentReauth refuses while offline', () => {
  setupBrowser();
  seedAdminSession();
  globalThis.navigator.onLine = false;
  assert.equal(attemptSilentReauth(), false, 'navigating to Google offline would strand the user');
});

// ---- Device memory: restore an evicted session without re-sign-in ----
//
// The session key alone is not durable: Safari's ITP purges script-writable
// storage after 7 days without a visit, and "clear on exit" settings wipe it
// too. That used to dump a signed-in admin on the login screen for a full
// interactive Google round-trip. The device marker (pp_device_admin) lets the
// cold-load silent redirect rebuild the whole session instead — the admin
// signs in through Google once per device, until they explicitly log out.

test('a successful Google sign-in remembers this device for future silent restores', () => {
  const state = 's-dev';
  const nonce = 'n-dev';
  const idToken = makeIdToken({ email: ADMIN_EMAIL.toUpperCase(), name: 'Portal Admin', nonce });
  const { session } = setupBrowser({ hash: buildReturnHash({ idToken, state }) });
  session.set('pp_oauth_state', state);
  session.set('pp_oauth_nonce', nonce);

  completeGoogleRedirect();
  assert.equal(getRememberedAdminEmail(), ADMIN_EMAIL.toLowerCase());
});

test('an evicted session on a remembered device silently restores via prompt=none', () => {
  const { getHref } = setupBrowser();
  localStorage.setItem('pp_device_admin', ADMIN_EMAIL); // marker survived, session did not

  assert.equal(canAttemptSilentReauth(), true);
  assert.equal(attemptSilentReauth(), true);
  const p = new URL(getHref()).searchParams;
  assert.equal(p.get('prompt'), 'none', 'no Google UI — the restore is invisible');
  assert.equal(p.get('login_hint'), ADMIN_EMAIL, 'restores the remembered account');
});

test('a partner session on a remembered device is never Google-bounced', () => {
  setupBrowser();
  localStorage.setItem('pp_device_admin', ADMIN_EMAIL);
  localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify({ username: 'partner1', is_admin: false }));
  assert.equal(attemptSilentReauth(), false);
});

test('a failed silent restore keeps the device marker so a later cold load can retry', () => {
  const { session } = setupBrowser({ hash: '#error=login_required&state=st-keep' });
  localStorage.setItem('pp_device_admin', ADMIN_EMAIL);
  session.set('pp_oauth_state', 'st-keep');
  session.set('pp_oauth_silent', '1');

  const result = completeGoogleRedirect();
  assert.equal(result.silent, true);
  assert.equal(globalThis.window.location.hash, '#/login', 'falls back to the login screen');
  assert.equal(getRememberedAdminEmail(), ADMIN_EMAIL.toLowerCase(), 'marker survives a transient failure');
  assert.ok(Number(session.get('pp_silent_block_ts')) > 0, 'and retries are blocked — no bounce loop');
});

test('logout clears both the session and the device marker', () => {
  setupBrowser();
  seedAdminSession();
  localStorage.setItem('pp_device_admin', ADMIN_EMAIL);

  logout();
  assert.equal(localStorage.getItem(CONFIG.SESSION_KEY), null, 'signed out');
  assert.equal(getRememberedAdminEmail(), null, 'no auto-restore after an explicit sign-out');
  assert.equal(canAttemptSilentReauth(), false, 'next visit shows the login screen');
});
