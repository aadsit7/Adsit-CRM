// ============================================
// Partner Portal — Global Keyboard Shortcut Manager
// ============================================

const registry = [];
let initialized = false;
let helpVisible = false;
let helpEl = null;

// Parse "Alt+R", "?", "Ctrl+Shift+O" into a structured descriptor.
function parseCombo(combo) {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  return {
    key,
    alt: parts.includes('Alt'),
    ctrl: parts.includes('Ctrl'),
    shift: parts.includes('Shift'),
  };
}

function comboLabel(combo) {
  const { key, alt, ctrl, shift } = parseCombo(combo);
  const pieces = [];
  if (ctrl) pieces.push('Ctrl');
  if (alt)  pieces.push('Alt');
  if (shift) pieces.push('Shift');
  pieces.push(key === ' ' ? 'Space' : key);
  return pieces;
}

function matches(e, parsed) {
  return (
    e.altKey   === parsed.alt   &&
    e.ctrlKey  === parsed.ctrl  &&
    e.shiftKey === parsed.shift &&
    (e.key === parsed.key || e.key.toLowerCase() === parsed.key.toLowerCase())
  );
}

// Register a shortcut.
// combo     – e.g. "Alt+R", "Alt+O", "?"
// label     – human-readable description shown in help overlay
// callback  – function called when shortcut fires
// group     – optional group heading in help overlay (default "Navigation")
export function registerHotkey(combo, label, callback, group = 'Navigation') {
  registry.push({ combo, label, callback, group, parsed: parseCombo(combo) });
}

// Remove all shortcuts registered against a particular callback (e.g. on view cleanup).
export function unregisterHotkey(callback) {
  const idx = registry.findIndex(r => r.callback === callback);
  if (idx !== -1) registry.splice(idx, 1);
}

export function initHotkeys() {
  if (initialized) return;
  initialized = true;

  // Built-in: "?" toggles help overlay
  registerHotkey('?', 'Show keyboard shortcuts', toggleHelp, 'General');

  document.addEventListener('keydown', (e) => {
    const t = document.activeElement;
    const typing = t && (
      t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.isContentEditable ||
      t.tagName === 'SELECT'
    );

    // If help overlay is open, close on Escape
    if (helpVisible && e.key === 'Escape') {
      closeHelp();
      e.stopPropagation();
      return;
    }

    for (const entry of registry) {
      if (!matches(e, entry.parsed)) continue;

      // Alt-based shortcuts fire even if user is typing (deliberate override).
      // Plain letter shortcuts (like ?) skip when typing to avoid collisions.
      if (typing && !entry.parsed.alt && !entry.parsed.ctrl) continue;

      e.preventDefault();
      entry.callback(e);
      return;
    }
  });
}

// ── Help Overlay ─────────────────────────────────────────────────────

function toggleHelp() {
  if (helpVisible) closeHelp(); else openHelp();
}

function openHelp() {
  if (helpEl) { helpEl.remove(); helpEl = null; }
  helpVisible = true;

  // Group shortcuts
  const groups = {};
  for (const entry of registry) {
    if (!groups[entry.group]) groups[entry.group] = [];
    groups[entry.group].push(entry);
  }

  // Build rows
  const groupOrder = ['General', 'Randy', 'Opportunities', 'Navigation'];
  const allGroups = [...groupOrder, ...Object.keys(groups).filter(g => !groupOrder.includes(g))];

  let bodyHTML = '';
  for (const g of allGroups) {
    if (!groups[g] || groups[g].length === 0) continue;
    bodyHTML += `<div class="hk-group">
      <div class="hk-group__title">${escHtml(g)}</div>`;
    for (const entry of groups[g]) {
      const keys = comboLabel(entry.combo);
      const kbds = keys.map(k => `<kbd>${escHtml(k)}</kbd>`).join('<span class="hk-plus">+</span>');
      bodyHTML += `<div class="hk-row">
        <span class="hk-desc">${escHtml(entry.label)}</span>
        <span class="hk-keys">${kbds}</span>
      </div>`;
    }
    bodyHTML += `</div>`;
  }

  helpEl = document.createElement('div');
  helpEl.className = 'hk-overlay';
  helpEl.setAttribute('role', 'dialog');
  helpEl.setAttribute('aria-modal', 'true');
  helpEl.setAttribute('aria-label', 'Keyboard shortcuts');
  helpEl.innerHTML = `
    <div class="hk-backdrop"></div>
    <div class="hk-panel">
      <div class="hk-panel__header">
        <h2 class="hk-panel__title">Keyboard Shortcuts</h2>
        <button class="hk-panel__close" aria-label="Close">&times;</button>
      </div>
      <div class="hk-panel__body">${bodyHTML}</div>
      <div class="hk-panel__footer">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</div>
    </div>`;

  helpEl.querySelector('.hk-backdrop').addEventListener('click', closeHelp);
  helpEl.querySelector('.hk-panel__close').addEventListener('click', closeHelp);

  document.body.appendChild(helpEl);
  // Trigger animation
  requestAnimationFrame(() => helpEl && helpEl.classList.add('hk-overlay--visible'));
}

function closeHelp() {
  helpVisible = false;
  if (!helpEl) return;
  helpEl.classList.remove('hk-overlay--visible');
  const el = helpEl;
  helpEl = null;
  el.addEventListener('transitionend', () => el.remove(), { once: true });
  // Fallback in case transition doesn't fire
  setTimeout(() => { try { el.remove(); } catch { /* ok */ } }, 300);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
