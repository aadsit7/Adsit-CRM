// ============================================
// Admin Opportunities Management View
// ============================================

import { getCurrentUser } from '../auth.js';
import { readSheetAsObjects, appendRow, updateRow, deleteRow, isConfigured, addDemoRow, updateDemoRow, deleteDemoRow } from '../sheets.js';
import { CONFIG } from '../config.js';
import { el, mount, uuid, $, debounce, formatCurrency } from '../utils/dom.js';
import { nowISO, formatDate, todayISO } from '../utils/date.js';
import { openModal, closeModal, confirmDialog } from '../components/modal.js';
import { buildForm } from '../components/form.js';
import { showToast } from '../components/toast.js';
import { setTopbarTitle } from '../components/sidebar.js';
import { statCard } from '../components/card.js';
import { filterPartners, filterOpportunities } from '../utils/filters.js';
import { ensureHtml, stripHtml } from '../components/quill-editor.js';
import { loadTypeFilter, computeTypeData, buildTypeFilterBar, applyTypeFilter } from '../components/type-filter.js';
import { generateMapPdfFromSelection } from '../utils/map-pdf-from-selection.js';
import { createPill, updatePillStage, markPillSuccess, markPillFailure } from '../components/map-pdf-pill.js';
import { fileApiRequest as fileApiRequestImpl } from '../utils/file-api.js';
import {
  buildDescriptionsPanel,
  buildDescriptionEditorForm,
  isDescriptionEmpty,
  pickLatestDescriptionText,
  toISODateOnly,
  getDescriptionKey,
} from '../components/descriptions-panel.js';
import {
  buildDocumentsPanel,
  listEntityDocuments,
} from '../components/documents-panel.js';
import { standardizeDescription, applyStandardizedDescription } from '../utils/ai.js';

export const title = 'Opportunities';

let cachedPartners = null;
let cachedOpps = null;
let cachedEvents = null;

// Keyboard shortcut handler — registered during render, removed on cleanup.
let newOppShortcutHandler = null;

// Tracks the Documents panel inside the currently-open Opportunity
// modal so external code (Randy's MAP PDF flow) can inject a freshly
// uploaded file into the visible list without reopening the modal.
// Null whenever no opportunity modal is open. See buildDocumentsPanel()
// for the handle shape; cleared in the openModal onClose callback.
let activeDocsPanel = null;

// opportunity_id of whichever opportunity's details modal is currently open.
// Set by openOppDetailsModal, cleared in its onClose callback. Used by
// background MAP PDF jobs to decide whether to inject into the open modal
// or auto-open the modal when generation finishes.
let activeModalOppId = null;

// Tracks in-flight and recently-completed Standardize jobs keyed by description_id.
// Entries survive modal close/reopen so the user can navigate away mid-job.
// Shape: { pill, desc, status: 'running'|'done'|'failed', result?, error? }
const standardizeJobs = new Map();

/**
 * Inject a just-uploaded file into the currently-open Opportunity
 * modal's Documents panel. Returns true if the modal was open for
 * the matching opportunity and the file was appended; false otherwise.
 *
 * Randy calls this after a successful Drive upload so the user sees
 * the new document appear without reopening the modal.
 */
export function addFileToActiveDocsPanel(opportunityId, file) {
  if (!activeDocsPanel || !opportunityId) return false;
  if (String(activeDocsPanel.entityId) !== String(opportunityId)) return false;
  try {
    activeDocsPanel.addFile(file);
    return true;
  } catch (err) {
    console.warn('addFileToActiveDocsPanel failed', err);
    return false;
  }
}

const OPP_STAGES = ['Prospect', 'Qualified', 'Develop', 'Proposal', 'Negotiation', 'Closed'];
const OPP_STATUSES = ['Registered', 'In Progress', 'Won', 'Lost'];

let allBasePartners = null;
let allBaseOpps = null;

export async function render(container) {
  setTopbarTitle('Opportunities');
  mount(container, el('div', { class: 'loading-overlay' }, el('div', { class: 'spinner' })));

  try {
    await loadOpportunityData();
    renderWithTypeFilter(container);

    // Register global shortcut handler for Alt+O (new opportunity)
    if (newOppShortcutHandler) window.removeEventListener('shortcut:new-opportunity', newOppShortcutHandler);
    newOppShortcutHandler = () => openOppModal(null, container);
    window.addEventListener('shortcut:new-opportunity', newOppShortcutHandler);

    // If navigated here via Alt+O from another page, open the modal immediately
    if (window._pendingNewOpp) {
      delete window._pendingNewOpp;
      requestAnimationFrame(() => openOppModal(null, container));
    }
  } catch (err) {
    mount(container, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'Error loading opportunities'),
      el('div', { class: 'empty-state__description' }, err.message)
    ));
  }
}

// Pull the sheets this view renders from into module state. Split out of
// render() so a re-render after a mutation can refresh them too — see
// reRender().
async function loadOpportunityData() {
  const [opportunities, partners, events] = await Promise.all([
    readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
    readSheetAsObjects(CONFIG.SHEET_PARTNERS),
    readSheetAsObjects(CONFIG.SHEET_EVENTS),
  ]);
  allBasePartners = filterPartners(partners);
  allBaseOpps = filterOpportunities(opportunities);
  cachedPartners = allBasePartners;
  cachedEvents = events;
}

function renderWithTypeFilter(container) {
  const selectedTypes = loadTypeFilter();
  const allTypeData = computeTypeData(allBasePartners, allBaseOpps);
  const allUniqueTypes = Object.keys(allTypeData);
  const allTotalPipeline = allBaseOpps.filter(o => o.status !== 'Won').reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);
  const validSelected = selectedTypes.filter(t => allUniqueTypes.includes(t));

  const { partners: tfPartners, opportunities: tfOpps } = applyTypeFilter({
    partners: allBasePartners, opportunities: allBaseOpps, selected: validSelected,
  });
  cachedPartners = tfPartners;
  cachedOpps = tfOpps;

  const filterBar = buildTypeFilterBar({
    allUniqueTypes, allTypeData, allTotalPipeline, validSelected,
    onChanged: () => renderWithTypeFilter(container),
  });

  renderView(container, cachedOpps, filterBar);
}

// Re-render AFTER re-reading the sheet — see the note on admin-partners.js's
// reRender. Redrawing the module-level `allBaseOpps` without refetching left
// every deal below a deleted one carrying a `_rowIndex` one too high for the
// rest of the session, so the next kanban drop, inline field edit or modal save
// wrote a full 13-column row over an unrelated opportunity — annihilating it
// and leaving two rows sharing one opportunity_id.
function reRender() {
  const viewContainer = document.getElementById('view-container');
  return loadOpportunityData()
    .then(() => renderWithTypeFilter(viewContainer))
    .catch((err) => {
      showToast(err.message || 'Saved, but the list could not be refreshed. Reload the page.', 'error');
    });
}

function getPartnerName(partnerId) {
  if (!partnerId || !cachedPartners) return '';
  const p = cachedPartners.find(p => p.partner_id === partnerId);
  return p ? p.display_name : partnerId;
}

// Shared between the details modal (inline edit) and the full edit modal.
function computeLeadSourceOptions(partnerId) {
  const options = [{ value: 'salesperson', label: 'Salesperson Created' }];
  if (!cachedEvents || !partnerId) return options;

  const relevantEvents = cachedEvents.filter(evt => {
    if (evt.partner_id && evt.partner_id !== partnerId) return false;
    if (evt.status === 'Cancelled') return false;
    return true;
  });

  relevantEvents
    .sort((a, b) => (b.event_date || '').localeCompare(a.event_date || ''))
    .forEach(evt => {
      const typeLabel = evt.event_type ? `[${evt.event_type}]` : '';
      const dateLabel = evt.event_date ? ` - ${formatDate(evt.event_date)}` : '';
      options.push({
        value: evt.event_id,
        label: `${typeLabel} ${evt.title}${dateLabel}`,
      });
    });

  return options;
}

// ============================================
// Date Range Inputs (From / To)
// ============================================

function tsToISODate(ts) {
  if (ts == null || !isFinite(ts)) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildDateRangeInputs({ onChange }) {
  const fromInput = el('input', {
    class: 'form-input filter-bar__date',
    type: 'date',
    'aria-label': 'From close date',
    onChange: () => emit(),
  });
  const toInput = el('input', {
    class: 'form-input filter-bar__date',
    type: 'date',
    'aria-label': 'To close date',
    onChange: () => emit(),
  });

  function emit() {
    const fromStr = fromInput.value;
    const toStr = toInput.value;
    const fromTs = fromStr ? new Date(fromStr + 'T00:00:00').getTime() : null;
    const toTs = toStr ? new Date(toStr + 'T23:59:59').getTime() : null;
    onChange(fromTs, toTs);
  }

  const clearLink = el('a', {
    href: '#',
    class: 'filter-bar__date-clear',
    onClick: (e) => {
      e.preventDefault();
      fromInput.value = '';
      toInput.value = '';
      emit();
    },
  }, 'Clear dates');

  return el('div', { class: 'filter-bar__date-group' },
    el('span', { class: 'filter-bar__date-label' }, 'From'),
    fromInput,
    el('span', { class: 'filter-bar__date-label' }, 'To'),
    toInput,
    clearLink,
  );
}

// ============================================
// Multi-select Stage Filter
// ============================================

function buildStageMultiSelect({ allStages, selected, onChange }) {
  const button = el('button', {
    type: 'button',
    class: 'multi-select__button form-select',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
  });

  const panel = el('div', { class: 'multi-select__panel', role: 'listbox' });

  const allCheckbox = el('input', { type: 'checkbox', class: 'multi-select__checkbox' });
  const allOption = el('label', { class: 'multi-select__option multi-select__option--all' },
    allCheckbox,
    el('span', {}, 'All'),
  );
  panel.appendChild(allOption);

  const stageCheckboxes = new Map();
  allStages.forEach(stage => {
    const cb = el('input', { type: 'checkbox', class: 'multi-select__checkbox', value: stage });
    cb.checked = selected.has(stage);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(stage); else selected.delete(stage);
      syncAllCheckbox();
      updateLabel();
      onChange();
    });
    stageCheckboxes.set(stage, cb);
    panel.appendChild(el('label', { class: 'multi-select__option' }, cb, el('span', {}, stage)));
  });

  allCheckbox.addEventListener('change', () => {
    if (allCheckbox.checked) {
      allStages.forEach(s => selected.add(s));
    } else {
      selected.clear();
    }
    stageCheckboxes.forEach((cb, stage) => { cb.checked = selected.has(stage); });
    updateLabel();
    onChange();
  });

  function syncAllCheckbox() {
    allCheckbox.checked = selected.size === allStages.length;
    allCheckbox.indeterminate = selected.size > 0 && selected.size < allStages.length;
  }

  function updateLabel() {
    if (selected.size === allStages.length || allStages.length === 0) {
      button.textContent = 'All Stages';
    } else {
      button.textContent = `Stages: ${selected.size} selected`;
    }
  }

  const wrapper = el('div', { class: 'multi-select filter-bar__select' }, button, panel);

  function setOpen(open) {
    wrapper.classList.toggle('multi-select--open', open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!wrapper.classList.contains('multi-select--open'));
  });

  panel.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) setOpen(false);
  });

  syncAllCheckbox();
  updateLabel();
  return wrapper;
}

// ============================================
// Main View
// ============================================

function renderView(container, opportunities, filterBar) {
  let activeView = 'list';

  // Collect unique stages present in the data, ordered by OPP_STAGES then alphabetic for unknowns
  const stageSet = new Set(opportunities.map(o => o.stage).filter(Boolean));
  const allStages = [
    ...OPP_STAGES.filter(s => stageSet.has(s)),
    ...[...stageSet].filter(s => !OPP_STAGES.includes(s)).sort(),
  ];
  const selectedStages = new Set(allStages);

  let filters = {
    search: '',
    partner: '',
    status: '',
    statusExclude: null,
    dateFrom: null,
    dateTo: null,
    stages: selectedStages,
  };

  function getFiltered() {
    return opportunities.filter(opp => {
      if (filters.partner && opp.partner_id !== filters.partner) return false;
      if (filters.status && opp.status !== filters.status) return false;
      if (filters.statusExclude && filters.statusExclude.includes(opp.status)) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!(opp.deal_name?.toLowerCase().includes(q) ||
              opp.customer_name?.toLowerCase().includes(q) ||
              getPartnerName(opp.partner_id)?.toLowerCase().includes(q))) return false;
      }
      if (filters.dateFrom != null || filters.dateTo != null) {
        if (!opp.expected_close) return false;
        const closeTime = new Date(opp.expected_close).getTime();
        if (filters.dateFrom != null && closeTime < filters.dateFrom) return false;
        if (filters.dateTo != null && closeTime > filters.dateTo) return false;
      }
      if (allStages.length > 0 && filters.stages.size < allStages.length) {
        if (!filters.stages.has(opp.stage)) return false;
      }
      return true;
    });
  }

  // Stats
  const totalValue = opportunities.reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);
  const wonDeals = opportunities.filter(o => o.status === 'Won');
  const wonValue = wonDeals.reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);
  const activeDeals = opportunities.filter(o => o.status !== 'Won' && o.status !== 'Lost');

  // Stat card filter toggle
  let activeStatKey = '';
  function toggleStatFilter(key) {
    if (activeStatKey === key) {
      activeStatKey = '';
      filters.status = '';
      filters.statusExclude = null;
    } else {
      activeStatKey = key;
      if (key === 'won') { filters.status = 'Won'; filters.statusExclude = null; }
      else if (key === 'active') { filters.status = ''; filters.statusExclude = ['Won', 'Lost']; }
      else { filters.status = ''; filters.statusExclude = null; }
    }
    statusSelect.value = filters.status;
    updateStatCardStates();
    refreshContent();
  }

  function updateStatCardStates() {
    const cards = document.querySelectorAll('.stats-grid .stat-card');
    const keyMap = ['', 'active', 'won', 'active'];
    cards.forEach((card, i) => {
      card.classList.toggle('stat-card--active', keyMap[i] === activeStatKey && activeStatKey !== '');
    });
  }

  // Filter controls
  const searchInput = el('input', {
    class: 'search-bar__input',
    type: 'text',
    placeholder: 'Search opportunities...',
    onInput: debounce((e) => { filters.search = e.target.value; refreshContent(); }, 200),
  });

  const partnerSelect = el('select', {
    class: 'form-select filter-bar__select',
    onChange: (e) => { filters.partner = e.target.value; refreshContent(); },
  },
    el('option', { value: '' }, 'All Partners'),
    ...(cachedPartners || []).map(p => el('option', { value: p.partner_id }, p.display_name))
  );

  const statusSelect = el('select', {
    class: 'form-select filter-bar__select',
    onChange: (e) => { filters.status = e.target.value; filters.statusExclude = null; activeStatKey = ''; updateStatCardStates(); refreshContent(); },
  },
    el('option', { value: '' }, 'All Statuses'),
    ...OPP_STATUSES.map(s => el('option', { value: s }, s))
  );

  const stageMultiSelect = buildStageMultiSelect({
    allStages,
    selected: selectedStages,
    onChange: () => refreshContent(),
  });

  // View toggle
  const boardBtn = el('button', { class: 'btn btn--secondary btn--sm', onClick: () => switchView('board') }, 'Board');
  const listBtn = el('button', { class: 'btn btn--primary btn--sm', onClick: () => switchView('list') }, 'List');

  // Date range inputs (From / To)
  const dateInputs = buildDateRangeInputs({
    onChange: (fromTs, toTs) => {
      filters.dateFrom = fromTs;
      filters.dateTo = toTs;
      refreshContent();
    },
  });

  const viewContainer = el('div', { id: 'opps-view-container' });

  const content = el('div', {},
    filterBar,
    el('div', { class: 'section-header' },
      el('div', {},
        el('h2', { class: 'section-header__title' }, 'Opportunities'),
        el('p', { class: 'section-header__subtitle' }, `${opportunities.length} total · ${formatCurrency(totalValue)} pipeline`)
      ),
      el('button', {
        class: 'btn btn--primary',
        onClick: () => openOppModal(null, container),
      },
        el('span', { html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' }),
        'New Opportunity'
      ),
    ),

    // Stats (interactive — click to filter)
    el('div', { class: 'stats-grid stagger' },
      statCard('Total Deals', opportunities.length, {
        accentColor: 'var(--color-primary-lighter)',
        onClick: () => toggleStatFilter(''),
      }),
      statCard('Active Pipeline', formatCurrency(totalValue - wonValue), {
        accentColor: 'var(--color-status-in-progress)',
        onClick: () => toggleStatFilter('active'),
      }),
      statCard('Won Revenue', formatCurrency(wonValue), {
        accentColor: 'var(--color-status-won)',
        onClick: () => toggleStatFilter('won'),
      }),
      statCard('Active Deals', activeDeals.length, {
        accentColor: 'var(--color-status-registered)',
        onClick: () => toggleStatFilter('active'),
      })
    ),

    // Filter + view toggle
    el('div', { class: 'filter-section' },
      el('div', { class: 'filter-bar filter-bar--wrap' },
        el('div', { class: 'filter-bar__search' },
          searchInput
        ),
        partnerSelect,
        stageMultiSelect,
        statusSelect,
        dateInputs,
        el('div', { class: 'view-toggle', style: { marginBottom: '0' } }, boardBtn, listBtn),
      ),
    ),

    viewContainer,
  );

  mount(container, content);

  function switchView(view) {
    activeView = view;
    boardBtn.className = view === 'board' ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
    listBtn.className = view === 'list' ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
    refreshContent();
  }

  function refreshContent() {
    const filtered = getFiltered();
    viewContainer.innerHTML = '';
    if (activeView === 'board') {
      viewContainer.appendChild(renderBoard(filtered));
    } else {
      viewContainer.appendChild(renderList(filtered));
    }
  }

  refreshContent();
}

// ============================================
// Board View (Kanban by Stage)
// ============================================

function renderBoard(opportunities) {
  const board = el('div', { class: 'kanban' });

  OPP_STAGES.forEach(stage => {
    const stageOpps = opportunities.filter(o => (o.stage || 'Prospect') === stage);
    const stageValue = stageOpps.reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);

    const cardsContainer = el('div', { class: 'kanban__cards' });

    stageOpps
      .sort((a, b) => (parseFloat(b.deal_value) || 0) - (parseFloat(a.deal_value) || 0))
      .forEach(opp => {
        const card = createOppCard(opp);
        cardsContainer.appendChild(card);
      });

    const column = el('div', { class: 'kanban__column' },
      el('div', { class: 'kanban__column-header' },
        el('div', {},
          el('span', { class: 'kanban__column-title' }, stage),
          el('div', { class: 'kanban__column-total' }, formatCurrency(stageValue)),
        ),
        el('span', { class: 'kanban__column-count' }, String(stageOpps.length))
      ),
      cardsContainer
    );

    // Drop zone
    column.addEventListener('dragover', (e) => {
      e.preventDefault();
      column.classList.add('kanban__column--dragover');
    });

    column.addEventListener('dragleave', () => {
      column.classList.remove('kanban__column--dragover');
    });

    column.addEventListener('drop', async (e) => {
      e.preventDefault();
      column.classList.remove('kanban__column--dragover');
      const oppId = e.dataTransfer.getData('text/plain');
      if (!oppId) return;

      const opp = cachedOpps.find(o => o.opportunity_id === oppId);
      if (!opp || opp.stage === stage) return;

      try {
        const values = [
          opp.opportunity_id, opp.partner_id, opp.deal_name, opp.customer_name,
          opp.deal_value, opp.status, stage, opp.expected_close,
          opp.description, opp.created_at, nowISO(),
          opp.notes || '', opp.lead_source || 'salesperson',
        ];

        if (isConfigured()) {
          await updateRow(CONFIG.SHEET_OPPORTUNITIES, opp._rowIndex, values);
        } else {
          updateDemoRow(CONFIG.SHEET_OPPORTUNITIES, opp._rowIndex, values);
        }

        showToast(`Moved "${opp.deal_name}" to ${stage}`, 'success');
        reRender();
      } catch (err) {
        showToast(err.message || 'Failed to update opportunity', 'error');
      }
    });

    board.appendChild(column);
  });

  return board;
}

function createOppCard(opp) {
  const actions = el('div', { class: 'kanban__card-actions' },
    el('button', {
      class: 'kanban__card-action-btn',
      title: 'Edit',
      onClick: (e) => { e.stopPropagation(); openOppModal(opp, document.getElementById('view-container')); },
      html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10.5 1.5l2 2-8 8H2.5v-2l8-8z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    }),
    el('button', {
      class: 'kanban__card-action-btn kanban__card-action-btn--danger',
      title: 'Delete',
      onClick: (e) => { e.stopPropagation(); handleDelete(opp); },
      html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5h4V4M5.5 6v4M8.5 6v4M3 4l.5 8h7l.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    }),
  );

  const card = el('div', {
    class: 'kanban__card',
    draggable: 'true',
  },
    actions,
    el('div', { class: 'kanban__card-title' }, opp.deal_name),
    el('div', { class: 'kanban__card-subtitle' }, opp.customer_name),
    el('div', { class: 'kanban__card-meta' },
      el('span', { class: `badge badge--${getStatusBadge(opp.status)}` }, opp.status),
      el('span', { class: 'badge badge--admin' }, getPartnerName(opp.partner_id)),
    ),
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-2)' } },
      el('div', { class: 'kanban__card-value' }, formatCurrency(parseFloat(opp.deal_value) || 0)),
      opp.expected_close
        ? el('div', { style: { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' } }, formatDate(opp.expected_close))
        : null
    ),
    getLeadSourceLabel(opp.lead_source)
  );

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', opp.opportunity_id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.kanban__column--dragover').forEach(col => col.classList.remove('kanban__column--dragover'));
  });

  card.addEventListener('click', () => {
    openOppDetailsModal(opp);
  });

  return card;
}

// ============================================
// List View (Table)
// ============================================

function renderList(opportunities) {
  const sorted = [...opportunities].sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

  if (sorted.length === 0) {
    return el('div', { class: 'empty-state', style: { marginTop: 'var(--space-8)' } },
      el('div', { class: 'empty-state__title' }, 'No matching opportunities'),
      el('div', { class: 'empty-state__description' }, 'Try adjusting your filters or create a new opportunity.')
    );
  }

  return el('div', { class: 'table-wrapper' },
    el('table', { class: 'table' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'Deal'),
          el('th', {}, 'Partner'),
          el('th', {}, 'Value'),
          el('th', {}, 'Stage'),
          el('th', {}, 'Status'),
          el('th', {}, 'Close Date'),
          el('th', {}, 'Actions')
        )
      ),
      el('tbody', {},
        ...sorted.map(opp =>
          el('tr', {
            class: 'table__row--clickable',
            onClick: () => openOppDetailsModal(opp),
          },
            el('td', {},
              el('a', {
                href: '#',
                class: 'deal-name-link',
                onClick: (e) => { e.preventDefault(); openOppDetailsModal(opp); },
              }, opp.deal_name),
              el('div', { style: { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' } }, opp.customer_name)
            ),
            el('td', {}, el('span', { class: 'badge badge--admin' }, getPartnerName(opp.partner_id))),
            el('td', { style: { fontWeight: 'var(--font-semibold)' } }, formatCurrency(parseFloat(opp.deal_value) || 0)),
            el('td', {}, el('span', { class: 'badge badge--silver' }, opp.stage)),
            el('td', {}, el('span', { class: `badge badge--${getStatusBadge(opp.status)}` }, opp.status)),
            el('td', {}, opp.expected_close ? formatDate(opp.expected_close) : '—'),
            el('td', {},
              el('div', { class: 'table__actions' },
                el('button', { class: 'btn btn--ghost btn--sm', onClick: (e) => { e.stopPropagation(); openOppModal(opp, document.getElementById('view-container')); } }, 'Edit'),
                el('button', { class: 'btn btn--ghost btn--sm', style: { color: 'var(--color-danger)' }, onClick: (e) => { e.stopPropagation(); handleDelete(opp); } }, 'Delete')
              )
            )
          )
        )
      )
    )
  );
}

// ============================================
// Helpers
// ============================================

function getStatusBadge(status) {
  const map = { 'Registered': 'registered', 'In Progress': 'in-progress', 'Won': 'won', 'Lost': 'lost' };
  return map[status] || 'silver';
}

function getLeadSourceLabel(leadSource) {
  if (!leadSource || leadSource === 'salesperson') return null;
  const evt = (cachedEvents || []).find(e => e.event_id === leadSource);
  if (!evt) return null;
  return el('div', { class: 'kanban__card-lead-source', title: `Lead Source: ${evt.title}` },
    el('svg', { width: '10', height: '10', viewBox: '0 0 10 10', html: '<path d="M5 1v8M1 5l4 4 4-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' }),
    el('span', {}, evt.title)
  );
}

// ============================================
// Opportunity Details Modal (read-only)
// ============================================

function getLeadSourceDisplay(opp) {
  if (!opp.lead_source || opp.lead_source === 'salesperson') return 'Salesperson Created';
  const evt = (cachedEvents || []).find(e => e.event_id === opp.lead_source);
  if (!evt) return opp.lead_source;
  const typeLabel = evt.event_type ? `[${evt.event_type}] ` : '';
  const dateLabel = evt.event_date ? ` - ${formatDate(evt.event_date)}` : '';
  return `${typeLabel}${evt.title}${dateLabel}`;
}

function detailRow(label, value) {
  return el('div', { class: 'details-modal__row' },
    el('div', { class: 'details-modal__label' }, label),
    el('div', { class: 'details-modal__value' }, value == null || value === '' ? '—' : value),
  );
}

// ---------- Details modal v2: badges, hero, inline edit ----------

function slugifyToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function statusBadge(value) {
  const label = value || 'Unknown';
  const mod = slugifyToken(label) || 'unknown';
  return el('span', { class: `status-pill status-pill--${mod}` },
    el('span', { class: 'status-pill__dot' }),
    label,
  );
}

function stageBadge(value) {
  const label = value || 'Unknown';
  const mod = slugifyToken(label) || 'unknown';
  return el('span', { class: `stage-pill stage-pill--${mod}` }, label);
}

// Persist the full opportunity row back to Sheets with the current in-memory
// values. Used by inline edits; mirrors the column order from the edit modal.
async function saveOppRow(opp) {
  const values = [
    opp.opportunity_id,
    opp.partner_id || '',
    opp.deal_name || '',
    opp.customer_name || '',
    opp.deal_value ?? '',
    opp.status || 'Registered',
    opp.stage || '',
    opp.expected_close || '',
    opp.description || '',
    opp.created_at || nowISO(),
    nowISO(),
    // `notes` — the stringified JSON array Randy appends to (see ai.js). This
    // slot was hardcoded '', so every inline field edit wiped the deal's entire
    // note history even when it wrote to the right row. Carry the value through
    // like every other column this function does not edit.
    opp.notes || '',
    opp.lead_source || 'salesperson',
  ];
  opp.updated_at = values[10];
  if (isConfigured()) {
    await updateRow(CONFIG.SHEET_OPPORTUNITIES, opp._rowIndex, values);
  } else {
    updateDemoRow(CONFIG.SHEET_OPPORTUNITIES, opp._rowIndex, values);
  }
}

// Build an inline-editable field card.
//
// spec: { key, label, type, getValue, setValue, renderValue, getOptions?, validate? }
//   - type: 'text' | 'number' | 'date' | 'select'
//   - getValue(): current raw value on opp
//   - setValue(v): mutate opp, return normalized value or throw for invalid
//   - renderValue(v): returns a Node (badge, formatted text, etc.)
//   - getOptions(): for 'select', returns [{value, label}]
function editableField(opp, spec, onChange) {
  const valueHolder = el('div', { class: 'field-card__value' });
  const pencil = el('span', {
    class: 'field-card__pencil',
    html: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.5 2.5a1.41 1.41 0 0 1 2 2L5 13l-3 .75L2.75 11l8.75-8.5Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  });
  const card = el('div', {
    class: 'field-card',
    tabindex: '0',
    role: 'button',
    'aria-label': `Edit ${spec.label}`,
  },
    el('div', { class: 'field-card__label' },
      el('span', {}, spec.label),
      pencil,
    ),
    valueHolder,
  );

  const renderDisplay = () => {
    const raw = spec.getValue();
    valueHolder.replaceChildren();
    const rendered = spec.renderValue ? spec.renderValue(raw) : null;
    if (rendered instanceof Node) {
      valueHolder.appendChild(rendered);
    } else {
      valueHolder.appendChild(document.createTextNode(
        rendered != null && rendered !== '' ? String(rendered) : '—',
      ));
    }
    card.classList.remove('field-card--editing');
  };

  let editing = false;
  const enterEdit = () => {
    if (editing) return;
    editing = true;
    card.classList.add('field-card--editing');

    const current = spec.getValue();
    let input;
    if (spec.type === 'select') {
      input = document.createElement('select');
      input.className = 'field-card__input field-card__input--select';
      const options = spec.getOptions ? spec.getOptions() : [];
      options.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      });
      input.value = current == null ? '' : String(current);
    } else {
      input = document.createElement('input');
      input.className = 'field-card__input';
      input.type = spec.type === 'number' ? 'number'
        : spec.type === 'date' ? 'date'
        : 'text';
      if (spec.type === 'number') { input.min = '0'; input.step = '0.01'; }
      input.value = current == null ? '' : String(current);
    }

    valueHolder.replaceChildren(input);
    input.focus();
    if (typeof input.select === 'function' && spec.type !== 'date' && spec.type !== 'select') {
      input.select();
    }

    let settled = false;
    const commit = async () => {
      if (settled) return;
      settled = true;
      const next = input.value;
      const prev = spec.getValue();
      if (String(next) === String(prev == null ? '' : prev)) {
        editing = false;
        renderDisplay();
        return;
      }
      try {
        spec.setValue(next);
      } catch (err) {
        showToast(err.message || 'Invalid value', 'error');
        editing = false;
        renderDisplay();
        return;
      }
      try {
        await saveOppRow(opp);
        showToast('Updated', 'success');
        editing = false;
        renderDisplay();
        if (onChange) onChange(spec.key);
      } catch (err) {
        // Revert on failure
        spec.setValue(prev == null ? '' : prev);
        showToast(err.message || 'Save failed', 'error');
        editing = false;
        renderDisplay();
      }
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      editing = false;
      renderDisplay();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); input.blur(); }
    });
    if (spec.type === 'select') {
      // Commit immediately on change for selects — no need to blur.
      input.addEventListener('change', () => input.blur());
    }
  };

  card.addEventListener('click', enterEdit);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterEdit(); }
  });

  renderDisplay();
  return { element: card, refresh: renderDisplay };
}

function buildOppDetailsHero(opp, refs) {
  // refs is a map of { stage, status, deal_value } field handles so inline
  // edits to those values live-update the hero and the grid at the same time.
  const valueEl = el('div', { class: 'details-hero__value' },
    formatCurrency(parseFloat(opp.deal_value) || 0),
  );
  const valueWrap = el('div', { class: 'details-hero__value-wrap' },
    el('span', { class: 'details-hero__value-eyebrow' }, 'Deal Value'),
    valueEl,
  );
  const stageHolder = el('span', { class: 'details-hero__badge-slot' }, stageBadge(opp.stage));
  const statusHolder = el('span', { class: 'details-hero__badge-slot' }, statusBadge(opp.status));

  const customerMeta = el('span', { class: 'details-hero__meta-item' },
    el('span', { class: 'details-hero__meta-label' }, 'Customer'),
    el('span', { class: 'details-hero__meta-value' }, opp.customer_name || '—'),
  );
  const partnerMeta = el('span', { class: 'details-hero__meta-item' },
    el('span', { class: 'details-hero__meta-label' }, 'Partner'),
    el('span', { class: 'details-hero__meta-value' }, getPartnerName(opp.partner_id) || '—'),
  );
  const closeMeta = el('span', { class: 'details-hero__meta-item' },
    el('span', { class: 'details-hero__meta-label' }, 'Expected Close'),
    el('span', { class: 'details-hero__meta-value' },
      opp.expected_close ? formatDate(opp.expected_close) : '—'),
  );

  const hero = el('div', { class: 'details-hero' },
    el('span', { class: 'details-hero__plus details-hero__plus--a', 'aria-hidden': 'true' }, '+'),
    el('span', { class: 'details-hero__plus details-hero__plus--b', 'aria-hidden': 'true' }, '+'),
    el('span', { class: 'details-hero__plus details-hero__plus--c', 'aria-hidden': 'true' }, '+'),
    el('span', { class: 'details-hero__plus details-hero__plus--d', 'aria-hidden': 'true' }, '+'),
    el('div', { class: 'details-hero__top' },
      el('div', { class: 'details-hero__badges' }, stageHolder, statusHolder),
      valueWrap,
    ),
    el('div', { class: 'details-hero__meta' }, customerMeta, partnerMeta, closeMeta),
  );

  return {
    element: hero,
    refresh: () => {
      valueEl.textContent = formatCurrency(parseFloat(opp.deal_value) || 0);
      stageHolder.replaceChildren(stageBadge(opp.stage));
      statusHolder.replaceChildren(statusBadge(opp.status));
      customerMeta.lastChild.textContent = opp.customer_name || '—';
      partnerMeta.lastChild.textContent = getPartnerName(opp.partner_id) || '—';
      closeMeta.lastChild.textContent = opp.expected_close ? formatDate(opp.expected_close) : '—';
    },
  };
}

function makeCategoryPill(category) {
  if (category === 'meeting_recap') {
    return el('span', { class: 'category-pill category-pill--meeting-recap' },
      el('span', { class: 'category-pill__dot' }),
      el('span', { class: 'category-pill__label' }, 'Meeting Recap'),
    );
  }
  if (category === 'opportunity_note') {
    return el('span', { class: 'category-pill category-pill--opportunity-note' },
      el('span', { class: 'category-pill__dot' }),
      el('span', { class: 'category-pill__label' }, 'Opportunity Note'),
    );
  }
  return null;
}

function buildDetailsDescriptionsSection(descriptions, options = {}) {
  const { selectionMode = false, selected = null, onToggle = null, opportunityId = null, opp = null, onDescriptionDeleted = null } = options;
  const list = el('div', { class: 'details-modal__descriptions' });

  if (!descriptions || descriptions.length === 0) {
    list.appendChild(el('div', { class: 'details-modal__empty' }, 'No descriptions yet.'));
    return list;
  }

  descriptions.forEach((desc, idx) => {
    const isOpenRef = { value: false };
    const dateStr = desc.description_date ? formatDate(desc.description_date) : '—';
    const plainText = stripHtml(desc.description_text || '');
    const preview = plainText
      ? plainText.slice(0, 120) + (plainText.length > 120 ? '...' : '')
      : 'Empty';

    const toggleIcon = el('span', {
      class: 'transcript-card__toggle',
      html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    });

    // Mutable ref so the standardize handler can update the displayed text.
    const bodyTextEl = el('div', { class: 'transcript-card__text', html: ensureHtml(desc.description_text || '') });
    const body = el('div', { class: 'transcript-card__body' }, bodyTextEl);
    body.style.display = 'none';

    const header = el('div', {
      class: 'transcript-card__header',
      onClick: () => {
        isOpenRef.value = !isOpenRef.value;
        body.style.display = isOpenRef.value ? '' : 'none';
        toggleIcon.classList.toggle('transcript-card__toggle--open', isOpenRef.value);
        body.classList.toggle('transcript-card__body--open', isOpenRef.value);
      },
    },
      el('span', { class: 'transcript-card__date' }, dateStr),
      el('span', { class: 'transcript-card__preview' }, preview),
      toggleIcon,
    );

    const card = el('div', { class: 'transcript-card' }, header, body);

    if (selectionMode) {
      const checkbox = el('input', {
        type: 'checkbox',
        class: 'description-select__checkbox',
        checked: selected && selected.has(idx),
        onChange: (e) => { if (onToggle) onToggle(idx, e.target.checked); },
        onClick: (e) => e.stopPropagation(),
      });
      const row = el('div', { class: 'description-select__row' }, checkbox, card);
      if (desc.category) {
        const pill = makeCategoryPill(desc.category);
        if (pill) row.appendChild(pill);
      }
      list.appendChild(row);
    } else {
      // Standardize button — shown only in non-selection mode.
      const realId = desc.description_id && !desc._tempId ? desc.description_id : null;
      const isAlreadyDone = !!desc.category;

      const categoryPillSlot = el('span', { class: 'description-card__pill-slot' });
      if (desc.category) {
        const catPillEl = makeCategoryPill(desc.category);
        if (catPillEl) categoryPillSlot.appendChild(catPillEl);
      }

      const makeCheckmark = () => el('span', {
        class: 'standardize-check',
        title: 'Standardized',
        'aria-label': 'Standardized',
      }, '✓');

      const actionsEl = el('div', { class: 'description-card__actions' }, categoryPillSlot);

      if (isAlreadyDone) {
        actionsEl.appendChild(makeCheckmark());
      } else {
        // If a background job is already running for this description (user navigated away
        // and came back), render the button in a disabled "in-progress" state so they know.
        const runningJob = realId ? standardizeJobs.get(realId) : null;
        const isJobRunning = runningJob?.status === 'running';

        const sparkleSvg = '<svg class="standardize-btn__sparkle" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5l1.4 4.1L13.5 7l-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4L8 1.5z" fill="currentColor"/></svg>';
        const standardizeIdleHtml = `${sparkleSvg}<span class="standardize-btn__label">Standardize</span>`;
        const standardizeRunningHtml = '<span class="standardize-btn__label">Standardizing…</span>';
        const standardizeBtn = el('button', {
          class: 'btn btn--xs btn--secondary standardize-btn',
          type: 'button',
          disabled: !realId || isJobRunning,
          title: !realId
            ? 'Not yet saved — open the Edit modal to save first'
            : isJobRunning
              ? 'Standardization in progress — check the progress ticker'
              : 'Reformat with AI while preserving all content',
          html: isJobRunning ? standardizeRunningHtml : standardizeIdleHtml,
        });

        if (realId && !isJobRunning) {
          standardizeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            standardizeBtn.disabled = true;
            standardizeBtn.innerHTML = standardizeRunningHtml;

            // Body-fixed progress pill — stays visible even after the modal is closed.
            const descLabel = desc.description_date
              ? `Standardizing — ${formatDate(desc.description_date)}`
              : 'Standardizing description…';
            const progressPill = createPill('Calling Claude…', { label: descLabel, global: true });

            standardizeJobs.set(realId, { pill: progressPill, desc, status: 'running' });

            // Fire-and-forget: the async work continues even if the user closes the modal.
            (async () => {
              try {
                const rawText = stripHtml(desc.description_text || '').trim();

                let lastReported = 0;
                const result = await standardizeDescription(rawText, null, (chars) => {
                  if (chars - lastReported >= 150) {
                    lastReported = chars;
                    updatePillStage(progressPill, `Receiving… (${chars} chars)`);
                  }
                });

                updatePillStage(progressPill, 'Saving…');
                await applyStandardizedDescription(opportunityId, realId, result.category, result.standardizedText);

                // Update in-memory desc — persists across modal close/reopen.
                desc.description_text = result.standardizedText;
                desc.category = result.category;

                standardizeJobs.set(realId, { pill: progressPill, desc, status: 'done', result });
                markPillSuccess(progressPill, 'Standardized!');

                // Update the DOM in place if the card is still mounted.
                try {
                  bodyTextEl.innerHTML = ensureHtml(result.standardizedText);
                  const newCatPill = makeCategoryPill(result.category);
                  categoryPillSlot.replaceChildren();
                  if (newCatPill) categoryPillSlot.appendChild(newCatPill);
                  standardizeBtn.replaceWith(makeCheckmark());
                } catch { /* card may have been unmounted; in-memory update above is enough */ }

              } catch (err) {
                console.error('[Standardize] failed', err);
                standardizeJobs.set(realId, { pill: progressPill, desc, status: 'failed', error: err });
                markPillFailure(progressPill, err.message || 'Standardize failed');

                // Re-enable button if still mounted.
                try {
                  standardizeBtn.disabled = false;
                  standardizeBtn.innerHTML = standardizeIdleHtml;
                } catch { /* card may be gone */ }
                showToast(err.message || 'Standardize failed', 'error');
              } finally {
                // Remove the job entry after a grace period so a re-render shows a clean button.
                setTimeout(() => standardizeJobs.delete(realId), 30_000);
              }
            })();
          });
        }

        actionsEl.appendChild(standardizeBtn);
      }

      // Inline Edit/Delete — only for sheet-backed descriptions with a row index.
      // Hidden in selection mode (not rendered at all).
      if (!selectionMode && desc._rowIndex) {
        const editBtn = el('button', {
          class: 'row-action-btn',
          type: 'button',
          title: 'Edit description',
          html: pencilIconSvg(),
          onClick: (e) => {
            e.stopPropagation();
            openDescriptionEditorDialog(desc, opp || {}, {
              onSaved: () => {
                const dateEl = header.querySelector('.transcript-card__date');
                if (dateEl) dateEl.textContent = desc.description_date ? formatDate(desc.description_date) : '—';
                const previewEl = header.querySelector('.transcript-card__preview');
                if (previewEl) {
                  const plain = stripHtml(desc.description_text || '');
                  previewEl.textContent = plain ? plain.slice(0, 120) + (plain.length > 120 ? '...' : '') : 'Empty';
                }
                bodyTextEl.innerHTML = ensureHtml(desc.description_text || '');
              },
            });
          },
        });

        const deleteBtn = el('button', {
          class: 'row-action-btn row-action-btn--danger',
          type: 'button',
          title: 'Delete description',
          html: trashIconSvg(),
          onClick: async (e) => {
            e.stopPropagation();
            const confirmed = await confirmDialog(
              'Delete Description',
              'Are you sure you want to remove this description? This cannot be undone.',
            );
            if (!confirmed) return;
            try {
              if (isConfigured()) {
                await deleteRow(CONFIG.SHEET_OPP_DESCRIPTIONS, desc._rowIndex);
              } else {
                deleteDemoRow(CONFIG.SHEET_OPP_DESCRIPTIONS, desc._rowIndex);
              }
              cardRow.remove();
              if (onDescriptionDeleted) onDescriptionDeleted(idx);
              showToast('Description removed', 'success');
            } catch (err) {
              showToast(err.message || 'Failed to remove description', 'error');
            }
          },
        });

        const inlineActions = el('div', { class: 'description-card__inline-actions' }, editBtn, deleteBtn);
        actionsEl.appendChild(inlineActions);
      }

      const cardRow = el('div', { class: 'description-card__row' },
        card,
        actionsEl,
      );
      list.appendChild(cardRow);
    }
  });

  return list;
}

function buildDescriptionsSelectionToolbar({ count, intent, onConfirm, onSelectAll, onCancel }) {
  const ctaLabel = intent === 'generate'
    ? `Generate from Selected (${count})`
    : 'Copy Selected';
  const ctaClass = intent === 'generate'
    ? 'btn btn--primary btn--sm description-select__cta description-select__cta--generate'
    : 'btn btn--primary btn--sm';
  return el('div', { class: 'description-select__toolbar' },
    el('span', { class: 'description-select__count' }, `${count} selected`),
    el('div', { class: 'description-select__actions' },
      el('button', {
        class: ctaClass,
        type: 'button',
        disabled: count === 0,
        onClick: onConfirm,
      }, ctaLabel),
      el('button', {
        class: 'description-select__link',
        type: 'button',
        onClick: onSelectAll,
      }, 'Select All'),
      el('button', {
        class: 'description-select__link',
        type: 'button',
        onClick: onCancel,
      }, 'Cancel'),
    ),
  );
}

function formatDescriptionsForCopy(entries) {
  return entries.map(d => {
    const date = d.description_date ? formatDate(d.description_date) : '—';
    const body = stripHtml(d.description_text || '').trim();
    return `--- ${date} ---\n${body}`;
  }).join('\n\n');
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // fall through to legacy path
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch (e) {
    return false;
  }
}

function setupDescriptionsSelection({ descriptions, copyBtn, generateBtn, toolbarSlot, listSlot, onGenerate, opportunityId = null }) {
  if (!descriptions || descriptions.length === 0) {
    copyBtn.hidden = true;
    if (generateBtn) generateBtn.hidden = true;
    return;
  }
  copyBtn.hidden = false;
  if (generateBtn) generateBtn.hidden = false;

  // intent: null → inactive, 'copy' → Copy Selected, 'generate' → Generate from Selected
  const state = { intent: null, selected: new Set() };

  const render = () => {
    const active = !!state.intent;
    copyBtn.hidden = active;
    if (generateBtn) generateBtn.hidden = active;
    if (active) {
      toolbarSlot.replaceChildren(buildDescriptionsSelectionToolbar({
        count: state.selected.size,
        intent: state.intent,
        onConfirm: state.intent === 'generate' ? handleGenerate : handleCopy,
        onSelectAll: () => {
          for (let i = 0; i < descriptions.length; i++) state.selected.add(i);
          render();
        },
        onCancel: () => {
          state.intent = null;
          state.selected.clear();
          render();
        },
      }));
    } else {
      toolbarSlot.replaceChildren();
    }
    listSlot.replaceChildren(buildDetailsDescriptionsSection(descriptions, {
      selectionMode: active,
      selected: state.selected,
      onToggle: (idx, checked) => {
        if (checked) state.selected.add(idx);
        else state.selected.delete(idx);
        render();
      },
      opportunityId,
    }));
  };

  const handleCopy = async () => {
    if (state.selected.size === 0) return;
    const entries = [...state.selected].sort((a, b) => a - b).map(i => descriptions[i]);
    const text = formatDescriptionsForCopy(entries);
    const ok = await copyTextToClipboard(text);
    if (ok) {
      const n = entries.length;
      showToast(`${n} description${n === 1 ? '' : 's'} copied to clipboard`, 'success');
      state.intent = null;
      state.selected.clear();
      render();
    } else {
      showToast('Unable to copy to clipboard', 'error');
    }
  };

  const handleGenerate = () => {
    if (state.selected.size === 0) return;
    const entries = [...state.selected].sort((a, b) => a - b).map(i => descriptions[i]);
    // Hand selection off to the caller's orchestrator, then drop out
    // of selection mode immediately — generation runs in the background
    // behind the modal pill so the modal stays interactive.
    state.intent = null;
    state.selected.clear();
    render();
    if (typeof onGenerate === 'function') onGenerate(entries);
  };

  copyBtn.addEventListener('click', () => {
    // If the user was mid-Generate selection, preserve their checked
    // boxes but switch the CTA back to Copy — least-surprise behaviour.
    state.intent = 'copy';
    render();
  });

  if (generateBtn) {
    generateBtn.addEventListener('click', () => {
      state.intent = 'generate';
      render();
    });
  }
}

function fileExtensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function fileKindLabel(ext) {
  const map = {
    pdf: 'PDF', doc: 'DOC', docx: 'DOC',
    xls: 'XLS', xlsx: 'XLS', csv: 'CSV',
    ppt: 'PPT', pptx: 'PPT',
    png: 'IMG', jpg: 'IMG', jpeg: 'IMG', gif: 'IMG', webp: 'IMG',
    txt: 'TXT', md: 'MD',
  };
  return map[ext] || (ext ? ext.toUpperCase().slice(0, 4) : 'FILE');
}

function buildDetailsDocumentsSection(files) {
  const list = el('div', { class: 'documents-list' });

  if (!files || files.length === 0) {
    list.appendChild(el('div', { class: 'details-modal__empty' }, 'No documents yet.'));
    return list;
  }

  // Sort by date_added descending so the most recent document is at the top.
  files.sort((a, b) => {
    const at = Date.parse(a.date_added || '') || 0;
    const bt = Date.parse(b.date_added || '') || 0;
    return bt - at;
  });

  files.forEach(file => {
    const ext = fileExtensionOf(file.file_name);
    const kind = fileKindLabel(ext);
    const badge = el('span', {
      class: `document-row__badge document-row__badge--${kind.toLowerCase()}`,
    }, kind);
    const row = el('div', { class: 'document-row' },
      badge,
      el('a', {
        href: file.drive_url || '#',
        target: '_blank',
        rel: 'noopener',
        class: 'document-row__name',
      }, file.file_name || 'Untitled'),
      el('span', { class: 'document-row__date' }, file.date_added ? formatDate(file.date_added) : ''),
      el('button', {
        class: 'row-action-btn row-action-btn--danger',
        type: 'button',
        title: 'Remove document',
        html: trashIconSvg(),
        onClick: async (e) => {
          e.stopPropagation();
          const confirmed = await confirmDialog(
            'Remove Document',
            `Are you sure you want to remove "${file.file_name || 'this file'}"? This cannot be undone.`,
          );
          if (!confirmed) return;
          try {
            await fileApiRequest({ action: 'deleteFile', docId: file.doc_id });
            const idx = files.findIndex(f => f.doc_id === file.doc_id);
            if (idx >= 0) files.splice(idx, 1);
            row.remove();
            showToast('File removed', 'success');
          } catch (err) {
            showToast(err.message || 'Failed to remove file', 'error');
          }
        },
      }),
    );
    list.appendChild(row);
  });

  return list;
}

// ============================================
// MAP PDF from selection — click flow glue
// ============================================
// Orchestrates pill + card + Documents refresh for the click-driven
// MAP PDF feature launched from the Descriptions toolbar in the
// Opportunity Details modal. The voice path in randy.js is unchanged;
// this is a parallel thin wrapper over generateMapPdfFromSelection().

function runOppMapPdfFromSelection({ opp, entries, cardSlot, onFileSaved }) {
  if (!entries || entries.length === 0) return;
  const count = entries.length;
  const opportunity = {
    id: opp.opportunity_id,
    opportunityId: opp.opportunity_id,
    customerName: opp.customer_name || '',
    dealName: opp.deal_name || '',
    name: opp.customer_name || opp.deal_name || '',
    stage: opp.stage || '',
    dealValue: opp.deal_value || '',
    expectedClose: opp.expected_close || '',
  };

  // Pill lives in the global body-fixed stack — persists regardless of whether
  // the opportunity modal stays open. Label shows the customer name so the user
  // knows which generation is which when multiple are running concurrently.
  const pill = createPill(
    count > 1 ? `Synthesizing ${count} descriptions…` : 'Reading description…',
    { label: opp.customer_name || opp.deal_name || '' },
  );

  const onStage = (stage) => {
    if (stage === 'synthesizing') updatePillStage(pill, `Synthesizing ${count} descriptions…`);
    else if (stage === 'reading')  updatePillStage(pill, 'Reading description…');
    else if (stage === 'building') updatePillStage(pill, 'Building PDF…');
    else if (stage === 'saving')   updatePillStage(pill, 'Saving to Drive…');
  };

  const normalizedEntries = entries.map(d => ({
    date: d?.description_date || d?.date || d?.created_at || '',
    content: stripHtml(d?.description_text || d?.content || '').trim(),
  }));

  generateMapPdfFromSelection(opportunity, normalizedEntries, { onStage })
    .then((result) => {
      markPillSuccess(pill, 'Saved!');
      if (activeModalOppId === opp.opportunity_id) {
        // Modal for this opportunity is still open — inject file and show success card.
        if (typeof onFileSaved === 'function') onFileSaved(result.file);
        if (cardSlot) {
          renderOppMapPdfSuccessCard(cardSlot, {
            opportunity,
            driveUrl: result.driveUrl,
            filename: result.filename,
            onTryAgainReset: () => cardSlot.replaceChildren(),
          });
        }
      } else {
        // Modal was closed or the user is elsewhere — auto-open the opportunity
        // so they can see the new PDF in the Documents section.
        scheduleAutoOpen(opp);
      }
    })
    .catch((err) => {
      console.error('[MAP PDF from selection] failure', err);
      markPillFailure(pill, 'Failed — see card');
      if (activeModalOppId === opp.opportunity_id) {
        // Modal is still open — show the error card with retry inside it.
        if (cardSlot) {
          renderOppMapPdfErrorCard(cardSlot, {
            opportunity,
            error: err,
            onRetry: () => {
              // Retry re-runs the entire pipeline with the SAME selection;
              // user doesn't need to re-check boxes.
              if (cardSlot) cardSlot.replaceChildren();
              runOppMapPdfFromSelection({ opp, entries, cardSlot, onFileSaved });
            },
          });
        }
      } else {
        // Modal is closed — make the (settled) error pill clickable so the
        // user can navigate back to the opportunity to see the error.
        if (pill.el) {
          pill.el.style.cursor = 'pointer';
          pill.el.title = `Click to open ${opp.customer_name || opp.deal_name || 'opportunity'}`;
          pill.el.addEventListener('click', () => openOppDetailsModal(opp), { once: true });
        }
      }
    });
}

// Open opp's details modal immediately if no modal is currently open,
// or queue the open until the current modal closes.
function scheduleAutoOpen(opp) {
  if (typeof document === 'undefined') return;
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot || !modalRoot.children.length) {
    openOppDetailsModal(opp);
    return;
  }
  // A modal is open — wait for it to close, then open this opportunity's modal.
  const obs = new MutationObserver(() => {
    if (!modalRoot.children.length) {
      obs.disconnect();
      openOppDetailsModal(opp);
    }
  });
  obs.observe(modalRoot, { childList: true });
}

function buildOppMapSuccessCard({ customerName, filename, driveUrl, onViewInDocuments, onDismiss }) {
  const header = el('div', { class: 'opp-map-card__title-row' },
    el('span', {
      class: 'opp-map-card__title-icon',
      html: '<svg viewBox="0 0 20 20" fill="none"><path d="M4 10l4 4 8-8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    }),
    el('div', { class: 'opp-map-card__header' }, 'MAP PDF Saved'),
    el('button', {
      class: 'opp-map-card__dismiss',
      type: 'button',
      'aria-label': 'Dismiss',
      onClick: onDismiss,
      html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    }),
  );

  let primaryBtn;
  if (driveUrl) {
    primaryBtn = el('a', {
      class: 'opp-map-card__btn',
      href: driveUrl,
      target: '_blank',
      rel: 'noopener',
    }, 'View in Drive');
  } else {
    primaryBtn = el('button', {
      class: 'opp-map-card__btn opp-map-card__btn--in-portal',
      type: 'button',
      onClick: onViewInDocuments,
    }, 'View in Documents');
  }

  return el('div', { class: 'opp-map-card opp-map-card--success' },
    header,
    el('div', { class: 'opp-map-card__subline' }, customerName || ''),
    el('div', { class: 'opp-map-card__filename' }, filename || ''),
    primaryBtn,
  );
}

function renderOppMapPdfSuccessCard(slot, { opportunity, driveUrl, filename, onTryAgainReset }) {
  let dismissTimer = null;
  const dismiss = () => {
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
    slot.replaceChildren();
  };
  const viewInDocuments = () => {
    // No Drive URL — scroll/highlight the freshly-added file below.
    const host = slot.closest('.details-modal') || slot.parentElement;
    const firstDocRow = host ? host.querySelector('.document-row') : null;
    if (firstDocRow) {
      firstDocRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      firstDocRow.classList.add('document-row--just-added');
      setTimeout(() => firstDocRow.classList.remove('document-row--just-added'), 1500);
    }
  };
  const card = buildOppMapSuccessCard({
    customerName: opportunity.customerName || opportunity.name || '',
    filename,
    driveUrl,
    onViewInDocuments: viewInDocuments,
    onDismiss: dismiss,
  });
  slot.replaceChildren(card);
  // 30-second auto-dismiss, per spec. Dismissing manually also clears
  // the timer so we never call replaceChildren on a stale slot.
  dismissTimer = setTimeout(dismiss, 30_000);
  if (typeof onTryAgainReset === 'function') onTryAgainReset();
}

function renderOppMapPdfErrorCard(slot, { opportunity, error, onRetry }) {
  const msg = (error && error.message) || String(error || 'Unknown error');
  let userSummary;
  if (error?.code === 'MAP_JSON_API_ERROR' && error?.status === 401) {
    userSummary = 'The Anthropic API key is invalid or expired. Check it on the Setup page.';
  } else if (error?.code === 'MAP_JSON_INVALID' || error?.code === 'MAP_JSON_SCHEMA' || error?.code === 'MAP_JSON_EMPTY') {
    userSummary = "Claude's response didn't parse as the expected JSON. Try again, or simplify the source descriptions.";
  } else if (error?.code === 'MAP_SELECTION_EMPTY' || error?.code === 'MAP_SELECTION_INVALID_OPPORTUNITY') {
    userSummary = msg;
  } else if (error?.name === 'TimeoutError' || /timeout|timed out/i.test(msg)) {
    userSummary = 'The request took longer than 2 minutes. Usually transient — try again.';
  } else if (/Failed to fetch|network|NetworkError/i.test(msg)) {
    userSummary = 'Network request to Anthropic or Google Drive failed. Check your connection.';
  } else if (/upload|drive/i.test(msg)) {
    userSummary = 'The PDF was built but Google Drive rejected the upload. Documents list wasn\'t updated.';
  } else {
    userSummary = 'Something went wrong while generating the MAP PDF.';
  }

  const dismiss = () => slot.replaceChildren();

  const header = el('div', { class: 'opp-map-card__title-row' },
    el('span', {
      class: 'opp-map-card__title-icon',
      html: '<svg viewBox="0 0 20 20" fill="none"><path d="M10 3l8 14H2z" fill="currentColor" opacity="0.2"/><path d="M10 3l8 14H2z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.5" r="1" fill="currentColor"/></svg>',
    }),
    el('div', { class: 'opp-map-card__header' },
      `Couldn't generate MAP PDF${opportunity?.customerName ? ' — ' + opportunity.customerName : ''}`),
    el('button', {
      class: 'opp-map-card__dismiss',
      type: 'button',
      'aria-label': 'Dismiss',
      onClick: dismiss,
      html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    }),
  );

  const details = el('details', { class: 'opp-map-card__details' });
  details.appendChild(el('summary', {}, 'Show technical details'));
  details.appendChild(el('pre', {}, msg));

  const retryBtn = el('button', {
    class: 'opp-map-card__retry',
    type: 'button',
    onClick: onRetry,
  }, 'Try again');

  slot.replaceChildren(
    el('div', { class: 'opp-map-card opp-map-card--warning' },
      header,
      el('div', { class: 'opp-map-card__subline' }, userSummary),
      details,
      retryBtn,
    ),
  );
}

export async function openOppDetailsModal(opp, opts = {}) {
  // focusDescription — used by Randy's "open that note" voice flow to
  // auto-expand and highlight one description card once the async
  // descriptions load lands. Matched by description_id first (exact),
  // then by date, then by index as a last resort.
  const { focusDescription = null } = opts;
  // Partners/events are needed to render the in-memory fields (partner name,
  // lead source label) and are typically already cached by the list view.
  // Always refresh events so the lead source label resolves correctly even
  // for events created since this view was last rendered.
  const [partnersResult, eventsResult] = await Promise.all([
    cachedPartners ? Promise.resolve(null) : readSheetAsObjects(CONFIG.SHEET_PARTNERS),
    readSheetAsObjects(CONFIG.SHEET_EVENTS),
  ]);
  if (partnersResult) cachedPartners = partnersResult.filter(p => String(p.is_admin).toUpperCase() !== 'TRUE');
  cachedEvents = eventsResult;

  const editBtn = el('button', {
    class: 'details-modal__edit-btn',
    title: 'Open full editor (E)',
    onClick: () => {
      closeModal();
      // Wait for close animation before opening edit modal
      setTimeout(() => openOppModal(opp, document.getElementById('view-container')), 260);
    },
  }, 'Edit all');

  const expandIconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const collapseIconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 6.5h-4v-4M13.5 2.5 9 7M2.5 9.5h4v4M2.5 13.5 7 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const fullscreenBtn = el('button', {
    class: 'details-modal__fullscreen-btn',
    title: 'Toggle full screen (F)',
    'aria-label': 'Toggle full screen',
    html: expandIconSvg,
  });

  // Inline-editable field specs ----------------------------------------
  const fieldHandles = {};
  let listDirty = false;
  const refreshDependentViews = (key) => {
    listDirty = true;
    if (heroHandle) heroHandle.refresh();
    // Keep every field card in sync (partner change affects lead source label, etc.)
    // Don't re-render the field that just committed — its own code handles it.
    Object.entries(fieldHandles).forEach(([specKey, h]) => {
      if (h && specKey !== key) h.refresh();
    });
    // Update the modal title when the deal name changes.
    if (key === 'deal_name' && modalResult) {
      const titleEl = modalResult.element.querySelector('.modal__title');
      if (titleEl) titleEl.textContent = opp.deal_name || 'Opportunity Details';
    }
  };

  const partnerOptions = () => (cachedPartners || []).map(p => ({
    value: p.partner_id,
    label: p.display_name,
  }));

  const stageOptions = () => OPP_STAGES.map(s => ({ value: s, label: s }));
  const statusOptions = () => OPP_STATUSES.map(s => ({ value: s, label: s }));
  const leadSourceOptionsFor = () => computeLeadSourceOptions(opp.partner_id);

  const fieldSpecs = [
    {
      key: 'deal_name', label: 'Deal Name', type: 'text',
      getValue: () => opp.deal_name,
      setValue: (v) => { const s = String(v).trim(); if (!s) throw new Error('Deal Name is required'); opp.deal_name = s; },
      renderValue: (v) => v || '—',
    },
    {
      key: 'customer_name', label: 'Customer Name', type: 'text',
      getValue: () => opp.customer_name,
      setValue: (v) => { const s = String(v).trim(); if (!s) throw new Error('Customer Name is required'); opp.customer_name = s; },
      renderValue: (v) => v || '—',
    },
    {
      key: 'partner_id', label: 'Partner', type: 'select',
      getValue: () => opp.partner_id,
      setValue: (v) => { if (!v) throw new Error('Partner is required'); opp.partner_id = v;
        // Reset lead_source if it no longer applies to the new partner.
        const stillValid = computeLeadSourceOptions(v).some(o => o.value === opp.lead_source);
        if (!stillValid) opp.lead_source = 'salesperson';
      },
      getOptions: partnerOptions,
      renderValue: () => getPartnerName(opp.partner_id) || '—',
    },
    {
      key: 'deal_value', label: 'Deal Value', type: 'number',
      getValue: () => opp.deal_value,
      setValue: (v) => { const n = parseFloat(v); if (!isFinite(n) || n < 0) throw new Error('Deal Value must be a positive number'); opp.deal_value = n; },
      renderValue: (v) => formatCurrency(parseFloat(v) || 0),
    },
    {
      key: 'expected_close', label: 'Expected Close', type: 'date',
      getValue: () => opp.expected_close,
      setValue: (v) => { if (!v) throw new Error('Expected Close is required'); opp.expected_close = v; },
      renderValue: (v) => v ? formatDate(v) : '—',
    },
    {
      key: 'stage', label: 'Stage', type: 'select',
      getValue: () => opp.stage,
      setValue: (v) => { opp.stage = v; },
      getOptions: stageOptions,
      renderValue: (v) => stageBadge(v),
    },
    {
      key: 'status', label: 'Status', type: 'select',
      getValue: () => opp.status,
      setValue: (v) => { opp.status = v; },
      getOptions: statusOptions,
      renderValue: (v) => statusBadge(v),
    },
    {
      key: 'lead_source', label: 'Lead Source', type: 'select',
      getValue: () => opp.lead_source || 'salesperson',
      setValue: (v) => { opp.lead_source = v || 'salesperson'; },
      getOptions: leadSourceOptionsFor,
      renderValue: () => getLeadSourceDisplay(opp),
    },
  ];

  let heroHandle; // forward ref so specs can refresh it
  heroHandle = buildOppDetailsHero(opp);

  const gridChildren = fieldSpecs.map(spec => {
    const handle = editableField(opp, spec, (changedKey) => refreshDependentViews(changedKey));
    fieldHandles[spec.key] = handle;
    return handle.element;
  });
  const grid = el('div', { class: 'details-modal__grid' }, ...gridChildren);

  const descriptionsSlot = el('div', { class: 'details-modal__descriptions-slot' },
    buildDetailsLoadingPlaceholder(),
  );
  const descriptionsToolbarSlot = el('div', { class: 'details-modal__descriptions-toolbar-slot' });
  const descriptionsCopyBtn = el('button', {
    class: 'btn btn--secondary btn--sm details-modal__copy-btn',
    type: 'button',
    hidden: true,
  }, 'Copy');
  const descriptionsGenerateBtn = el('button', {
    class: 'btn btn--sm details-modal__generate-map-btn',
    type: 'button',
    hidden: true,
  }, 'Generate MAP');
  // Slot that sits above the Documents list so the success/failure
  // card from the click flow lands right where the user expects new
  // documents to appear.
  const mapPdfCardSlot = el('div', { class: 'details-modal__map-card-slot' });
  const documentsSlot = el('div', { class: 'details-modal__documents-slot' },
    buildDetailsLoadingPlaceholder(),
  );

  const content = el('div', { class: 'details-modal' },
    heroHandle.element,
    el('div', { class: 'details-modal__section details-modal__section--fields' },
      el('div', { class: 'details-modal__section-header' },
        el('h3', { class: 'details-modal__section-title' }, 'Details'),
        el('span', { class: 'details-modal__section-hint' }, 'Click any field to edit'),
      ),
      grid,
    ),
    el('div', { class: 'details-modal__section' },
      el('div', { class: 'details-modal__section-header' },
        el('h3', { class: 'details-modal__section-title' }, 'Descriptions'),
        el('div', { class: 'details-modal__section-actions' },
          descriptionsGenerateBtn,
          descriptionsCopyBtn,
        ),
      ),
      descriptionsToolbarSlot,
      descriptionsSlot,
    ),
    el('div', { class: 'details-modal__section details-modal__section--documents' },
      el('h3', { class: 'details-modal__section-title' }, 'Documents'),
      mapPdfCardSlot,
      documentsSlot,
    ),
  );

  activeModalOppId = opp.opportunity_id;

  const modalResult = openModal({
    title: opp.deal_name || 'Opportunity Details',
    content,
    className: 'modal--wide modal--details',
    footer: el('button', { class: 'details-modal__close-btn', onClick: closeModal }, 'Close'),
    onClose: () => { activeModalOppId = null; if (listDirty) reRender(); },
  });

  // Inject the edit button + fullscreen toggle into the modal header,
  // before the close X.
  const headerEl = modalResult.element.querySelector('.modal__header');
  const closeX = headerEl.querySelector('.modal__close');
  headerEl.insertBefore(editBtn, closeX);
  headerEl.insertBefore(fullscreenBtn, closeX);

  // Wrap the title with a stacked eyebrow ("DEAL · ID #...") + title group
  // so the title bar follows the Recast brand pattern. The title element
  // itself stays in place — refreshDependentViews still queries .modal__title
  // and updates its textContent when the deal name changes inline.
  const titleEl = headerEl.querySelector('.modal__title');
  if (titleEl && !headerEl.querySelector('.details-modal__title-wrap')) {
    const titleWrap = el('div', { class: 'details-modal__title-wrap' });
    const eyebrowText = `DEAL${opp.opportunity_id ? ` · ID #${opp.opportunity_id}` : ''}`;
    const eyebrow = el('span', { class: 'details-modal__eyebrow' }, eyebrowText);
    headerEl.insertBefore(titleWrap, titleEl);
    titleWrap.appendChild(eyebrow);
    titleWrap.appendChild(titleEl);
  }

  // Fullscreen toggle ------------------------------------------------
  const modalBox = modalResult.element.querySelector('.modal');
  let isFullscreen = false;
  const setFullscreen = (next) => {
    isFullscreen = next;
    modalBox.classList.toggle('modal--fullscreen', next);
    fullscreenBtn.innerHTML = next ? collapseIconSvg : expandIconSvg;
    fullscreenBtn.title = next ? 'Exit full screen (F)' : 'Toggle full screen (F)';
  };
  fullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setFullscreen(!isFullscreen);
  });
  const shortcutHandler = (e) => {
    // Ignore when typing into an input/textarea/contentEditable
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.tagName === 'SELECT');
    if (typing) return;
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setFullscreen(!isFullscreen); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); editBtn.click(); }
  };
  document.addEventListener('keydown', shortcutHandler);
  // Detach when the modal backdrop is removed from the DOM.
  const detachObserver = new MutationObserver(() => {
    if (!document.body.contains(modalResult.element)) {
      document.removeEventListener('keydown', shortcutHandler);
      detachObserver.disconnect();
    }
  });
  detachObserver.observe(document.getElementById('modal-root'), { childList: true });

  // Mutable cache of the documents list — lets the success card inject
  // the newly uploaded file without refetching from Apps Script. The
  // read-only details modal doesn't use buildDocumentsPanel(), so this
  // closure plays the same role as activeDocsPanel.addFile().
  let currentFiles = [];
  const injectNewDocument = (file) => {
    if (!file) return;
    currentFiles = [file, ...currentFiles];
    documentsSlot.replaceChildren(buildDetailsDocumentsSection(currentFiles));
    const firstRow = documentsSlot.querySelector('.document-row');
    if (firstRow) {
      firstRow.classList.add('document-row--just-added');
      setTimeout(() => {
        try { firstRow.classList.remove('document-row--just-added'); } catch { /* modal closed */ }
      }, 1500);
    }
  };

  const handleGenerateFromSelection = (entries) => {
    runOppMapPdfFromSelection({
      opp,
      entries,
      cardSlot: mapPdfCardSlot,
      onFileSaved: injectNewDocument,
    });
  };

  // Stream descriptions and documents in parallel after the modal is visible.
  // replaceChildren on a detached node (modal already closed) is a no-op.
  Promise.allSettled([
    readSheetAsObjects(CONFIG.SHEET_OPP_DESCRIPTIONS),
    listEntityDocuments(opp.opportunity_id),
  ]).then(([descResult, docsResult]) => {
    let descriptions = [];
    if (descResult.status === 'fulfilled') {
      descriptions = descResult.value
        .filter(d => d.opportunity_id === opp.opportunity_id)
        .sort((a, b) => new Date(b.description_date || b.created_at) - new Date(a.description_date || a.created_at));
    }
    // Legacy: fall back to the opp row description if no separate records exist.
    if (descriptions.length === 0 && opp.description) {
      descriptions = [{
        description_date: toISODateOnly(opp.updated_at || opp.created_at) || todayISO(),
        description_text: opp.description,
      }];
    }
    descriptionsSlot.replaceChildren(buildDetailsDescriptionsSection(descriptions, {
      opportunityId: opp.opportunity_id,
      opp,
      onDescriptionDeleted: (idx) => { descriptions.splice(idx, 1); },
    }));
    setupDescriptionsSelection({
      descriptions,
      copyBtn: descriptionsCopyBtn,
      generateBtn: descriptionsGenerateBtn,
      toolbarSlot: descriptionsToolbarSlot,
      listSlot: descriptionsSlot,
      onGenerate: handleGenerateFromSelection,
      opportunityId: opp.opportunity_id,
    });

    currentFiles = docsResult.status === 'fulfilled' ? [...docsResult.value] : [];
    documentsSlot.replaceChildren(buildDetailsDocumentsSection(currentFiles));

    if (focusDescription && descriptions.length > 0) {
      focusDescriptionCard(descriptionsSlot, descriptions, focusDescription);
    }
  });
}

// Expand + scroll + highlight one description card in the details modal.
// The cards in the slot are rendered in the same order as `descriptions`,
// so index-into-the-DOM is safe once the target index is resolved.
function focusDescriptionCard(slotEl, descriptions, focus) {
  let idx = -1;
  if (focus.id) {
    idx = descriptions.findIndex(d => String(d.description_id || '') === String(focus.id));
  }
  if (idx < 0 && focus.date) {
    idx = descriptions.findIndex(d => String(d.description_date || '') === String(focus.date));
  }
  if (idx < 0 && Number.isInteger(focus.index) && focus.index >= 0 && focus.index < descriptions.length) {
    idx = focus.index;
  }
  if (idx < 0) return;

  const card = slotEl.querySelectorAll('.transcript-card')[idx];
  if (!card) return;
  // Expand through the card's own click handler so toggle state stays
  // consistent with manual clicks.
  const header = card.querySelector('.transcript-card__header');
  if (header) header.click();
  card.classList.add('transcript-card--randy-focus');
  setTimeout(() => {
    try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* detached */ }
  }, 80);
  setTimeout(() => {
    try { card.classList.remove('transcript-card--randy-focus'); } catch { /* detached */ }
  }, 3200);
}

function buildDetailsLoadingPlaceholder() {
  return el('div', { class: 'details-modal__loading' },
    el('div', { class: 'spinner details-modal__loading-spinner' }),
    el('span', { class: 'details-modal__loading-text' }, 'Loading...'),
  );
}

// ============================================
// Opportunity Modal (Create/Edit)
// ============================================

export async function openOppModal(opp, container, onSaved) {
  const isEdit = !!opp;

  // Always refresh the events list so the lead_source dropdown reflects
  // any events that have been added since this view was last loaded.
  // Partners are loaded only when missing — they don't change as often
  // and re-rendering the page would refresh them anyway.
  const [partnersResult, eventsResult] = await Promise.all([
    cachedPartners ? Promise.resolve(null) : readSheetAsObjects(CONFIG.SHEET_PARTNERS),
    readSheetAsObjects(CONFIG.SHEET_EVENTS),
  ]);
  if (partnersResult) cachedPartners = partnersResult.filter(p => String(p.is_admin).toUpperCase() !== 'TRUE');
  cachedEvents = eventsResult;

  // Load existing descriptions for this opportunity. Documents are loaded
  // in the background after the modal opens (see docsHandle.refresh()
  // below) so the Apps Script round-trip doesn't block the modal.
  let workingDescriptions = [];
  if (isEdit) {
    try {
      const all = await readSheetAsObjects(CONFIG.SHEET_OPP_DESCRIPTIONS);
      workingDescriptions = all
        .filter(d => d.opportunity_id === opp.opportunity_id)
        .map(d => ({ ...d }))
        .sort((a, b) => new Date(b.description_date || b.created_at) - new Date(a.description_date || a.created_at));
    } catch (err) {
      console.warn('Failed to load opportunity descriptions', err);
    }

    // Legacy migration: if no separate description records exist but the
    // opportunity row still has a description, surface it as a pending
    // first-version card. Saving the modal will persist it to the new sheet.
    if (workingDescriptions.length === 0 && opp.description) {
      workingDescriptions.push({
        _tempId: `tmp_${uuid('dsc')}`,
        _isNew: true,
        opportunity_id: opp.opportunity_id,
        deal_name: opp.deal_name,
        description_date: toISODateOnly(opp.updated_at || opp.created_at) || todayISO(),
        description_text: opp.description,
        created_at: opp.created_at || nowISO(),
      });
    }
  }

  const partnerOptions = (cachedPartners || []).map(p => ({
    value: p.partner_id,
    label: p.display_name,
  }));

  const getLeadSourceOptions = computeLeadSourceOptions;

  // Initial lead source options
  const initialPartnerId = isEdit ? opp.partner_id : '';
  const leadSourceOptions = getLeadSourceOptions(initialPartnerId);

  const fields = [
    { name: 'deal_name', label: 'Deal Name', required: true, placeholder: 'e.g., Enterprise Cloud Migration' },
    { name: 'customer_name', label: 'Customer Name', required: true, placeholder: 'e.g., Acme Corp' },
    {
      name: 'partner_id', label: 'Partner', type: 'select', required: true,
      placeholder: 'Select partner...',
      options: partnerOptions,
    },
    { type: 'row-start' },
    { name: 'deal_value', label: 'Deal Value ($)', type: 'number', required: true, placeholder: '0', min: 0 },
    { name: 'expected_close', label: 'Expected Close', type: 'date', required: true },
    { type: 'row-end' },
    { type: 'row-start' },
    {
      name: 'stage', label: 'Stage', type: 'select', required: true,
      placeholder: 'Select stage...',
      options: OPP_STAGES,
    },
    {
      name: 'status', label: 'Status', type: 'select',
      default: 'Registered',
      options: OPP_STATUSES,
    },
    { type: 'row-end' },
    {
      name: 'lead_source', label: 'Lead Source', type: 'select',
      options: leadSourceOptions,
    },
  ];

  const initialValues = isEdit ? {
    deal_name: opp.deal_name,
    customer_name: opp.customer_name,
    partner_id: opp.partner_id,
    deal_value: opp.deal_value,
    expected_close: opp.expected_close,
    stage: opp.stage,
    status: opp.status,
    lead_source: opp.lead_source || 'salesperson',
  } : { lead_source: 'salesperson' };

  // Guard against rapid double-clicks dispatching two submit events
  // before the first appendRow / updateRow resolves.
  let saving = false;
  const form = buildForm(fields, async (data) => {
    if (saving) return;
    saving = true;
    try {
      const leadSource = data.lead_source || 'salesperson';

      // Compute the "latest" description text to store on the opp row
      // (keeps opp.description as a convenient denormalized reference).
      const latestDescText = pickLatestDescriptionText(workingDescriptions);

      let opportunityId;
      let createdAt;

      if (isEdit) {
        opportunityId = opp.opportunity_id;
        createdAt = opp.created_at;

        const values = [
          opportunityId, data.partner_id, data.deal_name, data.customer_name,
          data.deal_value, data.status || 'Registered', data.stage,
          data.expected_close, latestDescText, createdAt, nowISO(),
          // `notes` — carried through, not blanked. This form does not edit it,
          // and hardcoding '' here destroyed Randy's note history on every save.
          opp.notes || '', leadSource,
        ];

        if (isConfigured()) {
          await updateRow(CONFIG.SHEET_OPPORTUNITIES, opp._rowIndex, values);
        } else {
          updateDemoRow(CONFIG.SHEET_OPPORTUNITIES, opp._rowIndex, values);
        }
      } else {
        opportunityId = uuid('opp');
        createdAt = nowISO();

        const values = [
          opportunityId, data.partner_id, data.deal_name, data.customer_name,
          data.deal_value, data.status || 'Registered', data.stage,
          data.expected_close, latestDescText, createdAt, createdAt,
          '', leadSource,
        ];

        if (isConfigured()) {
          await appendRow(CONFIG.SHEET_OPPORTUNITIES, values);
        } else {
          addDemoRow(CONFIG.SHEET_OPPORTUNITIES, values);
        }
      }

      // Persist description changes to SHEET_OPP_DESCRIPTIONS.
      // Process deletes before inserts so row indices stay valid when
      // deleting the highest-index rows first.
      const toDelete = workingDescriptions
        .filter(d => d._deleted && d.description_id && d._rowIndex)
        .sort((a, b) => b._rowIndex - a._rowIndex);
      for (const d of toDelete) {
        if (isConfigured()) {
          await deleteRow(CONFIG.SHEET_OPP_DESCRIPTIONS, d._rowIndex);
        } else {
          deleteDemoRow(CONFIG.SHEET_OPP_DESCRIPTIONS, d._rowIndex);
        }
      }

      // Skip updates that would blank out an existing row. This matches
      // the card-local Save validation so modal-level Save can't bypass it
      // when the user clears the editor and hits Save Changes directly.
      const toUpdate = workingDescriptions.filter(d =>
        !d._deleted && !d._isNew && d._modified && !isDescriptionEmpty(d)
      );
      for (const d of toUpdate) {
        const values = [
          d.description_id, opportunityId, data.deal_name,
          d.description_date, d.description_text, d.created_at,
        ];
        if (isConfigured()) {
          await updateRow(CONFIG.SHEET_OPP_DESCRIPTIONS, d._rowIndex, values);
        } else {
          updateDemoRow(CONFIG.SHEET_OPP_DESCRIPTIONS, d._rowIndex, values);
        }
      }

      // Skip brand-new cards where the user never actually typed anything.
      const toInsert = workingDescriptions.filter(d =>
        !d._deleted && d._isNew && !isDescriptionEmpty(d)
      );
      for (const d of toInsert) {
        const descriptionId = uuid('dsc');
        const values = [
          descriptionId, opportunityId, data.deal_name,
          d.description_date, d.description_text, d.created_at || nowISO(),
        ];
        if (isConfigured()) {
          await appendRow(CONFIG.SHEET_OPP_DESCRIPTIONS, values);
        } else {
          addDemoRow(CONFIG.SHEET_OPP_DESCRIPTIONS, values);
        }
      }

      showToast(isEdit ? 'Opportunity updated!' : 'Opportunity created!', 'success');
      closeModal();
      if (onSaved) { onSaved(); } else { reRender(); }
    } catch (err) {
      showToast(err.message || 'Failed to save opportunity', 'error');
    } finally {
      saving = false;
    }
  }, initialValues);

  // When partner changes, rebuild lead source options
  const partnerSelect = form.querySelector('[name="partner_id"]');
  const leadSourceSelect = form.querySelector('[name="lead_source"]');
  if (partnerSelect && leadSourceSelect) {
    partnerSelect.addEventListener('change', () => {
      const newPartnerId = partnerSelect.value;
      const currentLeadSource = leadSourceSelect.value;
      const newOptions = getLeadSourceOptions(newPartnerId);

      // Rebuild lead source dropdown
      leadSourceSelect.innerHTML = '';
      newOptions.forEach(opt => {
        const optionEl = document.createElement('option');
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        leadSourceSelect.appendChild(optionEl);
      });

      // Try to preserve current selection, fallback to salesperson
      const stillValid = newOptions.some(o => o.value === currentLeadSource);
      leadSourceSelect.value = stillValid ? currentLeadSource : 'salesperson';
    });
  }

  // If editing, show the linked event name even if it's not in the current dropdown
  if (isEdit && opp.lead_source && opp.lead_source !== 'salesperson' && leadSourceSelect) {
    const existsInOptions = leadSourceOptions.some(o => o.value === opp.lead_source);
    if (!existsInOptions) {
      const linkedEvent = (cachedEvents || []).find(e => e.event_id === opp.lead_source);
      if (linkedEvent) {
        const optionEl = document.createElement('option');
        optionEl.value = linkedEvent.event_id;
        optionEl.textContent = `[${linkedEvent.event_type}] ${linkedEvent.title} - ${formatDate(linkedEvent.event_date)}`;
        leadSourceSelect.appendChild(optionEl);
        leadSourceSelect.value = linkedEvent.event_id;
      }
    }
  }

  // Descriptions panel (replaces the old single-description textarea)
  const { panel: descriptionsPanel, refresh: refreshDescriptions } = buildDescriptionsPanel(workingDescriptions, {
    placeholder: 'Write the description for this opportunity...',
    entityLabel: 'opportunity',
  });

  // Documents panel — drag-and-drop uploads to Google Drive via the file API.
  // For new (unsaved) opportunities there's no opportunity_id to attach to yet,
  // so the upload zone is hidden with a helper note. For existing opps we
  // open the modal in a loading state and fetch the list in the background
  // (see docsHandle.refresh() after openModal) so the Apps Script round-trip
  // doesn't block the modal.
  const opportunityIdForDocs = isEdit ? opp.opportunity_id : null;
  const docsHandle = buildDocumentsPanel({
    entityId: opportunityIdForDocs,
    getContextName: () => {
      const input = form.querySelector('[name="customer_name"]');
      return (input && input.value) || (isEdit ? (opp.customer_name || '') : '');
    },
    initialFiles: [],
    loading: isEdit,
    savePrompt: 'Save this opportunity first to attach documents',
    onAnalyze: async (file) => {
      const data = await fileApiRequest({
        action: 'analyzeDocument',
        docId: file.doc_id,
        driveUrl: file.drive_url,
      });
      const fileName = data.fileName || file.file_name || 'Document';
      const dateISO = todayISO();
      const dateLabel = formatDate(dateISO);
      const descriptionHtml =
        `<h4>📄 ${escapeHtml(fileName)} — Analyzed ${escapeHtml(dateLabel)}</h4>` +
        ensureHtml(data.html || '');
      const dealNameInput = form.querySelector('[name="deal_name"]');
      const dealName = (dealNameInput && dealNameInput.value) || (isEdit ? (opp.deal_name || '') : '');
      const descriptionId = uuid('dsc');
      const createdAt = nowISO();
      const values = [descriptionId, opportunityIdForDocs, dealName, dateISO, descriptionHtml, createdAt];
      if (isConfigured()) {
        await appendRow(CONFIG.SHEET_OPP_DESCRIPTIONS, values);
      } else {
        addDemoRow(CONFIG.SHEET_OPP_DESCRIPTIONS, values);
      }
      workingDescriptions.push({
        description_id: descriptionId,
        opportunity_id: opportunityIdForDocs,
        deal_name: dealName,
        description_date: dateISO,
        description_text: descriptionHtml,
        created_at: createdAt,
      });
      file.analyzed = 'TRUE';
      refreshDescriptions();
      showToast('Document analyzed and added to descriptions', 'success');
    },
  });

  // Register the panel handle so external flows (Randy's MAP PDF) can
  // inject new files into the open modal. Only registered for edit
  // sessions, since new opportunities have no ID to attach to yet.
  if (isEdit) activeDocsPanel = docsHandle;

  const modalContent = el('div', {}, form, descriptionsPanel, docsHandle.panel);

  openModal({
    title: isEdit ? 'Edit Opportunity' : 'New Opportunity',
    content: modalContent,
    className: 'modal--wide',
    onClose: () => {
      if (activeDocsPanel === docsHandle) activeDocsPanel = null;
    },
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Cancel'),
      el('button', {
        class: 'btn btn--primary',
        onClick: () => form.dispatchEvent(new Event('submit', { cancelable: true })),
      }, isEdit ? 'Save Changes' : 'Create Opportunity'),
    ],
  });

  // Kick off the documents fetch only after the modal is on screen so the
  // user sees the form immediately, then the document list fills in.
  // refresh() handles its own errors.
  if (isEdit) docsHandle.refresh();
}

// ============================================
// Description Editor Dialog (opportunity details modal)
// ============================================

/**
 * Opens a focused editor dialog for a single existing description in the
 * details modal. Persists immediately on save (no deferred modal submit).
 * Uses the shared date+Quill form from descriptions-panel.js.
 */
function openDescriptionEditorDialog(desc, opp, { onSaved } = {}) {
  const snapshot = {
    description_date: desc.description_date,
    description_text: desc.description_text,
  };
  let settled = false;
  let didSave = false;

  function dismiss() {
    if (settled) return;
    settled = true;
    if (!didSave) {
      desc.description_date = snapshot.description_date;
      desc.description_text = snapshot.description_text;
    }
    backdrop.classList.remove('modal-backdrop--visible');
    document.removeEventListener('keydown', escHandler, { capture: true });
    setTimeout(() => backdrop.remove(), 250);
  }

  const closeSvg = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  const form = buildDescriptionEditorForm(desc, {
    key: getDescriptionKey(desc) || `dlg-${Date.now()}`,
    onSave: async () => {
      const values = [
        desc.description_id,
        desc.opportunity_id || opp.opportunity_id,
        desc.deal_name || opp.deal_name,
        desc.description_date,
        desc.description_text,
        desc.created_at,
      ];
      if (isConfigured()) {
        await updateRow(CONFIG.SHEET_OPP_DESCRIPTIONS, desc._rowIndex, values);
      } else {
        updateDemoRow(CONFIG.SHEET_OPP_DESCRIPTIONS, desc._rowIndex, values);
      }
      didSave = true;
      dismiss();
      if (onSaved) onSaved();
    },
    onCancel: () => dismiss(),
  });

  const backdrop = el('div', {
    class: 'modal-backdrop',
    style: { zIndex: '10001' },
    onClick: (e) => { if (e.target === backdrop) dismiss(); },
  },
    el('div', { class: 'modal' },
      el('div', { class: 'modal__header' },
        el('h2', { class: 'modal__title' }, 'Edit Description'),
        el('button', { class: 'modal__close', html: closeSvg, onClick: () => dismiss() }),
      ),
      el('div', { class: 'modal__body' }, form),
    ),
  );

  const escHandler = (e) => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      dismiss();
    }
  };
  document.addEventListener('keydown', escHandler, { capture: true });

  const root = $('#modal-root') || document.body;
  root.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('modal-backdrop--visible'));
}

async function handleDelete(opp) {
  const confirmed = await confirmDialog(
    'Delete Opportunity',
    `Are you sure you want to delete "${opp.deal_name}"? This action cannot be undone.`
  );
  if (!confirmed) return;

  try {
    if (isConfigured()) {
      await deleteRow(CONFIG.SHEET_OPPORTUNITIES, opp._rowIndex);
    } else {
      deleteDemoRow(CONFIG.SHEET_OPPORTUNITIES, opp._rowIndex);
    }
    showToast('Opportunity deleted', 'success');
    reRender();
  } catch (err) {
    showToast(err.message || 'Failed to delete opportunity', 'error');
  }
}

export function cleanup() {
  cachedPartners = null;
  cachedOpps = null;
  cachedEvents = null;
  if (newOppShortcutHandler) {
    window.removeEventListener('shortcut:new-opportunity', newOppShortcutHandler);
    newOppShortcutHandler = null;
  }
}

// ============================================
// File API + small helper exports
// ============================================

/**
 * POST to the Apps Script file endpoint.
 * No Content-Type header is set: that keeps Apps Script web apps on a
 * simple-CORS path and avoids the preflight that a JSON Content-Type triggers.
 * EXPORTED so Randy's MAP PDF flow can reuse the exact same call shape
 * (including the critical missing-Content-Type CORS behavior) without
 * maintaining a parallel Drive client.
 */
export const fileApiRequest = fileApiRequestImpl;

/**
 * Test-only: exposes the pure logic used by inline row action buttons so
 * tests can verify behaviour without a full DOM environment.
 * Not used by any production code path.
 */
export const __inlineRowActionsInternals = {
  // Returns true when the inline Edit/Delete buttons should be rendered on a description row.
  shouldShowDescriptionActions: (desc, selectionMode) =>
    !selectionMode && !!desc._rowIndex,

  // Column values array sent to updateRow for an immediate description save.
  buildDescriptionUpdateValues: (desc, opp) => [
    desc.description_id,
    desc.opportunity_id || opp.opportunity_id,
    desc.deal_name || opp.deal_name,
    desc.description_date,
    desc.description_text,
    desc.created_at,
  ],

  // Handler factory: mirrors the description delete button's onClick logic with injected deps.
  makeDescriptionDeleteHandler: (desc, idx, cardRow, onDescriptionDeleted, deps) =>
    async () => {
      const confirmed = await deps.confirmDialog(
        'Delete Description',
        'Are you sure you want to remove this description? This cannot be undone.',
      );
      if (!confirmed) return;
      if (deps.isConfigured()) {
        await deps.deleteRow(deps.SHEET_OPP_DESCRIPTIONS, desc._rowIndex);
      } else {
        deps.deleteDemoRow(deps.SHEET_OPP_DESCRIPTIONS, desc._rowIndex);
      }
      cardRow.remove();
      if (onDescriptionDeleted) onDescriptionDeleted(idx);
      deps.showToast('Description removed', 'success');
    },

  // Handler factory: mirrors the document delete button's onClick logic in the details modal.
  makeDocumentDeleteHandler: (file, files, row, deps) =>
    async () => {
      const confirmed = await deps.confirmDialog(
        'Remove Document',
        `Are you sure you want to remove "${file.file_name || 'this file'}"? This cannot be undone.`,
      );
      if (!confirmed) return;
      await deps.fileApiRequest({ action: 'deleteFile', docId: file.doc_id });
      const idx = files.findIndex(f => f.doc_id === file.doc_id);
      if (idx >= 0) files.splice(idx, 1);
      row.remove();
      deps.showToast('File removed', 'success');
    },
};

function pencilIconSvg() {
  return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.5 2.5a1.41 1.41 0 0 1 2 2L5 13l-3 .75L2.75 11l8.75-8.5Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function trashIconSvg() {
  return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 4h10M5 4V2.5h4V4M5.5 6v4M8.5 6v4M3 4l.5 8h7l.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

