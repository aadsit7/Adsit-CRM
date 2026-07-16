// ============================================
// Partner Portal — App Entry Point
// ============================================

import { getCurrentUser, getAccessToken, storeAccessToken, completeGoogleRedirect, attemptSilentReauth, getRememberedAdminEmail } from './auth.js';
import { addRoute, initRouter, navigate } from './router.js';
import { renderSidebar, setupMobileSidebar } from './components/sidebar.js';

// Import all views
import * as loginView from './views/login.js';
import * as partnerDashboard from './views/partner-dashboard.js';
import * as partnerMarketing from './views/partner-marketing.js';
import * as partnerResources from './views/partner-resources.js';
import * as partnerLeadCheck from './views/partner-leadcheck.js';
import * as adminDashboard from './views/admin-dashboard.js';
import * as adminPartners from './views/admin-partners.js';
import * as adminEvents from './views/admin-events.js';
import * as adminOpportunities from './views/admin-opportunities.js';
import * as adminForecast from './views/admin-forecast.js';
import * as adminComp from './views/admin-comp.js';
import * as adminPartnerDetail from './views/admin-partner-detail.js';
import * as adminSetup from './views/admin-setup.js';
import { renderAdminAIAssistant, cleanupAdminAIAssistant } from './views/admin-ai-assistant.js';
import * as adminRandyPage from './views/admin-randy-page.js';
import { mountVoiceWidget } from './components/voice-widget.js';
import { initRandy } from './components/randy.js';
import { initHotkeys, registerHotkey } from './utils/hotkeys.js';
import { toggleQuickForm } from './components/quick-form.js';
import { initMobileTableLabels } from './utils/mobile-tables.js';
import { initFieldDictation } from './utils/field-dictation.js';
import { syncAiKeyFromBackend } from './utils/file-api.js';

// ---- Register Routes ----

addRoute('/login', {
  title: 'Login',
  render: loginView.render,
  cleanup: loginView.cleanup,
});

// Partner routes (renamed tabs)
addRoute('/partner/opportunities', {
  title: 'Opportunities',
  render: async (container) => {
    setupAppShell();
    await partnerDashboard.render(container);
  },
  cleanup: partnerDashboard.cleanup,
});

addRoute('/partner/leadcheck', {
  title: 'LeadCheck',
  render: async (container) => {
    setupAppShell();
    await partnerLeadCheck.render(container);
  },
  cleanup: partnerLeadCheck.cleanup,
});

addRoute('/partner/demandgen', {
  title: 'Demand Gen',
  render: async (container) => {
    setupAppShell();
    await partnerMarketing.render(container);
  },
  cleanup: partnerMarketing.cleanup,
});

addRoute('/partner/resources', {
  title: 'Resources',
  render: async (container) => {
    setupAppShell();
    await partnerResources.render(container);
  },
  cleanup: partnerResources.cleanup,
});

// Legacy routes — redirect to new names
addRoute('/partner/dashboard', {
  title: 'Opportunities',
  render: async () => { navigate('/partner/opportunities'); },
});

addRoute('/partner/marketing', {
  title: 'Demand Gen',
  render: async () => { navigate('/partner/demandgen'); },
});

// Admin routes
addRoute('/admin/dashboard', {
  title: 'Admin Dashboard',
  render: async (container) => {
    setupAppShell();
    await adminDashboard.render(container);
  },
  cleanup: adminDashboard.cleanup,
});

addRoute('/admin/partners', {
  title: 'Partners',
  render: async (container) => {
    setupAppShell();
    await adminPartners.render(container);
  },
  cleanup: adminPartners.cleanup,
});

addRoute('/admin/opportunities', {
  title: 'Opportunities',
  render: async (container) => {
    setupAppShell();
    await adminOpportunities.render(container);
  },
  cleanup: adminOpportunities.cleanup,
});

addRoute('/admin/forecast', {
  title: 'Analyzer',
  render: async (container) => {
    setupAppShell();
    await adminForecast.render(container);
  },
  cleanup: adminForecast.cleanup,
});

addRoute('/admin/leadcheck', {
  title: 'LeadCheck',
  render: async (container) => {
    setupAppShell();
    await partnerLeadCheck.render(container);
  },
  cleanup: partnerLeadCheck.cleanup,
});

addRoute('/admin/events', {
  title: 'Events',
  render: async (container, params) => {
    setupAppShell();
    await adminEvents.render(container, params);
  },
  cleanup: adminEvents.cleanup,
});

addRoute('/admin/ai-assistant', {
  title: 'Randy',
  render: async (container) => {
    setupAppShell();
    renderAdminAIAssistant(container);
  },
  cleanup: cleanupAdminAIAssistant,
});

addRoute('/admin/comp', {
  title: 'Comp',
  render: async (container) => {
    setupAppShell();
    await adminComp.render(container);
  },
  cleanup: adminComp.cleanup,
});

addRoute('/admin/partner-detail', {
  title: 'Partner Detail',
  render: async (container, params) => {
    setupAppShell();
    await adminPartnerDetail.render(container, params);
  },
  cleanup: adminPartnerDetail.cleanup,
});

addRoute('/admin/randy', {
  title: 'Randy',
  render: async (container) => {
    setupAppShell();
    adminRandyPage.render(container);
  },
  cleanup: adminRandyPage.cleanup,
});

addRoute('/admin/setup', {
  title: 'Setup',
  render: async (container) => {
    setupAppShell();
    await adminSetup.render(container);
  },
  cleanup: adminSetup.cleanup,
});

// ---- App Shell Setup ----

let voiceWidgetMounted = false;
let randyMounted = false;
let hotkeysInitialized = false;

function setupAppShell() {
  const app = document.getElementById('app');
  if (app.className !== 'app-shell--app') {
    app.className = 'app-shell--app';
  }
  renderSidebar();

  // Mount voice widget once for admin users
  const user = getCurrentUser();
  if (user && user.is_admin && !voiceWidgetMounted) {
    mountVoiceWidget();
    voiceWidgetMounted = true;
  }

  // Mount Randy voice assistant for admin users
  if (user && user.is_admin && !randyMounted) {
    initRandy();
    randyMounted = true;
  }

  // Register global keyboard shortcuts (admin only, one-time)
  if (user && user.is_admin && !hotkeysInitialized) {
    initHotkeys();
    registerAdminShortcuts();
    hotkeysInitialized = true;
  }
}

function registerAdminShortcuts() {
  // Randy voice activation
  registerHotkey('Alt+Z', 'Activate Randy voice', () => {
    if (typeof window.activateRandy === 'function') window.activateRandy();
  }, 'Randy');

  // Opportunity shortcuts
  registerHotkey('Alt+O', 'New Opportunity', () => {
    if (location.hash.startsWith('#/admin/opportunities')) {
      window.dispatchEvent(new CustomEvent('shortcut:new-opportunity'));
    } else {
      window._pendingNewOpp = true;
      navigate('/admin/opportunities');
    }
  }, 'Opportunities');

  // Navigation shortcuts
  registerHotkey('Alt+D', 'Dashboard', () => navigate('/admin/dashboard'), 'Navigation');
  registerHotkey('Alt+A', 'Quick Form', () => toggleQuickForm(), 'Navigation');
  registerHotkey('Alt+P', 'Partners', () => navigate('/admin/partners'), 'Navigation');
  registerHotkey('Alt+E', 'Events', () => navigate('/admin/events'), 'Navigation');
  registerHotkey('Alt+L', 'LeadCheck', () => navigate('/admin/leadcheck'), 'Navigation');
}

// ---- Token Refresh for Returning Admin Sessions ----

// Refresh well before expiry so a slow Google response, a momentarily
// missing third-party cookie, or background-tab timer throttling can't
// strand us with an expired token mid-request.
const REFRESH_LEAD_MS = 15 * 60 * 1000;       // 15 min before expiry
const RETRY_AFTER_FAILURE_MS = 2 * 60 * 1000; // retry every 2 min after a failed silent refresh
const REFRESH_ON_FOCUS_THRESHOLD_MS = 15 * 60 * 1000; // refresh on focus if <15 min left

let refreshTimer = null;
let refreshInFlight = null;

/**
 * Schedule a silent token refresh ahead of the current token's expiry.
 *
 * Resilience guarantees this function makes:
 * - Always reschedules itself on completion, even if the refresh failed —
 *   a single transient failure (network blip, cookies briefly missing)
 *   must NOT permanently disable refresh.
 * - De-dupes overlapping calls so visibility/focus listeners + the timer
 *   can't fire concurrent refreshes.
 * - Falls back to a short retry interval after a failure so we recover
 *   quickly when Google is reachable again.
 */
function scheduleTokenRefresh() {
  const user = getCurrentUser();
  if (!user?.is_admin) return;

  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  const expires = user.access_token_expires || Date.now();
  const msUntilRefresh = expires - Date.now() - REFRESH_LEAD_MS;
  const delay = Math.max(msUntilRefresh, 0);

  refreshTimer = setTimeout(() => { runTokenRefresh(); }, delay);
}

/**
 * Run a silent refresh now (idempotent — concurrent calls share one
 * in-flight promise). Always reschedules the next attempt afterwards.
 */
function runTokenRefresh() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    let succeeded = false;
    try {
      const newToken = await loginView.refreshAccessToken();
      if (newToken) {
        // refreshAccessToken already stored the token with the real
        // expires_in. Call storeAccessToken again only as a safety net
        // for older code paths that may import it directly.
        storeAccessToken(newToken);
        succeeded = true;
      }
    } catch (err) {
      console.warn('Silent token refresh failed:', err);
    } finally {
      refreshInFlight = null;
      if (succeeded) {
        // Success → next normal cycle (15 min before the new expiry).
        scheduleTokenRefresh();
      } else {
        // The in-place GIS popup refresh failed — always the case on iPhone,
        // where WebKit blocks the gestureless popup and the third-party
        // Google cookies it needs. We deliberately do NOT bounce the page to
        // Google from a background timer: once an admin has signed in on a
        // device they must never be yanked into a sign-in round-trip just
        // because a timer fired. The session stays put and reads keep working
        // via the API key; the Sheets write token is renewed on the next cold
        // load (see DOMContentLoaded) — which is exactly what a failed save
        // prompts the user to do ("reload"). Reschedule a quiet retry so a
        // desktop browser whose third-party cookies briefly went missing
        // recovers on its own, with no visible effect.
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { runTokenRefresh(); }, RETRY_AFTER_FAILURE_MS);
      }
    }
  })();

  return refreshInFlight;
}

/**
 * Top the token up when the user returns to the tab. Background tabs
 * throttle setTimeout to >=1 s minimum intervals (or pause entirely on
 * some platforms), so a 15-min scheduled refresh may fire late or not at
 * all; checking on visibilitychange/focus closes that gap on desktop.
 *
 * Returning to the app must NEVER bounce the page to Google. Once an admin
 * has signed in on a device they stay signed in, and switching back to the
 * tab should simply show the app — not kick off a sign-in round-trip. So we
 * only ever attempt an invisible, in-place top-up here (the GIS popup path):
 * it renews the Sheets token silently on desktop and is a harmless no-op on
 * iPhone. A token that can't be renewed in place waits for the next cold
 * load rather than hijacking this return.
 */
function refreshOnReturn() {
  const user = getCurrentUser();
  if (!user?.is_admin) return;

  if (!getAccessToken()) {
    runTokenRefresh();
    return;
  }

  const msUntilExpiry = (user.access_token_expires || 0) - Date.now();
  if (msUntilExpiry < REFRESH_ON_FOCUS_THRESHOLD_MS) {
    runTokenRefresh();
  }
}

function setupTokenLifecycleListeners() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshOnReturn();
  });
  window.addEventListener('focus', refreshOnReturn);
  // Network came back after being offline → try a refresh in case the
  // previous attempt failed.
  window.addEventListener('online', refreshOnReturn);
}

// ---- Initialize ----

document.addEventListener('DOMContentLoaded', () => {
  // If this load is the return leg of the admin Google sign-in redirect,
  // finish it BEFORE the router reads the URL: this stores the session and
  // replaces the token-bearing fragment with a clean route, so initRouter
  // then lands on the dashboard (or back on /login with an error shown).
  completeGoogleRedirect();

  const user = getCurrentUser();

  // A returning admin is ALREADY signed in: their identity lives in
  // localStorage and never expires, and reads keep working via the API key.
  // Only the short-lived Google Sheets *write* token lapses (about an hour
  // after the last sign-in — immediately on iPhone, where Safari suspends
  // the page). Top it back up with a silent, prompt=none redirect that
  // bounces through Google and back in well under a second, then loads the
  // intended route.
  //
  // The same silent redirect also RESTORES a session the browser itself
  // evicted (Safari's 7-day ITP purge, "clear on exit" settings): when there
  // is no session but the device marker remembers a past admin Google
  // sign-in, we bounce once and land signed in on the dashboard — instead of
  // dumping the admin on the login screen for a full interactive SSO. The
  // marker is cleared only by an explicit logout, so signing out still works.
  //
  // This is the ONLY place that auto-redirects, and only on a cold load (a
  // deliberate launch or reload) — never on a passive tab-return, focus, or
  // background timer. That is the whole point: once you have signed in on a
  // device you are never bounced to Google again just for reopening or
  // switching back to the app. If a guard says no (offline, a recent silent
  // attempt already failed, or demo mode) we simply render the app — the
  // admin stays signed in and the token is renewed on the next save-driven
  // reload instead.
  const needsSilentRestore = user
    ? (user.is_admin && !getAccessToken()) // signed in, write token lapsed
    : !!getRememberedAdminEmail();         // session evicted on a known admin device
  if (needsSilentRestore && attemptSilentReauth()) {
    showReauthSplash();
    return; // the page is navigating to Google and straight back
  }

  setupMobileSidebar();
  initMobileTableLabels();
  // Voice-to-text on every text field: focus a field and start talking.
  // Works for all users; a graceful no-op where the browser lacks the
  // Web Speech API. Coordinates the mic with Randy / the voice widget.
  initFieldDictation();
  initRouter();

  // For returning admin sessions (already in localStorage), re-initialize
  // the OAuth token client and wire up the refresh lifecycle.
  if (user?.is_admin) {
    loginView.initTokenClient();
    setupTokenLifecycleListeners();

    // Pull the Anthropic key from the Apps Script (where it's stored as a
    // Script Property) into runtime config so the AI Assistant, Randy, and
    // the PDF generators pick it up automatically — no manual paste on the
    // Setup page. Fire-and-forget; the fetch is fast and the result is
    // cached in localStorage for subsequent loads.
    syncAiKeyFromBackend();

    if (getAccessToken()) {
      // Existing token still valid (>5 min buffer). Reuse it as-is and
      // let scheduleTokenRefresh handle renewal well before expiry.
      scheduleTokenRefresh();
    } else {
      // Token missing/expired and the redirect renewal was guarded off.
      // runTokenRefresh waits for the GIS library to load (up to 5 s)
      // before attempting the popup refresh, and reschedules itself on
      // completion (success or failure).
      runTokenRefresh();
    }
  }
});

/**
 * Minimal placeholder shown for the sub-second hop to Google and back, so a
 * slow connection shows intent instead of a blank page. Inline styles only —
 * this renders before any view and must not depend on app CSS having loaded.
 */
function showReauthSplash() {
  const container = document.getElementById('view-container');
  if (container) {
    container.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;'
      + 'min-height:60vh;color:#fff;font-family:Inter,system-ui,sans-serif;'
      + 'font-size:15px;opacity:0.85;">Restoring your session…</div>';
  }
}
