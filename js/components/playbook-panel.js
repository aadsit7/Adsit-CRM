// ============================================
// Events Playbook Panel
// ============================================
// Full-screen overlay that embeds the public Events Playbook site in an
// iframe so users can work through it without leaving the Events page.
//
// The overlay is a lazily-built singleton that is hidden (not destroyed)
// on close: the playbook keeps its own in-iframe state (checklist
// progress, funnel stage, active tab) only in memory, so preserving the
// iframe across open/close keeps that progress alive for the session.
// Navigating away from the Events view destroys it via
// destroyPlaybookPanel() so nothing leaks across routes.

import { el } from '../utils/dom.js';
import { showToast } from './toast.js';

export const PLAYBOOK_URL = 'https://aadsit7.github.io/Events-Playbook/';

let overlay = null;
let escHandler = null;

export function openPlaybookPanel() {
  if (!overlay) overlay = buildOverlay();
  if (!overlay.isConnected) document.body.appendChild(overlay);

  // Two frames so the transition runs on first open (append + class in
  // the same frame would skip the animation).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => overlay.classList.add('playbook-overlay--visible'));
  });

  document.body.style.overflow = 'hidden';

  escHandler = (e) => { if (e.key === 'Escape') closePlaybookPanel(); };
  document.addEventListener('keydown', escHandler);

  setPlaybookHashParam(true);

  const closeBtn = overlay.querySelector('.playbook-panel__close');
  if (closeBtn) closeBtn.focus();
}

export function closePlaybookPanel() {
  if (!overlay) return;
  overlay.classList.remove('playbook-overlay--visible');
  document.body.style.overflow = '';
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
  setPlaybookHashParam(false);
}

/**
 * Fully remove the panel (called from the Events view's route cleanup).
 */
export function destroyPlaybookPanel() {
  if (!overlay) return;
  closePlaybookPanel();
  overlay.remove();
  overlay = null;
}

/**
 * Keep `?playbook=1` in the hash while the panel is open so the current
 * browser URL is refresh-proof and shareable with logged-in teammates.
 * history.replaceState is used instead of assigning location.hash so the
 * router's hashchange handler doesn't fire and re-render the view.
 */
function setPlaybookHashParam(on) {
  const full = window.location.hash.slice(1) || '';
  const [path, query = ''] = full.split('?');
  const params = new URLSearchParams(query);
  if (on) params.set('playbook', '1');
  else params.delete('playbook');
  const qs = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${path}${qs ? '?' + qs : ''}`);
}

async function copyShareLink(shareBtn) {
  const copied = await writeClipboard(PLAYBOOK_URL);
  if (!copied) {
    showToast('Couldn’t copy automatically — use "Open in new tab" and share that URL', 'error');
    return;
  }
  showToast('Playbook link copied — anyone can open it, no sign-in needed', 'success');

  // Brief inline confirmation on the button itself.
  const label = shareBtn.querySelector('.playbook-panel__btn-label');
  if (label && !shareBtn.dataset.copied) {
    shareBtn.dataset.copied = '1';
    const original = label.textContent;
    label.textContent = 'Copied!';
    setTimeout(() => {
      label.textContent = original;
      delete shareBtn.dataset.copied;
    }, 1800);
  }
}

async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to legacy path */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function buildOverlay() {
  const shareIcon = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9.5 5.5L12 3m0 0h-2.5M12 3v2.5M6 3H4a2 2 0 00-2 2v5a2 2 0 002 2h5a2 2 0 002-2V8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const externalIcon = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M5.5 2.5H3a1.5 1.5 0 00-1.5 1.5v6A1.5 1.5 0 003 11.5h6A1.5 1.5 0 0010.5 10V7.5M7.5 1.5h4m0 0v4m0-4L6 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const closeIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const bookIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3.5C8 2.7 6.5 2 4.5 2S1 2.7 1 3.5v9C1 13.3 2.5 14 4.5 14S8 13.3 8 12.5m0-9C8 2.7 9.5 2 11.5 2S15 2.7 15 3.5v9c0 .8-1.5 1.5-3.5 1.5S8 13.3 8 12.5m0-9v9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const loading = el('div', { class: 'playbook-panel__loading' },
    el('div', { class: 'spinner' }),
    el('div', { class: 'playbook-panel__loading-text' }, 'Loading the Events Playbook…'),
  );

  const iframe = el('iframe', {
    class: 'playbook-panel__frame',
    src: PLAYBOOK_URL,
    title: 'Events Playbook',
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
  });
  iframe.addEventListener('load', () => {
    loading.classList.add('playbook-panel__loading--done');
    iframe.classList.add('playbook-panel__frame--ready');
  });

  const shareBtn = el('button', {
    type: 'button',
    class: 'playbook-panel__btn playbook-panel__btn--primary',
    title: 'Copy a public link to this playbook',
  },
    el('span', { class: 'playbook-panel__btn-icon', html: shareIcon }),
    el('span', { class: 'playbook-panel__btn-label' }, 'Share'),
  );
  shareBtn.addEventListener('click', () => copyShareLink(shareBtn));

  const newTabLink = el('a', {
    class: 'playbook-panel__btn',
    href: PLAYBOOK_URL,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: 'Open the playbook in a new browser tab',
  },
    el('span', { class: 'playbook-panel__btn-icon', html: externalIcon }),
    el('span', { class: 'playbook-panel__btn-label' }, 'Open in new tab'),
  );

  const closeBtn = el('button', {
    type: 'button',
    class: 'playbook-panel__close',
    title: 'Close (Esc)',
    html: closeIcon,
  });
  closeBtn.addEventListener('click', closePlaybookPanel);

  const node = el('div', {
    class: 'playbook-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Events Playbook',
  },
    el('div', { class: 'playbook-panel' },
      el('div', { class: 'playbook-panel__header' },
        el('div', { class: 'playbook-panel__heading' },
          el('span', { class: 'playbook-panel__book-icon', html: bookIcon }),
          el('div', {},
            el('div', { class: 'playbook-panel__title' }, 'Events Playbook'),
            el('div', { class: 'playbook-panel__subtitle' }, 'Interactive event workspace · embedded from aadsit7.github.io'),
          ),
        ),
        el('div', { class: 'playbook-panel__actions' },
          shareBtn,
          newTabLink,
          el('span', { class: 'playbook-panel__divider' }),
          closeBtn,
        ),
      ),
      el('div', { class: 'playbook-panel__body' },
        loading,
        iframe,
      ),
    ),
  );

  // Click on the dimmed backdrop (outside the panel) closes, mirroring
  // the modal component's behavior.
  node.addEventListener('click', (e) => {
    if (e.target === node) closePlaybookPanel();
  });

  return node;
}
