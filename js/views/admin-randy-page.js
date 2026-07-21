// ============================================
// Dedicated Randy Page — split two-column view
// ============================================
// Left column: the SAME singleton Randy widget that floats around the
// app (chat, mode presets / custom GPTs, voice, type), docked in place,
// with a dedicated preset selection menu as a header above the chat.
// Right column: the Quick Add form, embedded inline instead of floating.
// Both reuse their one existing instance rather than being cloned, so
// leaving the page returns each to its normal floating behavior — the
// floating assistant and the Add-button form are never lost.

import { setTopbarTitle } from '../components/sidebar.js';
import {
  dockRandy, undockRandy,
  getRandyPresets, getActiveRandyPresetId, setActiveRandyPreset,
  ensureRandyPresetsLoaded, RANDY_PRESET_COLORS,
} from '../components/randy.js';
import { mountQuickFormInline, unmountQuickFormInline } from '../components/quick-form.js';

// Track the Randy "Add" button wrap we hide while the form lives inline,
// so cleanup can restore it.
let hiddenAddWrap = null;

// The preset-menu refresh listener, kept so cleanup() can detach it.
let onPresetChanged = null;

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

  // Host that the shared widget docks into. Kept separate from the chat
  // pane itself so the preset menu can sit above it as a static header
  // without fighting the docked widget's absolute, inset-0 layout.
  const widgetHost = document.createElement('div');
  widgetHost.className = 'randy-page__widget-host';
  chatPane.appendChild(widgetHost);

  // Dock the shared Randy widget into the left column. If the browser
  // lacks Web Speech support the widget was never mounted — show a note.
  const docked = dockRandy(widgetHost);
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

    // Add the dedicated preset selection menu as a header above the chat.
    // Selecting a preset drives the same active-preset state the widget's
    // built-in Mode dropdown uses, so Randy responds with that preset's
    // custom instructions.
    const bar = buildPresetBar();
    chatPane.insertBefore(bar.el, widgetHost);

    // Keep the menu in sync when the active preset or the configured list
    // changes (from here, the widget's Mode dropdown, or the Setup page).
    onPresetChanged = () => bar.refresh();
    window.addEventListener('randy-preset-changed', onPresetChanged);
    window.addEventListener('custom-prompts-changed', onPresetChanged);

    // Populate immediately, then again once presets have loaded.
    bar.refresh();
    ensureRandyPresetsLoaded().then(() => bar.refresh()).catch(() => bar.refresh());
  }

  // Embed the Quick Add form into the right column.
  mountQuickFormInline(formPane);
}

// Build the preset selection menu shown at the top of the Randy page.
// Returns the element plus a refresh() that re-syncs it to current state.
function buildPresetBar() {
  const wrap = document.createElement('div');
  wrap.className = 'randy-preset-bar';

  const label = document.createElement('label');
  label.className = 'randy-preset-bar__label';
  label.setAttribute('for', 'randy-preset-select');
  label.textContent = 'Preset';

  const dot = document.createElement('span');
  dot.className = 'randy-preset-bar__dot randy-preset-bar__dot--default';

  const select = document.createElement('select');
  select.id = 'randy-preset-select';
  select.className = 'randy-preset-bar__select';
  select.setAttribute('aria-label', 'Randy response preset');

  const hint = document.createElement('span');
  hint.className = 'randy-preset-bar__hint';
  hint.hidden = true;

  // On selection, switch Randy to that preset's custom instructions. An
  // empty value means "Default" (no preset / base behavior).
  select.addEventListener('change', () => {
    setActiveRandyPreset(select.value || null);
  });

  wrap.append(label, dot, select, hint);

  function refresh() {
    const presets = getRandyPresets();
    const activeId = getActiveRandyPresetId();

    // Rebuild options: Default first, then each configured preset.
    select.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Default (no preset)';
    select.appendChild(def);

    presets.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = p.prompt_id || '';
      opt.textContent = p.label || `Preset ${i + 1}`;
      select.appendChild(opt);
    });

    // Reflect the active preset (falls back to Default if it was deleted).
    const activeIdx = presets.findIndex(p => p.prompt_id === activeId);
    select.value = activeIdx >= 0 ? (presets[activeIdx].prompt_id || '') : '';

    // Colored swatch mirrors the widget's Mode dot for the active preset.
    const color = activeIdx >= 0 ? (RANDY_PRESET_COLORS[activeIdx] || '#6b7280') : '';
    dot.style.background = color || 'transparent';
    dot.style.borderColor = color ? 'transparent' : '#9ca3af';
    dot.classList.toggle('randy-preset-bar__dot--default', !color);

    // Guide the admin to Setup when nothing is configured yet.
    const empty = presets.length === 0;
    hint.textContent = empty ? 'No presets yet — add them in Setup.' : '';
    hint.hidden = !empty;
  }

  return { el: wrap, refresh };
}

export function cleanup() {
  // Restore both singletons to their normal floating behavior.
  unmountQuickFormInline();
  undockRandy();
  if (hiddenAddWrap) { hiddenAddWrap.classList.remove('randy-btn-wrap--hidden'); hiddenAddWrap = null; }
  if (onPresetChanged) {
    window.removeEventListener('randy-preset-changed', onPresetChanged);
    window.removeEventListener('custom-prompts-changed', onPresetChanged);
    onPresetChanged = null;
  }
}
