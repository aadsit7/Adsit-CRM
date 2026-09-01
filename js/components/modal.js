// ============================================
// Modal Dialog Component
// ============================================

import { el, $ } from '../utils/dom.js';

let currentModal = null;

// Number of confirmDialog overlays currently stacked on top of the modal.
// While one is up it owns the keyboard: the base modal's Escape/Tab handler
// stands down, so Escape cancels the confirm WITHOUT also tearing down the
// modal underneath it (which used to discard the user's unsaved edits).
let confirmOpenCount = 0;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusablesIn(container) {
  return [...container.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter(n => n.offsetWidth || n.offsetHeight || n.getClientRects().length);
}

// Keep Tab cycling inside the dialog — without this, keyboard and
// screen-reader users tab straight into the inert page behind the modal.
function trapTab(e, container) {
  const items = focusablesIn(container);
  if (items.length === 0) { e.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !container.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !container.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

function restoreFocus(opener) {
  if (opener && opener.isConnected && typeof opener.focus === 'function') {
    try { opener.focus(); } catch { /* element became unfocusable */ }
  }
}

/**
 * Open a modal dialog.
 * @param {Object} options - { title, content, footer, onClose }
 * @returns {{ close: Function, element: HTMLElement }}
 */
export function openModal({ title, content, footer, onClose, className }) {
  // Close any existing modal
  closeModal();

  const modalClass = className ? `modal ${className}` : 'modal';
  const opener = document.activeElement;

  const dialog = el('div', {
    class: modalClass,
    role: 'dialog',
    'aria-modal': 'true',
    ...(typeof title === 'string' && title ? { 'aria-label': title } : {}),
    tabindex: '-1',
  },
    el('div', { class: 'modal__header' },
      el('h2', { class: 'modal__title' }, title),
      el('button', {
        class: 'modal__close',
        'aria-label': 'Close dialog',
        html: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        onClick: closeModal,
      })
    ),
    el('div', { class: 'modal__body' }, ...(Array.isArray(content) ? content : [content])),
    footer ? el('div', { class: 'modal__footer' }, ...(Array.isArray(footer) ? footer : [footer])) : null
  );

  const backdrop = el('div', { class: 'modal-backdrop', onClick: (e) => {
    if (e.target === backdrop) closeModal();
  }}, dialog);

  const root = $('#modal-root');
  root.appendChild(backdrop);

  // Trigger animation, then move focus into the dialog (the container, not
  // the first field — focusing an input would pop the keyboard on phones).
  requestAnimationFrame(() => {
    backdrop.classList.add('modal-backdrop--visible');
    try { dialog.focus({ preventScroll: true }); } catch { dialog.focus(); }
  });

  // Escape closes; Tab stays inside. Both stand down while a confirmDialog
  // is stacked on top — the confirm owns the keyboard then.
  const escHandler = (e) => {
    if (confirmOpenCount > 0) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'Tab') trapTab(e, dialog);
  };
  document.addEventListener('keydown', escHandler);

  currentModal = { element: backdrop, escHandler, onClose, opener };

  return {
    close: closeModal,
    element: backdrop,
  };
}

/**
 * Close the current modal.
 */
export function closeModal() {
  if (!currentModal) return;

  const { element, escHandler, onClose, opener } = currentModal;

  element.classList.remove('modal-backdrop--visible');
  document.removeEventListener('keydown', escHandler);

  setTimeout(() => {
    element.remove();
    if (onClose) onClose();
  }, 250);

  currentModal = null;
  restoreFocus(opener);
}

/**
 * Open a confirm dialog layered on top of any existing modal.
 * Unlike openModal, this does NOT close the current modal — it mounts
 * its own overlay so the caller's modal remains intact.
 * @param {string} title
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function confirmDialog(title, message) {
  return new Promise((resolve) => {
    let settled = false;
    const opener = document.activeElement;
    confirmOpenCount += 1;

    function dismiss(value) {
      if (settled) return;
      settled = true;
      confirmOpenCount -= 1;
      backdrop.classList.remove('modal-backdrop--visible');
      document.removeEventListener('keydown', escHandler, true);
      setTimeout(() => backdrop.remove(), 250);
      restoreFocus(opener);
      resolve(value);
    }

    const cancelBtn = el('button', {
      class: 'btn btn--secondary',
      onClick: () => dismiss(false),
    }, 'Cancel');

    const confirmBtn = el('button', {
      class: 'btn btn--danger',
      onClick: () => dismiss(true),
    }, 'Delete');

    const dialog = el('div', {
      class: 'modal',
      role: 'alertdialog',
      'aria-modal': 'true',
      ...(typeof title === 'string' && title ? { 'aria-label': title } : {}),
    },
      el('div', { class: 'modal__header' },
        el('h2', { class: 'modal__title' }, title),
        el('button', {
          class: 'modal__close',
          'aria-label': 'Close dialog',
          html: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
          onClick: () => dismiss(false),
        }),
      ),
      el('div', { class: 'modal__body' }, el('p', { class: 'confirm-text' }, message)),
      el('div', { class: 'modal__footer' }, cancelBtn, confirmBtn),
    );

    const backdrop = el('div', {
      class: 'modal-backdrop',
      style: { zIndex: '10001' },
      onClick: (e) => { if (e.target === backdrop) dismiss(false); },
    }, dialog);

    // Capture phase so this runs before any bubble-phase listener and can
    // stop Escape from reaching the base modal's (already-guarded) handler
    // or any other document-level Escape shortcut.
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismiss(false);
        return;
      }
      if (e.key === 'Tab') trapTab(e, dialog);
    };
    document.addEventListener('keydown', escHandler, true);

    const root = $('#modal-root') || document.body;
    root.appendChild(backdrop);
    requestAnimationFrame(() => {
      backdrop.classList.add('modal-backdrop--visible');
      cancelBtn.focus();
    });
  });
}
