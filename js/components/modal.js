// ============================================
// Modal Dialog Component
// ============================================

import { el, $ } from '../utils/dom.js';

let currentModal = null;

/**
 * Open a modal dialog.
 * @param {Object} options - { title, content, footer, onClose }
 * @returns {{ close: Function, element: HTMLElement }}
 */
export function openModal({ title, content, footer, onClose, className }) {
  // Close any existing modal
  closeModal();

  const modalClass = className ? `modal ${className}` : 'modal';

  const backdrop = el('div', { class: 'modal-backdrop', onClick: (e) => {
    if (e.target === backdrop) closeModal();
  }},
    el('div', { class: modalClass },
      el('div', { class: 'modal__header' },
        el('h2', { class: 'modal__title' }, title),
        el('button', {
          class: 'modal__close',
          html: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
          onClick: closeModal,
        })
      ),
      el('div', { class: 'modal__body' }, ...(Array.isArray(content) ? content : [content])),
      footer ? el('div', { class: 'modal__footer' }, ...(Array.isArray(footer) ? footer : [footer])) : null
    )
  );

  const root = $('#modal-root');
  root.appendChild(backdrop);

  // Trigger animation
  requestAnimationFrame(() => {
    backdrop.classList.add('modal-backdrop--visible');
  });

  // Close on Escape
  const escHandler = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', escHandler);

  currentModal = { element: backdrop, escHandler, onClose };

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

  const { element, escHandler, onClose } = currentModal;

  element.classList.remove('modal-backdrop--visible');
  document.removeEventListener('keydown', escHandler);

  setTimeout(() => {
    element.remove();
    if (onClose) onClose();
  }, 250);

  currentModal = null;
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

    function dismiss(value) {
      if (settled) return;
      settled = true;
      backdrop.classList.remove('modal-backdrop--visible');
      document.removeEventListener('keydown', escHandler);
      setTimeout(() => backdrop.remove(), 250);
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

    const backdrop = el('div', {
      class: 'modal-backdrop',
      style: { zIndex: '10001' },
      onClick: (e) => { if (e.target === backdrop) dismiss(false); },
    },
      el('div', { class: 'modal' },
        el('div', { class: 'modal__header' },
          el('h2', { class: 'modal__title' }, title),
          el('button', {
            class: 'modal__close',
            html: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
            onClick: () => dismiss(false),
          }),
        ),
        el('div', { class: 'modal__body' }, el('p', { class: 'confirm-text' }, message)),
        el('div', { class: 'modal__footer' }, cancelBtn, confirmBtn),
      ),
    );

    const escHandler = (e) => { if (e.key === 'Escape') dismiss(false); };
    document.addEventListener('keydown', escHandler);

    const root = $('#modal-root') || document.body;
    root.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('modal-backdrop--visible'));
  });
}
