// ============================================
// Hash-Based SPA Router (with query param support)
// ============================================

import { getCurrentUser } from './auth.js';

const routes = [];
let currentCleanup = null;

/**
 * Register a route.
 * @param {string} path - Hash path (e.g., '/partner/dashboard')
 * @param {Object} options - { render, cleanup, title, role }
 */
export function addRoute(path, options) {
  routes.push({ path, ...options });
}

/**
 * Navigate to a hash route.
 */
export function navigate(path) {
  window.location.hash = path;
}

/**
 * Get the current hash path (without query params).
 */
export function getCurrentPath() {
  const full = window.location.hash.slice(1) || '/login';
  return full.split('?')[0];
}

/**
 * Get query params from the current hash.
 * e.g., #/admin/partner-detail?id=p_acme001 → { id: 'p_acme001' }
 */
export function getQueryParams() {
  const full = window.location.hash.slice(1) || '';
  const qIndex = full.indexOf('?');
  if (qIndex === -1) return {};
  return Object.fromEntries(new URLSearchParams(full.slice(qIndex + 1)));
}

/**
 * Initialize the router.
 */
export function initRouter() {
  window.addEventListener('hashchange', () => { handleRoute().catch(onRouteError); });
  handleRoute().catch(onRouteError);
}

function onRouteError(err) {
  console.error('Route render failed:', err);
}

/**
 * Handle route changes.
 */
async function handleRoute() {
  const path = getCurrentPath();
  const params = getQueryParams();
  const user = getCurrentUser();

  // Auth guard: redirect to login if no session
  if (path !== '/login' && !user) {
    navigate('/login');
    return;
  }

  // Already logged in, redirect away from login
  if (path === '/login' && user) {
    navigate(user.is_admin ? '/admin/dashboard' : '/partner/opportunities');
    return;
  }

  // Role guard: prevent partner from accessing admin routes
  if (path.startsWith('/admin') && user && !user.is_admin) {
    navigate('/partner/opportunities');
    return;
  }

  // Prevent admin from accessing partner routes
  if (path.startsWith('/partner') && user && user.is_admin) {
    navigate('/admin/dashboard');
    return;
  }

  // Find matching route
  const route = routes.find(r => r.path === path);

  if (!route) {
    // Default fallback
    if (user) {
      navigate(user.is_admin ? '/admin/dashboard' : '/partner/opportunities');
    } else {
      navigate('/login');
    }
    return;
  }

  // Cleanup previous view
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }

  // Update page title
  if (route.title) {
    document.title = `${route.title} — Partner Portal`;
  }

  // Render view (pass params as second argument)
  const container = document.getElementById('view-container');
  if (route.render) {
    await route.render(container, params);
  }

  if (route.cleanup) {
    currentCleanup = route.cleanup;
  }

  // Dispatch custom event for sidebar to update active state
  window.dispatchEvent(new CustomEvent('routechange', { detail: { path, params } }));
}
