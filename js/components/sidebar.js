// ============================================
// Sidebar Navigation Component
// ============================================

import { getCurrentUser, getUserInitials, logout } from '../auth.js';
import { navigate, getCurrentPath } from '../router.js';
import { el, $ } from '../utils/dom.js';
import { toggleQuickForm } from './quick-form.js';

const PARTNER_NAV = [
  { path: '/partner/opportunities', label: 'Opportunities', icon: 'dashboard', short: 'Deals' },
  { path: '/partner/leadcheck', label: 'LeadCheck', icon: 'leadcheck' },
  { path: '/partner/demandgen', label: 'Demand Gen', icon: 'calendar' },
  { path: '/partner/resources', label: 'Resources', icon: 'support' },
];

const ADMIN_NAV = [
  { path: '/admin/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { path: '/admin/opportunities', label: 'Opportunities', icon: 'opportunities', short: 'Deals' },
  { path: '/admin/forecast', label: 'Analyzer', icon: 'forecast' },
  { path: '/admin/partners', label: 'Partners', icon: 'partners' },
  { path: '/admin/events', label: 'Events / JLG', icon: 'events', short: 'Events' },
  { path: '/admin/leadcheck', label: 'Accounts', icon: 'leadcheck' },
  { label: 'Pricing', icon: 'pricing', externalUrl: 'https://aadsit7.github.io/Partner-Calculator/' },
  { path: '/admin/comp', label: 'Comp', icon: 'comp' },
  { path: '/admin/randy', label: 'Randy', icon: 'ai' },
  { path: '/admin/setup', label: 'Setup', icon: 'setup' },
];

const ICONS = {
  dashboard: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="2" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.5"/><rect x="11" y="2" width="7" height="5" rx="2" stroke="currentColor" stroke-width="1.5"/><rect x="2" y="11" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.5"/><rect x="11" y="9" width="7" height="9" rx="2" stroke="currentColor" stroke-width="1.5"/></svg>',
  calendar: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="3" y="4" width="14" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3 9h14" stroke="currentColor" stroke-width="1.5"/><path d="M7 2v4M13 2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  support: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 5a2 2 0 012-2h4v14H6a2 2 0 01-2-2V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 3h4a2 2 0 012 2v10a2 2 0 01-2 2h-4V3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  partners: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="7.5" cy="6" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M2 17c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="14" cy="6.5" r="2" stroke="currentColor" stroke-width="1.5"/><path d="M13 12c2 0 4.5 1 4.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  opportunities: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 2l2.2 4.4 4.9.72-3.55 3.46.84 4.88L10 13.27l-4.4 2.23.84-4.88L2.9 7.12l4.9-.72L10 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  forecast: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 17h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4.5 17V13M9 17V9M13.5 17V11M18 17V5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M14.5 5.5L18 5v3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  events: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="3" y="4" width="14" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3 9h14" stroke="currentColor" stroke-width="1.5"/><path d="M7 2v4M13 2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M7 13h6M7 16h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  ai: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 3.5l1.55 3.15L15 7.55l-2.3 2.25.55 3.2L10 11.5l-3.25 1.5.55-3.2L5 7.55l3.45-.9L10 3.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><path d="M15.5 13.5l.8 1.6 1.7.4-1.25 1.2.3 1.75-1.55-.85-1.55.85.3-1.75L13 15.5l1.7-.4.8-1.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  setup: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 5h2m0 0a2 2 0 004 0m-4 0a2 2 0 014 0m0 0h8M3 10h8m0 0a2 2 0 004 0m-4 0a2 2 0 014 0m0 0h2M3 15h2m0 0a2 2 0 004 0m-4 0a2 2 0 014 0m0 0h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  leadcheck: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M13.5 13.5L18 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M6.5 8.5l1.5 1.5 2.5-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pricing: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 3v14M13.5 6.5h-5a2 2 0 100 4h3a2 2 0 110 4h-5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  comp: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7h2M5.5 10h2M5.5 13h2M10 7h4.5M10 10h4.5M10 13h2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  logout: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M7 16H4a2 2 0 01-2-2V4a2 2 0 012-2h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 13l4-4-4-4M7.5 9H16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="4" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="16" cy="10" r="1.5" fill="currentColor"/></svg>',
  add: '<svg width="22" height="22" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
};

// The phone bottom tab bar shows this many primary destinations before an
// overflow "More" tab (Apple HIG caps a tab bar at ~5 items). Partner nav
// has 4 routed items → all fit; admin nav has 8 → first 4 become tabs and
// the rest live behind "More" (which opens the full drawer).
const MAX_PRIMARY_TABS = 4;

/**
 * Render the sidebar.
 */
export function renderSidebar() {
  const sidebar = $('#sidebar');
  const user = getCurrentUser();

  if (!user) {
    sidebar.innerHTML = '';
    renderBottomNav();
    return;
  }

  const navItems = user.is_admin ? ADMIN_NAV : PARTNER_NAV;
  const currentPath = getCurrentPath();
  const sectionLabel = user.is_admin ? 'Admin' : 'Partner';

  sidebar.innerHTML = '';

  // Header
  const header = el('div', { class: 'sidebar__header' },
    el('div', { class: 'sidebar__logo' },
      el('div', { class: 'sidebar__logo-text' },
        el('span', { style: { fontWeight: 'var(--font-bold)', color: '#fff' } }, 'Partner'),
        el('span', { style: { fontWeight: 'var(--font-normal)', color: '#2F6BFF', marginLeft: 'var(--space-1)' } }, 'Portal'),
      )
    )
  );

  // Navigation
  const nav = el('nav', { class: 'sidebar__nav' },
    el('div', { class: 'sidebar__section-label' }, sectionLabel),
    ...navItems.map(item =>
      item.externalUrl
        ? el('a', {
            class: 'sidebar__link',
            href: item.externalUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            onClick: () => {
              closeMobileSidebar();
            }
          },
            el('span', { class: 'sidebar__link-icon', html: ICONS[item.icon] }),
            item.label
          )
        : el('a', {
            class: `sidebar__link ${currentPath === item.path ? 'sidebar__link--active' : ''}`,
            href: `#${item.path}`,
            dataset: { path: item.path },
            onClick: (e) => {
              e.preventDefault();
              navigate(item.path);
              closeMobileSidebar();
            }
          },
            el('span', { class: 'sidebar__link-icon', html: ICONS[item.icon] }),
            item.label
          )
    )
  );

  // Footer
  const initials = getUserInitials(user);
  const footer = el('div', { class: 'sidebar__footer' },
    el('div', { class: 'sidebar__user' },
      el('div', { class: 'sidebar__avatar' }, initials),
      el('div', { class: 'sidebar__user-info' },
        el('div', { class: 'sidebar__user-name' }, user.display_name || user.username),
        el('div', { class: 'sidebar__user-role' }, user.is_admin ? 'Administrator' : user.tier || 'Partner')
      ),
      el('button', {
        class: 'sidebar__logout',
        title: 'Log out',
        html: ICONS.logout,
        onClick: () => {
          logout();
          navigate('/login');
        }
      })
    )
  );

  sidebar.append(header, nav, footer);

  // Mirror the primary destinations into the phone bottom tab bar.
  renderBottomNav();

  // Listen for route changes to update active state
  window.addEventListener('routechange', updateActiveLink);
}

/**
 * Render the iOS-style bottom tab bar (visible only on phones via CSS).
 *
 * The first MAX_PRIMARY_TABS routed nav items become tabs; a trailing
 * "More" tab opens the full drawer so every destination + account/logout
 * stays reachable. Rebuilt on each navigation (renderSidebar runs per
 * route), so the active tab is always correct.
 *
 * Admins additionally get a prominent center "Add" button that opens the
 * SAME Quick Add sheet Randy uses (create/update an opportunity, partner,
 * or event). It's admin-only because those writes require the admin Sheets
 * token; partners have no write access, so surfacing it for them would
 * only produce failed saves.
 */
export function renderBottomNav() {
  const bottomNav = $('#bottom-nav');
  if (!bottomNav) return;

  const user = getCurrentUser();
  if (!user) {
    bottomNav.innerHTML = '';
    return;
  }

  const navItems = user.is_admin ? ADMIN_NAV : PARTNER_NAV;
  // Only in-app routes are eligible for a tab (external links live in "More").
  const primary = navItems.filter(item => item.path).slice(0, MAX_PRIMARY_TABS);
  const primaryPaths = new Set(primary.map(item => item.path));
  const currentPath = getCurrentPath();

  // Build the tabs as an ordered list so the Add button can be spliced into
  // the visual center without disturbing the primary/More ordering.
  const tabs = primary.map(item =>
    el('a', {
      class: `bottom-nav__tab ${isTabActive(item.path, currentPath) ? 'bottom-nav__tab--active' : ''}`,
      href: `#${item.path}`,
      dataset: { path: item.path },
      'aria-label': item.label,
      onClick: (e) => {
        e.preventDefault();
        navigate(item.path);
        closeMobileSidebar();
      },
    },
      el('span', { class: 'bottom-nav__icon', html: ICONS[item.icon] }),
      el('span', { class: 'bottom-nav__label' }, item.short || item.label),
    )
  );

  // "More" — opens the existing drawer (all destinations + user/logout).
  // It reads as active whenever the current route isn't one of the visible
  // tabs, so an overflow screen (Setup, Comp, …) still shows a lit tab.
  const moreActive = !primaryPaths.has(currentPath)
    && currentPath !== '/admin/partner-detail'; // partner-detail lights Dashboard
  tabs.push(
    el('button', {
      class: `bottom-nav__tab bottom-nav__tab--more ${moreActive ? 'bottom-nav__tab--active' : ''}`,
      type: 'button',
      'aria-label': 'More',
      onClick: () => openMobileSidebar(),
    },
      el('span', { class: 'bottom-nav__icon', html: ICONS.more }),
      el('span', { class: 'bottom-nav__label' }, 'More'),
    )
  );

  // Center "Add" (admins only) — the same Quick Add sheet Randy exposes.
  if (user.is_admin) {
    const addTab = el('button', {
      class: 'bottom-nav__tab bottom-nav__tab--add',
      type: 'button',
      'aria-label': 'Quick add — opportunity, partner, or event',
      onClick: () => {
        closeMobileSidebar();
        toggleQuickForm();
      },
    },
      el('span', { class: 'bottom-nav__icon', html: ICONS.add }),
      el('span', { class: 'bottom-nav__label' }, 'Add'),
    );
    tabs.splice(Math.floor(tabs.length / 2), 0, addTab);
  }

  bottomNav.innerHTML = '';
  tabs.forEach(tab => bottomNav.appendChild(tab));
}

/** A tab is active on its own path, or (Dashboard) on partner-detail. */
function isTabActive(tabPath, currentPath) {
  return tabPath === currentPath
    || (tabPath === '/admin/dashboard' && currentPath === '/admin/partner-detail');
}

function updateActiveLink(e) {
  const path = e.detail.path;
  const links = document.querySelectorAll('.sidebar__link');
  links.forEach(link => {
    // When on partner-detail, highlight the Dashboard link
    const isActive = link.dataset.path === path
      || (path === '/admin/partner-detail' && link.dataset.path === '/admin/dashboard');
    link.classList.toggle('sidebar__link--active', isActive);
  });

  // Keep the phone bottom tab bar in sync too. The visible tabs carry a
  // data-path; the trailing "More" button has none and lights up whenever
  // the route lives behind it.
  const tabs = document.querySelectorAll('.bottom-nav__tab');
  let anyPrimaryActive = false;
  tabs.forEach(tab => {
    if (!tab.dataset.path) return; // skip the More button on this pass
    const active = isTabActive(tab.dataset.path, path);
    if (active) anyPrimaryActive = true;
    tab.classList.toggle('bottom-nav__tab--active', active);
  });
  const moreTab = document.querySelector('.bottom-nav__tab--more');
  if (moreTab) {
    moreTab.classList.toggle(
      'bottom-nav__tab--active',
      !anyPrimaryActive && path !== '/admin/partner-detail'
    );
  }
}

/**
 * Setup mobile sidebar toggle.
 */
export function setupMobileSidebar() {
  const hamburger = $('#hamburger');
  const overlay = $('#sidebar-overlay');

  if (hamburger) {
    hamburger.addEventListener('click', toggleMobileSidebar);
  }

  if (overlay) {
    overlay.addEventListener('click', closeMobileSidebar);
  }
}

function toggleMobileSidebar() {
  const sidebar = $('#sidebar');
  const overlay = $('#sidebar-overlay');
  sidebar.classList.toggle('sidebar--open');
  overlay.classList.toggle('sidebar-overlay--visible');
}

function openMobileSidebar() {
  const sidebar = $('#sidebar');
  const overlay = $('#sidebar-overlay');
  sidebar.classList.add('sidebar--open');
  overlay.classList.add('sidebar-overlay--visible');
}

function closeMobileSidebar() {
  const sidebar = $('#sidebar');
  const overlay = $('#sidebar-overlay');
  sidebar.classList.remove('sidebar--open');
  overlay.classList.remove('sidebar-overlay--visible');
}

/**
 * Update the topbar with rich content.
 *
 * Plain-text title pages use `setTopbarTitle(title)` which delegates here
 * with just the title. Pages that need an eyebrow + meta line, filter
 * chips, or action buttons in the topbar should call this directly.
 *
 * Always clears `#topbar-actions` so a previous view's chips/buttons
 * don't bleed across navigation.
 */
export function setTopbar({ title, meta, chips, actions } = {}) {
  const titleEl = $('#topbar-title');
  const actionsEl = $('#topbar-actions');
  if (!titleEl) return;

  // Reset both zones each call.
  titleEl.textContent = '';
  titleEl.className = 'topbar__title';
  if (actionsEl) actionsEl.innerHTML = '';

  if (meta || chips) {
    titleEl.classList.add('topbar__title--rich');
    const titleZone = el('div', { class: 'topbar__title-zone' },
      title ? el('span', { class: 'topbar__eyebrow' }, title) : null,
      meta ? el('span', { class: 'topbar__meta' }, meta) : null,
    );
    titleEl.appendChild(titleZone);
  } else if (title) {
    titleEl.textContent = title;
  }

  if (!actionsEl) return;

  if (chips) {
    const chipsZone = el('div', { class: 'topbar__chips' });
    appendChildren(chipsZone, chips);
    actionsEl.appendChild(chipsZone);
  }

  if (actions) {
    appendChildren(actionsEl, actions);
  }
}

function appendChildren(parent, value) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach(item => appendChildren(parent, item));
    return;
  }
  if (value instanceof Node) {
    parent.appendChild(value);
  }
}

/**
 * Update the topbar title (backward-compatible plain-title API).
 */
export function setTopbarTitle(title) {
  setTopbar({ title });
}
