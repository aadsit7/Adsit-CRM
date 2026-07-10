// ============================================
// Dedicated Randy Page — split two-column view
// ============================================
// Left column: the SAME singleton Randy widget that floats around the
// app (chat, mode presets / custom GPTs, voice, type), docked in place.
// Right column: the Quick Add form, embedded inline instead of floating.
// Both reuse their one existing instance rather than being cloned, so
// leaving the page returns each to its normal floating behavior — the
// floating assistant and the Add-button form are never lost.

import { setTopbarTitle } from '../components/sidebar.js';
import { dockRandy, undockRandy } from '../components/randy.js';
import { mountQuickFormInline, unmountQuickFormInline } from '../components/quick-form.js';

// Track the Randy "Add" button wrap we hide while the form lives inline,
// so cleanup can restore it.
let hiddenAddWrap = null;

export function render(container) {
  setTopbarTitle('Randy');

  const view = container || document.getElementById('view-container');
  if (!view) return;

  view.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'randy-page randy-page--split';

  const chatPane = document.createElement('div');
  chatPane.className = 'randy-page__pane randy-page__pane--chat';

  const formPane = document.createElement('div');
  formPane.className = 'randy-page__pane randy-page__pane--form';

  page.append(chatPane, formPane);
  view.appendChild(page);

  // Dock the shared Randy widget into the left column. If the browser
  // lacks Web Speech support the widget was never mounted — show a note.
  const docked = dockRandy(chatPane);
  if (!docked) {
    chatPane.innerHTML = `
      <div class="randy-page__fallback">
        <img src="assets/randy-avatar.png" alt="Randy">
        <p><strong>Randy needs a supported browser.</strong></p>
        <p>Voice and chat require the Web Speech API. Open the portal in
        the latest Chrome or Edge to use the assistant here.</p>
      </div>`;
  } else {
    // The Add button is redundant here (the form is always shown on the
    // right), so hide its control while docked in split mode.
    const wrap = document.getElementById('randy-form-bottom-btn')?.closest('.randy-btn-wrap');
    if (wrap) { wrap.classList.add('randy-btn-wrap--hidden'); hiddenAddWrap = wrap; }
  }

  // Embed the Quick Add form into the right column.
  mountQuickFormInline(formPane);
}

export function cleanup() {
  // Restore both singletons to their normal floating behavior.
  unmountQuickFormInline();
  undockRandy();
  if (hiddenAddWrap) { hiddenAddWrap.classList.remove('randy-btn-wrap--hidden'); hiddenAddWrap = null; }
}
