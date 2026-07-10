// ============================================
// Toast Notification Component
// ============================================

import { el, $ } from '../utils/dom.js';

const ICONS = {
  success: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 10l2.5 2.5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 7.5l5 5M12.5 7.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  warning: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 3l8 14H2L10 3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8v3M10 14h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'success'|'error'|'warning'} type
 * @param {number} duration - ms
 */
export function showToast(message, type = 'success', duration = 4000) {
  const container = $('#toast-root');

  const toast = el('div', { class: `toast toast--${type}` },
    el('span', { class: 'toast__icon', html: ICONS[type] || '' }),
    el('span', { class: 'toast__message' }, message),
    el('button', {
      class: 'toast__close',
      html: '&times;',
      onClick: () => removeToast(toast),
    })
  );

  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('toast--visible');
  });

  // Auto-remove
  const timer = setTimeout(() => removeToast(toast), duration);
  toast._timer = timer;
}

function removeToast(toast) {
  clearTimeout(toast._timer);
  toast.classList.remove('toast--visible');
  setTimeout(() => toast.remove(), 300);
}
