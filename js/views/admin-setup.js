// ============================================
// Admin Setup / Google Sheets Connection View
// ============================================

import { CONFIG, getRuntimeConfig, setRuntimeConfig } from '../config.js';
import { isConfigured, testConnection, initializeSheet, seedSheetData, syncHeaders, loadCustomPrompts, saveCustomPrompt, deleteCustomPrompt, saveReorderedPrompts } from '../sheets.js';
import { el, mount } from '../utils/dom.js';
import { setTopbarTitle } from '../components/sidebar.js';
import { showToast } from '../components/toast.js';
import { syncAiKeyFromBackend } from '../utils/file-api.js';
import { AI_PROVIDERS, normalizeProvider, providerLabel } from '../utils/ai-providers.js';

export const title = 'Setup';

export async function render(container) {
  setTopbarTitle('Google Sheets Setup');

  const spreadsheetId = getRuntimeConfig('SPREADSHEET_ID') || CONFIG.SPREADSHEET_ID;
  const apiKey = getRuntimeConfig('API_KEY') || CONFIG.API_KEY;
  const hasRealId = spreadsheetId && spreadsheetId !== 'YOUR_SPREADSHEET_ID_HERE';
  const hasApiKey = apiKey && apiKey !== 'YOUR_GOOGLE_API_KEY_HERE';

  // --- Status indicator ---
  const statusDot = el('span', { class: 'setup-status__dot setup-status__dot--checking' });
  const statusText = el('span', { class: 'setup-status__text' }, 'Checking connection...');
  const statusRow = el('div', { class: 'setup-status' }, statusDot, statusText);

  // --- API Key input ---
  const apiKeyInput = el('input', {
    class: 'form-input',
    type: 'text',
    placeholder: 'Paste your Google API Key here',
    value: hasApiKey ? apiKey : '',
  });

  // --- AI Assistant key status (auto-managed from Apps Script) ---
  // The Anthropic key is no longer pasted here. It lives as a Script
  // Property (ANTHROPIC_API_KEY) on the Apps Script web app and is pulled
  // into the app automatically on load. This row just reports whether that
  // pull succeeded so the admin can confirm the AI Assistant is powered.
  const aiKeyStatus = el('div', { class: 'form-hint' }, 'Checking…');

  // Kimi (Moonshot) connectivity. Like the Anthropic key, KIMI_API_KEY lives
  // as an Apps Script Script Property; here we only report whether one is set
  // (Kimi requests are proxied server-side, so the key never loads into the app).
  const kimiKeyStatus = el('div', { class: 'form-hint', style: { marginTop: '4px' } }, 'Checking…');

  // --- Spreadsheet ID display ---
  const sheetIdDisplay = el('input', {
    class: 'form-input',
    type: 'text',
    value: hasRealId ? spreadsheetId : '',
    placeholder: 'Not configured',
    readOnly: false,
  });

  // --- Tabs display ---
  const tabsDisplay = el('div', { class: 'setup-tabs', id: 'setup-tabs' });

  // --- Action buttons ---
  const saveBtn = el('button', { class: 'btn btn--primary', onClick: handleSave }, 'Save Configuration');
  const testBtn = el('button', { class: 'btn btn--secondary', onClick: handleTest }, 'Test Connection');
  const initBtn = el('button', { class: 'btn btn--success', onClick: handleInit }, 'Initialize Sheet');
  const syncBtn = el('button', { class: 'btn btn--secondary', onClick: handleSync }, 'Sync Headers');
  const seedBtn = el('button', { class: 'btn btn--secondary', onClick: handleSeed }, 'Seed Demo Data');

  const content = el('div', { class: 'setup-page' },
    // Header section
    el('div', { class: 'setup-header' },
      el('h2', { class: 'setup-header__title' }, 'Google Sheets Connection'),
      el('p', { class: 'setup-header__description' },
        'Connect a Google Sheet as the database for Partners, Opportunities, and Events. All changes in the portal automatically sync to the sheet.'
      )
    ),

    // Connection status
    el('div', { class: 'setup-card' },
      el('h3', { class: 'setup-card__title' }, 'Connection Status'),
      statusRow,
      tabsDisplay
    ),

    // Configuration form
    el('div', { class: 'setup-card' },
      el('h3', { class: 'setup-card__title' }, 'Configuration'),

      el('div', { class: 'form-group' },
        el('label', { class: 'form-label' }, 'Spreadsheet ID'),
        sheetIdDisplay,
        el('div', { class: 'form-hint' },
          'From the spreadsheet URL: docs.google.com/spreadsheets/d/',
          el('strong', {}, '{THIS_PART}'),
          '/edit'
        )
      ),

      el('div', { class: 'form-group' },
        el('label', { class: 'form-label' }, 'Google API Key'),
        apiKeyInput,
        el('div', { class: 'form-hint' },
          'Optional if logged in with Google SSO. Required for unauthenticated access. ',
          'Create one at console.cloud.google.com > Credentials.'
        )
      ),

      el('div', { class: 'form-group' },
        el('label', { class: 'form-label' }, 'AI Assistant API Key'),
        aiKeyStatus,
        kimiKeyStatus,
        el('div', { class: 'form-hint' },
          'Managed automatically. Keys are read from the Google Apps Script ',
          'web app (Project Settings → Script Properties → ',
          el('strong', {}, 'ANTHROPIC_API_KEY'),
          ' and ',
          el('strong', {}, 'KIMI_API_KEY'),
          '), so there is nothing to paste here. Update a key in Apps Script and it applies everywhere.'
        )
      ),

      el('div', { class: 'setup-actions' }, saveBtn, testBtn)
    ),

    // Sheet Initialization
    el('div', { class: 'setup-card' },
      el('h3', { class: 'setup-card__title' }, 'Sheet Initialization'),
      el('p', { class: 'setup-card__description' },
        'Create the required tabs (Partners, Opportunities, Events) with header rows in your Google Sheet.'
      ),
      el('div', { class: 'setup-actions' },
        initBtn,
        syncBtn,
        seedBtn
      ),
      el('div', { class: 'form-hint', style: { marginTop: 'var(--space-3)' } },
        'Initialize creates the 3 tabs with headers. Seed populates them with sample data. You must be logged in with Google SSO for these to work.'
      )
    ),

    // AI Assistant Presets
    el('div', { class: 'setup-card' },
      el('h3', { class: 'setup-card__title' }, 'AI Assistant Presets'),
      el('p', { class: 'setup-card__description' },
        'Create up to 5 custom instruction sets for Randy. Activate one from the pill menu above Randy\'s chat input to change how he responds for that conversation.'
      ),
      el('p', { class: 'setup-card__description', style: { marginTop: '6px' } },
        'Each preset can run on a different AI backend. Use the ',
        el('strong', {}, 'AI Provider'),
        ' slider to pick Anthropic (Claude) or Kimi (Moonshot) — requests you send while that preset is active use the chosen API.'
      ),
      el('p', { class: 'setup-card__description', style: { marginTop: '6px', fontStyle: 'italic' } },
        'Tip: naming a preset “Timeline PDF” activates automatic PDF generation mode — any message you send becomes the opportunity name.'
      ),
      el('div', { id: 'presets-container', style: { display: 'flex', flexDirection: 'column', gap: '12px' } }),
      el('div', { style: { marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' } },
        el('button', {
          class: 'btn btn--secondary',
          id: 'add-preset-btn',
          onClick: handleAddPreset,
        }, '+ Add Preset'),
        el('button', {
          class: 'btn btn--primary',
          id: 'save-order-btn',
          style: { display: 'none' },
          onClick: handleSaveOrder,
        }, 'Save Order')
      )
    ),

    // Content Visibility
    el('div', { class: 'setup-card' },
      el('h3', { class: 'setup-card__title' }, 'Content Visibility'),
      el('p', { class: 'setup-card__description' },
        'Control which data appears across the portal. When off, the corresponding records are hidden from all dashboards and views.'
      ),

      el('div', { class: 'toggle-section' },
        el('div', { class: 'toggle-section__heading' }, 'Partners'),
        toggleRow('Show Inactive Partners',
          'Display partners with inactive status in all views',
          'SHOW_INACTIVE_PARTNERS')
      ),

      el('div', { class: 'toggle-section' },
        el('div', { class: 'toggle-section__heading' }, 'Events'),
        toggleRow('Show Past Events',
          'Display completed events in all views',
          'SHOW_PAST_EVENTS'),
        toggleRow('Show Cancelled Events',
          'Display events with cancelled status in all views',
          'SHOW_CANCELLED_EVENTS')
      ),

      el('div', { class: 'toggle-section' },
        el('div', { class: 'toggle-section__heading' }, 'Opportunities'),
        toggleRow('Show Closed Lost Opportunities',
          'Display opportunities with Lost status in all views',
          'SHOW_CLOSED_LOST_OPPS')
      )
    ),

    // How it works
    el('div', { class: 'setup-card' },
      el('h3', { class: 'setup-card__title' }, 'How Auto-Sync Works'),
      el('div', { class: 'setup-info' },
        infoItem('Create', 'Adding a partner, opportunity, or event appends a new row to the corresponding sheet tab.'),
        infoItem('Edit', 'Editing a record updates the matching row in-place.'),
        infoItem('Delete', 'Deleting a record removes the row from the sheet.'),
        infoItem('Read', 'Every page load reads live data from the Google Sheet.'),
      )
    ),

    // Keyboard Shortcuts
    el('div', { class: 'setup-card' },
      el('h3', { class: 'setup-card__title' }, 'Keyboard Shortcuts'),
      el('p', { class: 'setup-card__description' }, 'Available to admin users. Press ? anywhere to open the full shortcuts overlay.'),
      el('table', { class: 'shortcuts-table' },
        el('thead', {},
          el('tr', {},
            el('th', {}, 'Shortcut'),
            el('th', {}, 'Action'),
            el('th', {}, 'Group'),
          )
        ),
        el('tbody', {},
          shortcutRow('?', 'Show keyboard shortcuts', 'General'),
          shortcutRow('Alt + Z', 'Activate Randy voice', 'Randy'),
          shortcutRow('Alt + O', 'New Opportunity', 'Opportunities'),
          shortcutRow('Alt + D', 'Dashboard', 'Navigation'),
          shortcutRow('Alt + A', 'Quick Form', 'Navigation'),
          shortcutRow('Alt + P', 'Partners', 'Navigation'),
          shortcutRow('Alt + E', 'Events', 'Navigation'),
          shortcutRow('Alt + L', 'LeadCheck', 'Navigation'),
        )
      )
    )
  );

  mount(container, content);

  // Check connection on load
  checkStatus();

  // Confirm the Anthropic key can be read from the Apps Script.
  refreshAiKeyStatus();

  // Load and render existing presets
  loadCustomPrompts().then(presets => renderPresetCards(presets)).catch(() => {});

  // --- Handlers ---

  async function handleSave() {
    const newId = sheetIdDisplay.value.trim();
    const newKey = apiKeyInput.value.trim();

    if (newId) setRuntimeConfig('SPREADSHEET_ID', newId);
    if (newKey) setRuntimeConfig('API_KEY', newKey);

    showToast('Configuration saved', 'success');
    checkStatus();
  }

  async function handleTest() {
    setStatus('checking', 'Testing connection...');
    try {
      const result = await testConnection();
      setStatus('connected', `Connected — found ${result.tabs.length} tab(s): ${result.tabs.join(', ')}`);
      renderTabs(result.tabs);
      showToast('Connection successful', 'success');
    } catch (err) {
      setStatus('error', `Connection failed: ${err.message}`);
      showToast(err.message, 'error');
    }
  }

  async function handleInit() {
    initBtn.disabled = true;
    initBtn.textContent = 'Initializing...';
    try {
      const result = await initializeSheet();
      showToast(`Sheet initialized — ${result.tabsCreated} tab(s) created`, 'success');
      checkStatus();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      initBtn.disabled = false;
      initBtn.textContent = 'Initialize Sheet';
    }
  }

  async function handleSync() {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing...';
    try {
      await syncHeaders();
      showToast('Headers synced to current schema', 'success');
      checkStatus();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Headers';
    }
  }

  async function handleSeed() {
    seedBtn.disabled = true;
    seedBtn.textContent = 'Seeding data...';
    try {
      await seedSheetData();
      showToast('Demo data seeded to all tabs', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      seedBtn.disabled = false;
      seedBtn.textContent = 'Seed Demo Data';
    }
  }

  function setStatus(state, message) {
    statusDot.className = `setup-status__dot setup-status__dot--${state}`;
    statusText.textContent = message;
  }

  async function refreshAiKeyStatus() {
    aiKeyStatus.textContent = 'Checking…';
    aiKeyStatus.style.color = '';
    kimiKeyStatus.textContent = 'Checking…';
    kimiKeyStatus.style.color = '';
    const key = await syncAiKeyFromBackend();
    if (key) {
      aiKeyStatus.textContent = `✓ Anthropic connected — key loaded from Apps Script (…${key.slice(-4)})`;
      aiKeyStatus.style.color = '#059669';
    } else {
      aiKeyStatus.textContent = '✗ Anthropic: no key found. Add ANTHROPIC_API_KEY to the Apps Script Script Properties and redeploy.';
      aiKeyStatus.style.color = '#dc2626';
    }
    // Kimi presence is stashed by syncAiKeyFromBackend (server-side key).
    if (getRuntimeConfig('KIMI_KEY_PRESENT')) {
      kimiKeyStatus.textContent = '✓ Kimi connected — KIMI_API_KEY is configured in Apps Script.';
      kimiKeyStatus.style.color = '#059669';
    } else {
      kimiKeyStatus.textContent = '○ Kimi not configured — add KIMI_API_KEY in Apps Script to run presets on Kimi.';
      kimiKeyStatus.style.color = 'var(--color-text-muted)';
    }
  }

  function renderTabs(tabs) {
    tabsDisplay.innerHTML = '';
    if (tabs.length === 0) return;
    const required = [CONFIG.SHEET_PARTNERS, CONFIG.SHEET_OPPORTUNITIES, CONFIG.SHEET_EVENTS];
    tabs.forEach(tab => {
      const isRequired = required.includes(tab);
      tabsDisplay.appendChild(
        el('span', { class: `badge ${isRequired ? 'badge--won' : 'badge--silver'}` }, tab)
      );
    });
  }

  async function checkStatus() {
    if (!isConfigured()) {
      setStatus('error', 'Not configured — save a Spreadsheet ID and API key, or log in with Google SSO.');
      return;
    }
    setStatus('checking', 'Testing connection...');
    try {
      const result = await testConnection();
      setStatus('connected', `Connected — ${result.tabs.length} tab(s) found`);
      renderTabs(result.tabs);
    } catch (err) {
      setStatus('error', `Error: ${err.message}`);
    }
  }

  // ── AI Assistant Presets ─────────────────────────────────────────

  const PRESET_COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2'];

  let originalOrderIds = [];
  let dragSrc = null;

  function buildPresetCard(preset, index) {
    const isNew = !preset._rowIndex;

    const dragHandle = el('span', {
      style: {
        cursor: 'grab',
        color: '#9ca3af',
        fontSize: '16px',
        lineHeight: '1',
        flexShrink: '0',
        userSelect: 'none',
        paddingRight: '2px',
      },
    }, '⠿');

    const colorDot = el('span', {
      class: 'preset-color-dot',
      style: {
        display: 'inline-block',
        width: '12px',
        height: '12px',
        borderRadius: '50%',
        background: PRESET_COLORS[index] || '#6b7280',
        flexShrink: '0',
      },
    });

    const labelInput = el('input', {
      class: 'form-input',
      type: 'text',
      placeholder: 'Preset name (e.g. Deal Analyst)',
      value: preset.label || '',
      style: { flex: '1' },
    });

    const instructionsInput = el('textarea', {
      class: 'form-input',
      placeholder: 'Describe how Randy should behave when this preset is active...',
      rows: '4',
      style: { resize: 'vertical' },
    }, preset.instructions || '');

    // Per-preset AI backend selector. Defaults to Anthropic; switching to
    // Kimi routes this preset's requests through the Kimi (Moonshot) proxy.
    const providerSlider = buildProviderSlider(preset.provider);

    const savePresetBtn = el('button', {
      class: 'btn btn--primary',
      style: { fontSize: '0.875rem', padding: '7px 14px' },
      onClick: async () => {
        const label = labelInput.value.trim();
        const icon = String(index + 1);
        const instructions = instructionsInput.value.trim();
        if (!label) { showToast('Preset name is required', 'error'); return; }
        if (!instructions) { showToast('Instructions are required', 'error'); return; }
        const provider = providerSlider.get();
        savePresetBtn.disabled = true;
        savePresetBtn.textContent = 'Saving...';
        try {
          await saveCustomPrompt(preset.prompt_id || null, label, icon, instructions, preset._rowIndex || null, provider);
          showToast(`Preset saved — runs on ${providerLabel(provider)}`, 'success');
          preset.prompt_id = preset.prompt_id || label;
          preset.label = label;
          preset.icon = icon;
          preset.instructions = instructions;
          preset.provider = provider;
          window.dispatchEvent(new CustomEvent('custom-prompts-changed'));
          // Reload cards to get the updated _rowIndex for newly-created presets
          if (isNew) {
            loadCustomPrompts().then(p => renderPresetCards(p)).catch(() => {});
          }
        } catch (err) {
          showToast(err.message || 'Failed to save preset', 'error');
        } finally {
          savePresetBtn.disabled = false;
          savePresetBtn.textContent = 'Save Preset';
        }
      },
    }, 'Save Preset');

    const deletePresetBtn = el('button', {
      class: 'btn btn--secondary',
      style: { fontSize: '0.875rem', padding: '7px 10px', color: '#dc2626', borderColor: '#fca5a5' },
      onClick: async () => {
        if (!preset._rowIndex) { card.remove(); refreshAddBtn(); return; }
        deletePresetBtn.disabled = true;
        deletePresetBtn.textContent = '...';
        try {
          await deleteCustomPrompt(preset._rowIndex);
          showToast('Preset deleted', 'success');
          card.remove();
          refreshAddBtn();
          window.dispatchEvent(new CustomEvent('custom-prompts-changed'));
        } catch (err) {
          showToast(err.message || 'Failed to delete preset', 'error');
          deletePresetBtn.disabled = false;
          deletePresetBtn.textContent = '✕';
        }
      },
    }, '✕');

    const card = el('div', {
      class: 'preset-card setup-card',
      draggable: 'true',
      style: { margin: '0', padding: '14px', border: '1px solid #e5e7eb', borderRadius: '8px' },
    },
      el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' } },
        dragHandle,
        colorDot,
        labelInput,
        deletePresetBtn
      ),
      el('div', { class: 'form-group', style: { marginBottom: '10px' } },
        el('label', { class: 'form-label' }, 'Instructions'),
        instructionsInput
      ),
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap' } },
        el('div', { class: 'preset-provider' },
          el('label', { class: 'form-label', style: { marginBottom: '4px' } }, 'AI Provider'),
          providerSlider.el
        ),
        savePresetBtn
      )
    );

    card._presetData = preset;

    card.addEventListener('dragstart', e => {
      if (e.target.closest('input, textarea, button')) { e.preventDefault(); return; }
      dragSrc = card;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => { card.style.opacity = '0.4'; }, 0);
    });

    card.addEventListener('dragend', () => {
      card.style.opacity = '';
      dragSrc = null;
      refreshSaveOrderBtn();
    });

    return card;
  }

  function renderPresetCards(presets) {
    const container = document.getElementById('presets-container');
    if (!container) return;
    container.innerHTML = '';
    originalOrderIds = presets.map(p => p.prompt_id || p.label);
    presets.forEach((p, i) => container.appendChild(buildPresetCard(p, i)));
    setupDragDrop(container);
    refreshAddBtn();
    refreshSaveOrderBtn();
  }

  function setupDragDrop(container) {
    if (container._dndReady) return;
    container._dndReady = true;

    container.addEventListener('dragover', e => {
      e.preventDefault();
      if (!dragSrc) return;
      const target = e.target.closest('.preset-card');
      if (!target || target === dragSrc) return;
      const rect = target.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      container.insertBefore(dragSrc, after ? target.nextSibling : target);
      updateColorDots(container);
    });

    container.addEventListener('drop', e => { e.preventDefault(); });
  }

  function updateColorDots(container) {
    Array.from(container.children).forEach((card, i) => {
      const dot = card.querySelector('.preset-color-dot');
      if (dot) dot.style.background = PRESET_COLORS[i] || '#6b7280';
    });
  }

  function getCurrentOrder() {
    const container = document.getElementById('presets-container');
    if (!container) return [];
    return Array.from(container.children).map(card => card._presetData).filter(Boolean);
  }

  function refreshSaveOrderBtn() {
    const btn = document.getElementById('save-order-btn');
    if (!btn) return;
    const current = getCurrentOrder();
    const changed = current.length > 0 && current.some(
      (p, i) => (p.prompt_id || p.label) !== originalOrderIds[i]
    );
    btn.style.display = changed ? '' : 'none';
  }

  async function handleSaveOrder() {
    const saveOrderBtn = document.getElementById('save-order-btn');
    const orderedPresets = getCurrentOrder().filter(p => p._rowIndex);
    if (orderedPresets.length === 0) return;
    saveOrderBtn.disabled = true;
    saveOrderBtn.textContent = 'Saving...';
    try {
      await saveReorderedPrompts(orderedPresets);
      showToast('Order saved', 'success');
      window.dispatchEvent(new CustomEvent('custom-prompts-changed'));
      loadCustomPrompts().then(p => renderPresetCards(p)).catch(() => {});
    } catch (err) {
      showToast(err.message || 'Failed to save order', 'error');
    } finally {
      saveOrderBtn.disabled = false;
      saveOrderBtn.textContent = 'Save Order';
    }
  }

  function refreshAddBtn() {
    const container = document.getElementById('presets-container');
    const addBtn = document.getElementById('add-preset-btn');
    if (!container || !addBtn) return;
    addBtn.disabled = container.children.length >= 5;
    addBtn.title = container.children.length >= 5 ? 'Maximum of 5 presets reached' : '';
  }

  function handleAddPreset() {
    const container = document.getElementById('presets-container');
    if (!container || container.children.length >= 5) return;
    const card = buildPresetCard({}, container.children.length);
    container.appendChild(card);
    card.querySelector('input')?.focus();
    refreshAddBtn();
  }
}

// Two-option segmented slider for choosing a preset's AI backend
// (Anthropic ↔ Kimi). Returns the wrapper element plus a get() that
// reports the currently-selected provider id.
function buildProviderSlider(currentProvider) {
  let selected = normalizeProvider(currentProvider);

  const options = AI_PROVIDERS.map(p =>
    el('button', {
      type: 'button',
      class: 'provider-slider__opt',
      role: 'radio',
      title: p.hint,
      dataset: { provider: p.id },
      onClick: () => setSelected(p.id),
    }, p.label)
  );

  const track = el('div', {
    class: 'provider-slider',
    role: 'radiogroup',
    'aria-label': 'AI provider for this preset',
  }, ...options);

  function setSelected(id) {
    selected = normalizeProvider(id);
    options.forEach(opt => {
      const active = opt.dataset.provider === selected;
      opt.classList.toggle('is-active', active);
      opt.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }
  setSelected(selected);

  return { el: track, get: () => selected };
}

function infoItem(label, description) {
  return el('div', { class: 'setup-info__item' },
    el('div', { class: 'setup-info__label' }, label),
    el('div', { class: 'setup-info__desc' }, description)
  );
}

function shortcutRow(combo, action, group) {
  return el('tr', {},
    el('td', {}, el('kbd', { class: 'shortcut-kbd' }, combo)),
    el('td', {}, action),
    el('td', { class: 'shortcut-group' }, group),
  );
}

function toggleRow(label, description, configKey) {
  const isOn = getRuntimeConfig(configKey);
  const checkbox = el('input', {
    type: 'checkbox',
    class: 'toggle-slider__input',
    ...(isOn ? { checked: true } : {}),
    onChange: (e) => {
      setRuntimeConfig(configKey, e.target.checked);
    },
  });

  return el('div', { class: 'toggle-row' },
    el('div', { class: 'toggle-row__text' },
      el('div', { class: 'toggle-row__label' }, label),
      el('div', { class: 'toggle-row__desc' }, description)
    ),
    el('label', { class: 'toggle-slider' },
      checkbox,
      el('span', { class: 'toggle-slider__track' })
    )
  );
}

export function cleanup() {}
