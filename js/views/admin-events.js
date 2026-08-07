// ============================================
// Admin Events Management View
// ============================================

import { getCurrentUser } from '../auth.js';
import { readSheetAsObjects, appendRow, appendRows, updateRowById, updateRowsById, deleteRowById, isConfigured, addDemoRow } from '../sheets.js';
import { CONFIG } from '../config.js';
import { el, mount, uuid, debounce, formatCurrency } from '../utils/dom.js';
import { nowISO, formatDate, todayISO, parseDate, isDateInRange } from '../utils/date.js';
import { openModal, closeModal, confirmDialog } from '../components/modal.js';
import { buildForm } from '../components/form.js';
import { showToast } from '../components/toast.js';
import { setTopbar, setTopbarTitle } from '../components/sidebar.js';
import { filterPartners, filterEvents } from '../utils/filters.js';
import { loadTypeFilter, computeTypeData, buildTypeFilterBar, applyTypeFilter } from '../components/type-filter.js';
import { stripHtml, ensureHtml } from '../components/quill-editor.js';
import { fileApiRequest } from '../utils/file-api.js';
import { fileStoreKey, legacyFileStoreKey } from '../utils/file-store-keys.js';
import {
  buildDescriptionsPanel,
  isDescriptionEmpty,
  pickLatestDescriptionText,
  toISODateOnly,
} from '../components/descriptions-panel.js';
import {
  buildDocumentsPanel,
  listEntityDocuments,
} from '../components/documents-panel.js';
import { openOppModal } from './admin-opportunities.js';
import { openPlaybookPanel, destroyPlaybookPanel, PLAYBOOK_URL } from '../components/playbook-panel.js';
import { ICONS, iconButton } from '../components/icon-button.js';
import { sectionIcon } from '../components/section-icon.js';

export const title = 'Events';

let cachedPartners = null;
let cachedEvents = null;
let cachedOpps = null;
let allBasePartners = null;
let allBaseEvents = null;
let allBaseOpps = null;

const EVENT_STATUSES = ['Upcoming', 'In Progress', 'Completed', 'Cancelled'];
const EVENT_TYPES = ['Webinar', 'Workshop', 'Conference', 'Campaign', 'Other'];

const STATUS_COLORS = {
  'Upcoming': '#0000CC',
  'In Progress': '#2222DD',
  'Completed': '#0F7A3F',
  'Cancelled': '#CC2222',
};

const TYPE_CHIP_CLASS = {
  'Webinar': 'webinar',
  'Workshop': 'workshop',
  'Conference': 'conference',
  'Campaign': 'campaign',
  'Other': 'other',
};

const TYPE_CHIP_COLORS = {
  'Webinar': '#0000CC',
  'Workshop': '#2222DD',
  'Conference': '#1A1A2E',
  'Campaign': '#CC8800',
  'Other': '#4A4A5A',
};

export async function render(container, params) {
  setTopbarTitle('Events / JLG');
  mount(container, el('div', { class: 'loading-overlay' }, el('div', { class: 'spinner' })));

  // Deep link: #/admin/events?playbook=1 opens the page with the
  // playbook panel already up (the panel keeps this param in sync while
  // open, so the URL survives refresh and can be shared with teammates).
  if (params && params.playbook === '1') openPlaybookPanel();

  try {
    await loadEventData();
    renderWithTypeFilter(container);
  } catch (err) {
    mount(container, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'Error loading events'),
      el('div', { class: 'empty-state__description' }, err.message)
    ));
  }
}

// Pull the sheets this view renders from into module state. Split out of
// render() so a re-render after a mutation can refresh them too — see
// reRender().
async function loadEventData() {
  const [events, partners, opportunities] = await Promise.all([
    readSheetAsObjects(CONFIG.SHEET_EVENTS),
    readSheetAsObjects(CONFIG.SHEET_PARTNERS),
    readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
  ]);
  allBasePartners = filterPartners(partners);
  allBaseEvents = filterEvents(events);
  allBaseOpps = opportunities || [];
}

function renderWithTypeFilter(container) {
  const selectedTypes = loadTypeFilter();
  const allTypeData = computeTypeData(allBasePartners, allBaseOpps);
  const allUniqueTypes = Object.keys(allTypeData);
  const allTotalPipeline = allBaseOpps.reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);
  const validSelected = selectedTypes.filter(t => allUniqueTypes.includes(t));

  const { partners: tfPartners, events: tfEvents } = applyTypeFilter({
    partners: allBasePartners, events: allBaseEvents, selected: validSelected,
  });
  cachedPartners = tfPartners;
  cachedEvents = tfEvents;
  cachedOpps = allBaseOpps;

  const filterBar = buildTypeFilterBar({
    allUniqueTypes, allTypeData, allTotalPipeline, validSelected,
    onChanged: () => renderWithTypeFilter(container),
  });

  renderView(container, cachedEvents, cachedOpps, filterBar);
}

// Re-render AFTER re-reading the sheet — see the note on admin-partners.js's
// reRender. Redrawing the module-level `allBaseEvents` without refetching left
// every event below a deleted one carrying a `_rowIndex` one too high for the
// rest of the session, so the next kanban drop or modal save wrote a full row
// over an unrelated event. It also meant a deleted event stayed on screen and a
// drag never visibly settled into its new column.
function reRender() {
  const viewContainer = document.getElementById('view-container');
  return loadEventData()
    .then(() => renderWithTypeFilter(viewContainer))
    .catch((err) => {
      showToast(err.message || 'Saved, but the list could not be refreshed. Reload the page.', 'error');
    });
}

// Move an event to another status.
//
// Same shape as the opportunities kanban: a drag sets one column and the rest
// are read back from the sheet, so the move cannot revert an edit made since
// this card was drawn. Writes A:M — lead_count and event_password sit past the
// end of the range and are left alone.
async function saveEventStatus(eventId, status) {
  return updateRowById(CONFIG.SHEET_EVENTS, 'event_id', eventId, (fresh) => [
    fresh.event_id, fresh.title, fresh.description, fresh.event_date,
    fresh.end_date || fresh.event_date, fresh.event_type, fresh.location,
    fresh.url, fresh.created_by, fresh.created_at, status, fresh.partner_id || '',
    fresh.checklist || '',
  ]);
}

export const __eventWriteInternals = { saveEventStatus };

function getPartnerName(partnerId) {
  if (!partnerId || !cachedPartners) return '';
  const p = cachedPartners.find(p => p.partner_id === partnerId);
  return p ? p.display_name : '';
}

// ============================================
// Revenue by Event Chart
// ============================================

function buildEventRevenueChart(events, opportunities) {
  // Join opportunities to events via lead_source
  const eventRevenue = {};
  for (const opp of opportunities) {
    const src = opp.lead_source;
    if (!src || src === 'salesperson') continue;
    const val = parseFloat(opp.deal_value) || 0;
    if (!eventRevenue[src]) eventRevenue[src] = { total: 0, partnerId: opp.partner_id };
    eventRevenue[src].total += val;
  }

  // Build display data: match event titles
  const data = [];
  for (const [eventId, rev] of Object.entries(eventRevenue)) {
    const evt = events.find(e => e.event_id === eventId);
    const title = evt ? evt.title : eventId;
    const type = evt ? evt.event_type : 'Other';
    const partnerName = getPartnerName(rev.partnerId) || 'Unknown';
    data.push({ title, type, partnerName, total: rev.total });
  }
  data.sort((a, b) => b.total - a.total);

  if (data.length === 0) {
    return el('div', { class: 'demandgen-chart' },
      el('div', { class: 'demandgen-chart__title' }, 'Revenue by Event & Partner'),
      el('div', { class: 'demandgen-chart__subtitle' }, 'No event-sourced revenue yet')
    );
  }

  const maxVal = Math.max(...data.map(d => d.total));

  const rows = data.map(d => {
    const pct = maxVal > 0 ? (d.total / maxVal) * 100 : 0;
    const color = TYPE_CHIP_COLORS[d.type] || 'var(--color-primary-lighter)';

    return el('div', { class: 'demandgen-bar-row' },
      el('div', { class: 'demandgen-bar-row__label', title: d.title },
        el('div', { style: { lineHeight: 'var(--leading-tight)' } }, d.title),
        el('div', { style: { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontWeight: 'var(--font-normal)' } }, d.partnerName),
      ),
      el('div', { class: 'demandgen-bar-row__bar' },
        el('div', {
          class: 'demandgen-bar-row__segment',
          style: { width: pct + '%', background: color },
        })
      ),
      el('div', { class: 'demandgen-bar-row__value' }, formatCurrency(d.total)),
    );
  });

  return el('div', { class: 'demandgen-chart' },
    el('div', { class: 'demandgen-chart__title' }, 'Revenue by Event & Partner'),
    el('div', { class: 'demandgen-chart__subtitle' }, 'Pipeline generated from demand gen events'),
    el('div', { class: 'demandgen-bar-list' }, ...rows),
  );
}

// ============================================
// Main View
// ============================================

function renderView(container, events, opportunities, filterBar) {
  let activeView = 'list';
  let filters = { search: '', partners: new Set(), type: '', status: '' };

  // Calendar month state — persisted across filter changes and view switches
  const today = new Date();
  let calYear = today.getFullYear();
  let calMonth = today.getMonth();

  function getFiltered() {
    return events.filter(evt => {
      if (filters.partners.size > 0) {
        // If event has no partner, only show if 'all' partners chip includes it
        if (!evt.partner_id && !filters.partners.has('__none__')) return false;
        if (evt.partner_id && !filters.partners.has(evt.partner_id)) return false;
      }
      if (filters.type && evt.event_type !== filters.type) return false;
      if (filters.status && evt.status !== filters.status) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!(evt.title?.toLowerCase().includes(q) ||
              evt.description?.toLowerCase().includes(q) ||
              evt.location?.toLowerCase().includes(q) ||
              getPartnerName(evt.partner_id)?.toLowerCase().includes(q))) return false;
      }
      return true;
    });
  }

  // Stats
  const upcoming = events.filter(e => e.status === 'Upcoming').length;
  const inProgress = events.filter(e => e.status === 'In Progress').length;
  const completed = events.filter(e => e.status === 'Completed').length;

  // Stat card filter toggle
  let activeStatFilter = '';
  function toggleStatFilter(status) {
    if (activeStatFilter === status || (status === '' && activeStatFilter === '')) {
      activeStatFilter = '';
      filters.status = '';
    } else if (status === '') {
      activeStatFilter = '';
      filters.status = '';
    } else {
      activeStatFilter = status;
      filters.status = status;
    }
    statusSelect.value = filters.status;
    updateStatCardStates();
    refreshContent();
  }

  function updateStatCardStates() {
    const cells = document.querySelectorAll('.events-page__stat-strip .events-page__stat-cell');
    const filterMap = ['', 'Upcoming', 'In Progress', 'Completed'];
    cells.forEach((cell, i) => {
      cell.classList.toggle('events-page__stat-cell--active', filterMap[i] === activeStatFilter && activeStatFilter !== '');
    });
  }

  // Compute event counts per partner for chips
  const partnerEventCounts = {};
  events.forEach(evt => {
    const pid = evt.partner_id || '__none__';
    partnerEventCounts[pid] = (partnerEventCounts[pid] || 0) + 1;
  });

  // Partner chip filters
  const PARTNER_TYPE_COLORS = {
    'Technology': '#0000CC', 'OEM': '#CC8800',
    'MSP/SI': '#00BFFF', 'MENA Regional Distributor': '#2222DD',
  };

  const chipContainer = el('div', { class: 'partner-chips' });

  // "All" chip
  const allChip = el('button', {
    class: 'partner-chip partner-chip--active',
    onClick: () => {
      filters.partners.clear();
      updateChipStates();
      refreshContent();
    },
  },
    el('span', { class: 'partner-chip__name' }, 'All Partners'),
    el('span', { class: 'partner-chip__count' }, String(events.length))
  );
  allChip.dataset.partnerId = '__all__';
  chipContainer.appendChild(allChip);

  // Per-partner chips
  const partnerChips = [];
  (cachedPartners || []).forEach(p => {
    const count = partnerEventCounts[p.partner_id] || 0;
    if (count === 0) return; // Only show partners with events
    const color = PARTNER_TYPE_COLORS[p.partner_type] || '#9B9A9B';
    const chip = el('button', {
      class: 'partner-chip',
      onClick: () => {
        if (filters.partners.has(p.partner_id)) {
          filters.partners.delete(p.partner_id);
        } else {
          filters.partners.add(p.partner_id);
        }
        updateChipStates();
        refreshContent();
      },
    },
      el('span', { class: 'partner-chip__dot', style: { background: color } }),
      el('span', { class: 'partner-chip__name' }, p.display_name),
      el('span', { class: 'partner-chip__count' }, String(count))
    );
    chip.dataset.partnerId = p.partner_id;
    partnerChips.push(chip);
    chipContainer.appendChild(chip);
  });

  // "No Partner" chip if any events have no partner
  if (partnerEventCounts['__none__']) {
    const noneChip = el('button', {
      class: 'partner-chip',
      onClick: () => {
        if (filters.partners.has('__none__')) {
          filters.partners.delete('__none__');
        } else {
          filters.partners.add('__none__');
        }
        updateChipStates();
        refreshContent();
      },
    },
      el('span', { class: 'partner-chip__name' }, 'All Partners (shared)'),
      el('span', { class: 'partner-chip__count' }, String(partnerEventCounts['__none__']))
    );
    noneChip.dataset.partnerId = '__none__';
    partnerChips.push(noneChip);
    chipContainer.appendChild(noneChip);
  }

  function updateChipStates() {
    const isAll = filters.partners.size === 0;
    allChip.classList.toggle('partner-chip--active', isAll);
    partnerChips.forEach(chip => {
      chip.classList.toggle('partner-chip--active', filters.partners.has(chip.dataset.partnerId));
    });
  }

  // Filter controls — sharp-cornered Recast chrome
  const searchInput = el('input', {
    class: 'events-page__search',
    type: 'text',
    placeholder: 'Search events...',
    onInput: debounce((e) => { filters.search = e.target.value; refreshContent(); }, 200),
  });

  const typeSelect = el('select', {
    class: 'events-page__select',
    onChange: (e) => { filters.type = e.target.value; refreshContent(); },
  },
    el('option', { value: '' }, 'All Types'),
    ...EVENT_TYPES.map(t => el('option', { value: t }, t))
  );

  const statusSelect = el('select', {
    class: 'events-page__select',
    onChange: (e) => { filters.status = e.target.value; activeStatFilter = e.target.value; updateStatCardStates(); refreshContent(); },
  },
    el('option', { value: '' }, 'All Statuses'),
    ...EVENT_STATUSES.map(s => el('option', { value: s }, s))
  );

  // 3-segment view toggle: Board | Calendar | List
  const boardBtn = el('button', { class: 'events-page__view-btn', onClick: () => switchView('board') }, 'Board');
  const calendarBtn = el('button', { class: 'events-page__view-btn', onClick: () => switchView('calendar') }, 'Calendar');
  const listBtn = el('button', { class: 'events-page__view-btn events-page__view-btn--active', onClick: () => switchView('list') }, 'List');

  const viewContainer = el('div', { id: 'events-view-container' });

  // 4-cell stat strip — replaces the old 4 colored-border cards
  const statStrip = el('div', { class: 'events-page__stat-strip' },
    buildStatCell('Total Events', events.length, () => toggleStatFilter('')),
    buildStatCell('Upcoming', upcoming, () => toggleStatFilter('Upcoming')),
    buildStatCell('In Progress', inProgress, () => toggleStatFilter('In Progress')),
    buildStatCell('Completed', completed, () => toggleStatFilter('Completed')),
  );

  // Topbar header: eyebrow title + meta + type-filter chips + + New Event CTA
  const totalSourcedPipeline = opportunities
    .filter(o => o.lead_source && o.lead_source !== 'salesperson')
    .reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);
  const eventsLabel = events.length === 1 ? '1 event' : `${events.length} events`;
  const meta = `· ${eventsLabel} · ${formatCurrency(totalSourcedPipeline)} sourced pipeline`;

  const newEventBtn = el('button', {
    class: 'topbar__cta',
    onClick: () => openEventModal(null, container),
  },
    el('span', { html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
    'New Event',
  );

  const playbookBtn = el('button', {
    class: 'topbar__cta topbar__cta--ghost',
    title: 'Open the Events Playbook in a new tab',
    onClick: () => window.open(PLAYBOOK_URL, '_blank', 'noopener,noreferrer'),
  },
    el('span', { html: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3.5C8 2.7 6.5 2 4.5 2S1 2.7 1 3.5v9C1 13.3 2.5 14 4.5 14S8 13.3 8 12.5m0-9C8 2.7 9.5 2 11.5 2S15 2.7 15 3.5v9c0 .8-1.5 1.5-3.5 1.5S8 13.3 8 12.5m0-9v9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
    'Playbook',
  );

  setTopbar({
    title: 'Events / JLG',
    meta,
    chips: filterBar,
  });

  const content = el('div', { class: 'events-page' },
    statStrip,

    // Playbook + New Event actions — moved below the stat strip (Completed
    // section) and above the board/calendar/list view section.
    el('div', { class: 'events-page__actions' }, playbookBtn, newEventBtn),

    // Partner chip filters (kept as-is; restyle is in Chunk 2)
    chipContainer,

    // Single filter row above the table — sharp inputs + 3-segment toggle on the right
    el('div', { class: 'events-page__filter-row' },
      searchInput,
      el('div', { class: 'select-with-icon' }, sectionIcon('tag', 'orange', { size: 'sm' }), typeSelect),
      el('div', { class: 'select-with-icon' }, sectionIcon('flag', 'indigo', { size: 'sm' }), statusSelect),
      el('div', { class: 'events-page__view-toggle' }, boardBtn, calendarBtn, listBtn),
    ),

    viewContainer,
  );

  mount(container, content);

  function switchView(view) {
    activeView = view;
    [boardBtn, calendarBtn, listBtn].forEach(btn => btn.classList.remove('events-page__view-btn--active'));
    if (view === 'board') boardBtn.classList.add('events-page__view-btn--active');
    else if (view === 'calendar') calendarBtn.classList.add('events-page__view-btn--active');
    else listBtn.classList.add('events-page__view-btn--active');
    refreshContent();
  }

  function refreshContent() {
    const filtered = getFiltered();
    viewContainer.innerHTML = '';
    if (activeView === 'board') {
      viewContainer.appendChild(renderBoard(filtered));
    } else if (activeView === 'calendar') {
      viewContainer.appendChild(renderCalendar(filtered, calYear, calMonth, (y, m) => { calYear = y; calMonth = m; }));
    } else {
      viewContainer.appendChild(renderList(filtered));
    }
  }

  refreshContent();
}

// ============================================
// Board View (Kanban)
// ============================================

function renderBoard(events) {
  const board = el('div', { class: 'kanban' });

  EVENT_STATUSES.forEach(status => {
    const columnEvents = events.filter(e => (e.status || 'Upcoming') === status);
    const color = STATUS_COLORS[status] || '#9B9A9B';

    const cardsContainer = el('div', { class: 'kanban__cards' });

    columnEvents
      .sort((a, b) => new Date(a.event_date) - new Date(b.event_date))
      .forEach(evt => {
        const card = createEventCard(evt);
        cardsContainer.appendChild(card);
      });

    const column = el('div', { class: 'kanban__column' },
      el('div', { class: 'kanban__column-header' },
        el('div', {},
          el('span', { class: 'kanban__column-title', style: { color } }, status),
        ),
        el('span', { class: 'kanban__column-count' }, String(columnEvents.length))
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
      const eventId = e.dataTransfer.getData('text/plain');
      if (!eventId) return;

      const evt = cachedEvents.find(ev => ev.event_id === eventId);
      if (!evt || evt.status === status) return;

      try {
        await saveEventStatus(evt.event_id, status);
        showToast(`Moved "${evt.title}" to ${status}`, 'success');
        reRender();
      } catch (err) {
        showToast(err.message || 'Failed to update event', 'error');
      }
    });

    board.appendChild(column);
  });

  return board;
}

function createEventCard(evt) {
  const actions = el('div', { class: 'kanban__card-actions' },
    el('button', {
      class: 'kanban__card-action-btn',
      title: 'Edit',
      onClick: (e) => { e.stopPropagation(); openEventModal(evt, document.getElementById('view-container')); },
      html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10.5 1.5l2 2-8 8H2.5v-2l8-8z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    }),
    el('button', {
      class: 'kanban__card-action-btn kanban__card-action-btn--danger',
      title: 'Delete',
      onClick: (e) => { e.stopPropagation(); handleDelete(evt); },
      html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5h4V4M5.5 6v4M8.5 6v4M3 4l.5 8h7l.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    }),
  );

  const card = el('div', {
    class: 'kanban__card',
    draggable: 'true',
  },
    actions,
    el('div', { class: 'kanban__card-title' }, evt.title),
    el('div', { class: 'kanban__card-subtitle' },
      formatDate(evt.event_date) +
      (evt.end_date && evt.end_date !== evt.event_date ? ` — ${formatDate(evt.end_date)}` : '')
    ),
    el('div', { class: 'kanban__card-meta' },
      el('span', { class: `badge badge--${getTypeBadge(evt.event_type)}` }, evt.event_type),
      evt.partner_id
        ? el('span', { class: 'badge badge--admin' }, getPartnerName(evt.partner_id) || evt.partner_id)
        : el('span', { style: { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' } }, 'All Partners'),
    ),
    evt.location
      ? el('div', { style: { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 'var(--space-1)' } }, evt.location)
      : null
  );

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', evt.event_id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    // Remove all dragover indicators
    document.querySelectorAll('.kanban__column--dragover').forEach(col => col.classList.remove('kanban__column--dragover'));
  });

  card.addEventListener('click', () => {
    openEventModal(evt, document.getElementById('view-container'));
  });

  return card;
}

// ============================================
// Calendar View
// ============================================

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function renderCalendar(events, year, month, setMonth) {
  const today = new Date();
  let currentYear = year;
  let currentMonth = month;

  const wrapper = el('div');

  function navigate(delta) {
    currentMonth += delta;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    setMonth(currentYear, currentMonth);
    buildCalendar();
  }

  function goToday() {
    currentYear = today.getFullYear();
    currentMonth = today.getMonth();
    setMonth(currentYear, currentMonth);
    buildCalendar();
  }

  function buildCalendar() {
    wrapper.innerHTML = '';

    const dayCells = buildDayCells(currentYear, currentMonth, events, today);
    const hasEvents = dayCells.some(cell => cell.dataset.eventCount > 0);

    // Type legend
    const legend = el('div', { class: 'calendar__legend' },
      ...Object.entries(TYPE_CHIP_COLORS).map(([type, color]) =>
        el('div', { class: 'calendar__legend-item' },
          el('span', { class: 'calendar__legend-dot', style: { background: color } }),
          el('span', { class: 'calendar__legend-label' }, type)
        )
      )
    );

    const calendar = el('div', { class: 'calendar' },
      // Header
      el('div', { class: 'calendar__header' },
        el('div', { class: 'calendar__nav' },
          el('button', { class: 'calendar__nav-btn', onClick: () => navigate(-1), html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 3L4 7l5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
          el('button', { class: 'calendar__nav-btn', onClick: goToday }, 'Today'),
          el('button', { class: 'calendar__nav-btn', onClick: () => navigate(1), html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3l5 4-5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
        ),
        el('div', { class: 'calendar__title' }, `${MONTH_NAMES[currentMonth]} ${currentYear}`),
        legend
      ),
      // Grid
      el('div', { class: 'calendar__grid' },
        ...['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d =>
          el('div', { class: 'calendar__day-header' }, d)
        ),
        ...dayCells
      )
    );

    wrapper.appendChild(calendar);

    // Empty month message
    if (!hasEvents) {
      wrapper.appendChild(
        el('div', { class: 'calendar__empty-msg' },
          `No events match your filters for ${MONTH_NAMES[currentMonth]} ${currentYear}`
        )
      );
    }
  }

  buildCalendar();
  return wrapper;
}

function buildDayCells(year, month, events, today) {
  const cells = [];
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDow = firstDay.getDay();
  const daysInMonth = lastDay.getDate();

  // Previous month padding
  const prevMonth = new Date(year, month, 0);
  for (let i = startDow - 1; i >= 0; i--) {
    const day = prevMonth.getDate() - i;
    const cell = createDayCell(day, true, [], false);
    cell.dataset.eventCount = '0';
    cells.push(cell);
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    const isCurrentToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;
    const dayDate = new Date(year, month, d);

    // Find events on this day using proper date parsing
    const dayEvents = events.filter(evt => {
      const start = parseDate(evt.event_date);
      if (!start) return false;
      const end = evt.end_date ? parseDate(evt.end_date) : start;
      return isDateInRange(dayDate, start, end);
    });

    const cell = createDayCell(d, false, dayEvents, isCurrentToday);
    cell.dataset.eventCount = String(dayEvents.length);
    cells.push(cell);
  }

  // Next month padding
  const remaining = 7 - (cells.length % 7);
  if (remaining < 7) {
    for (let i = 1; i <= remaining; i++) {
      const cell = createDayCell(i, true, [], false);
      cell.dataset.eventCount = '0';
      cells.push(cell);
    }
  }

  return cells;
}

function createDayCell(dayNum, isOtherMonth, dayEvents, isToday) {
  const classes = ['calendar__day'];
  if (isOtherMonth) classes.push('calendar__day--other-month');
  if (isToday) classes.push('calendar__day--today');

  const chips = dayEvents.slice(0, 4).map(evt => {
    const typeClass = TYPE_CHIP_CLASS[evt.event_type] || 'other';
    const statusColor = STATUS_COLORS[evt.status] || '#9B9A9B';
    const partnerName = getPartnerName(evt.partner_id);

    // Rich tooltip
    const tooltipParts = [evt.title];
    if (evt.event_date) {
      let dateRange = formatDate(evt.event_date);
      if (evt.end_date && evt.end_date !== evt.event_date) dateRange += ` — ${formatDate(evt.end_date)}`;
      tooltipParts.push(dateRange);
    }
    if (evt.event_type) tooltipParts.push(`Type: ${evt.event_type}`);
    if (evt.status) tooltipParts.push(`Status: ${evt.status}`);
    if (partnerName) tooltipParts.push(`Partner: ${partnerName}`);
    if (evt.location) tooltipParts.push(`Location: ${evt.location}`);

    const chipLabel = partnerName
      ? `${evt.title} · ${partnerName}`
      : evt.title;

    return el('div', {
      class: `calendar__event-chip calendar__event-chip--${typeClass}`,
      style: { borderLeftColor: statusColor },
      title: tooltipParts.join('\n'),
      onClick: (e) => {
        e.stopPropagation();
        openEventModal(evt, document.getElementById('view-container'));
      },
    }, chipLabel);
  });

  if (dayEvents.length > 4) {
    chips.push(el('div', {
      class: 'calendar__more-events',
    }, `+${dayEvents.length - 4} more`));
  }

  return el('div', { class: classes.join(' ') },
    el('div', { class: 'calendar__day-num' }, String(dayNum)),
    ...chips
  );
}

// ============================================
// List View (Enhanced Table)
// ============================================

function renderList(events) {
  const sorted = [...events].sort((a, b) => new Date(b.event_date) - new Date(a.event_date));

  // Pre-aggregate opps per event so each row is O(1). Salesperson-sourced
  // opps aren't tied to a demand-gen event, so they're excluded from the
  // per-event Opportunities/Revenue rollup.
  const oppMetrics = {};
  for (const opp of (cachedOpps || [])) {
    const src = opp.lead_source;
    if (!src || src === 'salesperson') continue;
    if (!oppMetrics[src]) oppMetrics[src] = { count: 0, revenue: 0 };
    oppMetrics[src].count += 1;
    oppMetrics[src].revenue += parseFloat(opp.deal_value) || 0;
  }

  if (sorted.length === 0) {
    return el('div', { class: 'empty-state', style: { marginTop: 'var(--space-8)' } },
      el('div', { class: 'empty-state__title' }, 'No matching events'),
      el('div', { class: 'empty-state__description' }, 'Try adjusting your filters or create a new event.')
    );
  }

  const numCellClass = (val) => val > 0
    ? 'events-page__td--num'
    : 'events-page__td--num events-page__td--num-zero';

  return el('div', { class: 'events-page__table-wrapper' },
    el('table', { class: 'events-page__table events-page__table--compact' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'Event'),
          el('th', {}, 'Date'),
          el('th', {}, 'Type'),
          el('th', {}, 'Status'),
          el('th', {}, 'Partner'),
          el('th', {}, 'Location'),
          el('th', { class: 'events-page__th--num' }, 'Leads'),
          el('th', { class: 'events-page__th--num' }, 'Opps'),
          el('th', { class: 'events-page__th--num' }, 'Revenue'),
          el('th', {}, 'Actions')
        )
      ),
      el('tbody', {},
        ...sorted.map(evt => {
          const metrics = oppMetrics[evt.event_id] || { count: 0, revenue: 0 };
          const leads = Math.max(0, parseInt(evt.lead_count, 10) || 0);
          const oppCount = metrics.count;
          const revenue = metrics.revenue;

          return el('tr', {
            style: { cursor: 'pointer' },
            onClick: () => openEventModal(evt, document.getElementById('view-container')),
          },
            el('td', {},
              el('div', { class: 'events-page__name' }, evt.title),
              evt.description
                ? el('div', { class: 'events-page__row-subtitle' }, evt.description)
                : null,
            ),
            el('td', { class: 'events-page__date' }, formatEventDateRange(evt.event_date, evt.end_date)),
            el('td', {}, el('span', { class: 'events-page__tag' }, evt.event_type || 'Other')),
            el('td', {}, buildStatusPill(evt.status || 'Upcoming')),
            el('td', {},
              evt.partner_id
                ? el('span', { class: 'events-page__tag' }, getPartnerName(evt.partner_id) || evt.partner_id)
                : el('span', { class: 'events-page__tag--muted' }, 'All Partners'),
            ),
            el('td', {}, evt.location || el('span', { class: 'events-page__tag--muted' }, '—')),
            el('td', { class: numCellClass(leads) }, String(leads)),
            el('td', { class: numCellClass(oppCount) }, String(oppCount)),
            el('td', { class: numCellClass(revenue) }, formatCurrency(revenue)),
            el('td', { class: 'events-page__td--actions' },
              el('div', { class: 'events-page__actions' },
                iconButton({
                  icon: ICONS.edit,
                  label: 'Edit',
                  title: 'Edit this event',
                  onClick: (e) => { e.stopPropagation(); openEventModal(evt, document.getElementById('view-container')); },
                }),
                iconButton({
                  icon: ICONS.trash,
                  label: 'Delete',
                  title: 'Delete this event',
                  danger: true,
                  onClick: (e) => { e.stopPropagation(); handleDelete(evt); },
                })
              )
            )
          );
        })
      )
    )
  );
}

function formatEventDateRange(start, end) {
  if (!start) return '—';
  if (!end || end === start) return formatDate(start);
  const s = parseDate(start);
  const e = parseDate(end);
  // "Mar 15 – Mar 18, 2027" when both within same year, else show full each.
  if (s && e && s.getFullYear() === e.getFullYear()) {
    const sShort = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const eFull = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${sShort} – ${eFull}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function buildStatusPill(status) {
  const slug = (status || '').toLowerCase().replace(/\s+/g, '-');
  return el('span', { class: `events-page__status events-page__status--${slug}` }, status);
}

// ============================================
// Helpers
// ============================================

function buildStatCell(label, value, onClick) {
  return el('div', {
    class: 'events-page__stat-cell events-page__stat-cell--clickable',
    onClick,
  },
    el('div', { class: 'events-page__stat-label' }, label),
    el('div', { class: 'events-page__stat-value' }, String(value)),
  );
}

function getTypeBadge(type) {
  const map = { Webinar: 'registered', Workshop: 'won', Conference: 'admin', Campaign: 'in-progress', Other: 'silver' };
  return map[type] || 'silver';
}

function getStatusBadge(status) {
  const map = { 'Upcoming': 'registered', 'In Progress': 'in-progress', 'Completed': 'won', 'Cancelled': 'lost' };
  return map[status] || 'registered';
}

// ============================================
// Event Modal (Create/Edit)
// ============================================

export async function openEventModal(event, container, onSaved) {
  const isEdit = !!event;

  // Always refresh the opportunities list so the "Sourced Opportunities"
  // rollup picks up any opps that were tagged to this event since the
  // page was last rendered. Partners are loaded only when missing.
  const [partnersFresh, oppsFresh] = await Promise.all([
    cachedPartners ? Promise.resolve(null) : readSheetAsObjects(CONFIG.SHEET_PARTNERS),
    readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
  ]);
  if (partnersFresh) {
    cachedPartners = partnersFresh.filter(p => String(p.is_admin).toUpperCase() !== 'TRUE');
  }
  cachedOpps = oppsFresh;

  // Compute opportunities sourced from this event (lead_source links opp → event_id).
  const linkedOpps = isEdit
    ? (cachedOpps || []).filter(o => o.lead_source === event.event_id)
    : [];
  const totalPipeline = linkedOpps.reduce(
    (sum, o) => sum + (parseFloat(o.deal_value) || 0),
    0,
  );

  // Load existing descriptions when editing. Documents are loaded in the
  // background after the modal opens (see docsHandle.refresh() below) so
  // the user doesn't wait on the Apps Script round-trip just to see the
  // form. Description failures are tolerated (e.g. the Event_Descriptions
  // sheet may not exist yet on a fresh install) — empty list on failure.
  let workingDescriptions = [];
  if (isEdit) {
    try {
      const all = await readSheetAsObjects(CONFIG.SHEET_EVENT_DESCRIPTIONS);
      workingDescriptions = all
        .filter(d => d.event_id === event.event_id)
        .map(d => ({ ...d }))
        .sort((a, b) => new Date(b.description_date || b.created_at) - new Date(a.description_date || a.created_at));
    } catch (err) {
      console.warn('Failed to load event descriptions', err);
    }

    // Legacy migration: if no separate description records exist but the
    // event row still has a description, surface it as a pending
    // first-version card. Saving the modal will persist it to the new sheet.
    if (workingDescriptions.length === 0 && event.description) {
      workingDescriptions.push({
        _tempId: `tmp_${uuid('dsc')}`,
        _isNew: true,
        event_id: event.event_id,
        title: event.title,
        description_date: toISODateOnly(event.created_at) || todayISO(),
        description_text: event.description,
        created_at: event.created_at || nowISO(),
      });
    }
  }

  const partnerOptions = [
    { value: '', label: 'All Partners (no specific partner)' },
    ...(cachedPartners || []).map(p => ({ value: p.partner_id, label: p.display_name })),
  ];

  const fields = [
    { name: 'title', label: 'Event name', required: true, placeholder: 'e.g., Q2 Partner Kickoff Webinar' },
    { type: 'row-start' },
    { name: 'event_date', label: 'Start date', type: 'date', required: true },
    { name: 'end_date', label: 'End date', type: 'date' },
    { type: 'row-end' },
    { type: 'row-start' },
    {
      name: 'event_type', label: 'Type', type: 'select', required: true,
      icon: { glyph: 'tag', color: 'orange' },
      placeholder: 'Select type...',
      options: EVENT_TYPES,
    },
    {
      name: 'status', label: 'Status', type: 'select',
      icon: { glyph: 'flag', color: 'indigo' },
      default: 'Upcoming',
      options: EVENT_STATUSES,
    },
    { type: 'row-end' },
    {
      name: 'partner_id', label: 'Assigned partner', type: 'select',
      icon: { glyph: 'people', color: 'purple' },
      options: partnerOptions,
    },
    { name: 'location', label: 'Location', placeholder: 'e.g., Virtual (Zoom), San Francisco, CA' },
    { name: 'url', label: 'Event URL', type: 'url', placeholder: 'https://...' },
    { name: 'event_password', label: 'Event password', placeholder: 'Optional — set a password for this event' },
    {
      name: 'lead_count', label: 'Leads', type: 'number',
      min: 0, step: 1, placeholder: '0',
    },
  ];

  const initialValues = isEdit ? {
    title: event.title,
    event_date: event.event_date,
    end_date: event.end_date,
    event_type: event.event_type,
    status: event.status || 'Upcoming',
    partner_id: event.partner_id || '',
    location: event.location,
    url: event.url,
    event_password: event.event_password || '',
    lead_count: event.lead_count || '',
  } : {};

  // Guard against rapid double-clicks dispatching two submit events
  // before the first appendRow / updateRow resolves. Without this a fast
  // user could create the same event twice on a slow connection.
  let saving = false;
  const form = buildForm(fields, async (data) => {
    if (saving) return;
    saving = true;
    try {
      const user = getCurrentUser();
      // The checklist column is retained in the sheet for backward
      // compatibility; the UI no longer edits it, so pass through any
      // existing value to keep column positions stable.
      const checklistJson = isEdit ? (event.checklist || '') : '';

      // Denormalize the most recent description (plain text) onto the
      // event row so list-view previews and search keep working.
      const latestDescHtml = pickLatestDescriptionText(workingDescriptions);
      const latestDescPlain = stripHtml(latestDescHtml || '').trim();

      let eventId;
      let createdAt;

      const leadCount = Math.max(0, parseInt(data.lead_count, 10) || 0);

      if (isEdit) {
        eventId = event.event_id;
        createdAt = event.created_at;

        await updateRowById(CONFIG.SHEET_EVENTS, 'event_id', eventId, (fresh) => [
          eventId, data.title, latestDescPlain, data.event_date,
          data.end_date || data.event_date, data.event_type, data.location,
          data.url, fresh.created_by || event.created_by, fresh.created_at || createdAt,
          data.status || 'Upcoming', data.partner_id || '',
          // `checklist` is a pass-through column this form does not edit, so it
          // comes from the sheet — reading it off the snapshot would revert a
          // checklist change made since the modal opened.
          fresh.checklist || '', leadCount,
          data.event_password || '',
        ]);
      } else {
        eventId = uuid('evt');
        createdAt = nowISO();

        const values = [
          eventId, data.title, latestDescPlain, data.event_date,
          data.end_date || data.event_date, data.event_type, data.location,
          data.url, user.partner_id, createdAt, data.status || 'Upcoming',
          data.partner_id || '', checklistJson, leadCount,
          data.event_password || '',
        ];

        if (isConfigured()) {
          await appendRow(CONFIG.SHEET_EVENTS, values);
        } else {
          addDemoRow(CONFIG.SHEET_EVENTS, values);
        }
      }

      // Persist description changes to SHEET_EVENT_DESCRIPTIONS. Each delete
      // re-resolves its row by description_id, so the order no longer matters —
      // this used to delete highest-index-first to keep the remaining indices
      // valid, which only held while nothing else was writing to the sheet.
      //
      // missingOk because this modal stays open on failure: if a later step
      // throws, the user hits Save again and these deletes re-run. Without it
      // the second attempt fails on the row the first attempt already removed,
      // and the modal can never be saved.
      const toDelete = workingDescriptions.filter(d => d._deleted && d.description_id);
      for (const d of toDelete) {
        await deleteRowById(CONFIG.SHEET_EVENT_DESCRIPTIONS, 'description_id', d.description_id, { missingOk: true });
      }

      // Skip updates that would blank out an existing row.
      // Skipped rather than aborting the save when there is no id to address
      // the write with — see the same note in admin-opportunities.js.
      const editedButUnaddressable = workingDescriptions.filter(d =>
        !d._deleted && !d._isNew && d._modified && !d.description_id && !isDescriptionEmpty(d)
      );
      if (editedButUnaddressable.length) {
        console.warn(
          `[Descriptions] ${editedButUnaddressable.length} edited description(s) have no `
          + 'description_id and were not saved — add an id to those rows in the spreadsheet.',
        );
      }
      const toUpdate = workingDescriptions.filter(d =>
        !d._deleted && !d._isNew && d._modified && d.description_id && !isDescriptionEmpty(d)
      );
      // Addressed by description_id — see the same note in
      // admin-opportunities.js. This loop runs straight after the deletes
      // above, which shift every row beneath them.
      // One read and one write for the batch — see the same note in
      // admin-opportunities.js.
      await updateRowsById(CONFIG.SHEET_EVENT_DESCRIPTIONS, 'description_id', toUpdate.map(d => ({
        id: d.description_id,
        values: [
          d.description_id, eventId, data.title,
          d.description_date, d.description_text, d.created_at,
        ],
      })));

      // Skip brand-new cards where the user never actually typed anything.
      const toInsert = workingDescriptions.filter(d =>
        !d._deleted && d._isNew && !isDescriptionEmpty(d)
      );
      for (const d of toInsert) {
        const descriptionId = uuid('dsc');
        const values = [
          descriptionId, eventId, data.title,
          d.description_date, d.description_text, d.created_at || nowISO(),
        ];
        if (isConfigured()) {
          await appendRow(CONFIG.SHEET_EVENT_DESCRIPTIONS, values);
        } else {
          addDemoRow(CONFIG.SHEET_EVENT_DESCRIPTIONS, values);
        }
      }

      showToast(isEdit ? 'Event updated successfully!' : 'Event created successfully!', 'success');
      closeModal();
      if (onSaved) { onSaved(); } else { reRender(); }
    } catch (err) {
      showToast(err.message || 'Failed to save event', 'error');
    } finally {
      saving = false;
    }
  }, initialValues);

  // Descriptions panel — versioned dated cards (Quill editor in edit mode)
  const { panel: descriptionsPanel, refresh: refreshDescriptions } = buildDescriptionsPanel(workingDescriptions, {
    placeholder: 'Write the description for this event...',
    entityLabel: 'event',
  });

  // Documents panel — drag-and-drop uploads to Google Drive via the file API.
  // For new (unsaved) events there's no event_id to attach to yet, so the
  // upload zone is hidden with a helper note. For existing events we open
  // the modal with a loading state and fetch the document list in the
  // background (see refresh() call after openModal) so the Apps Script
  // round-trip doesn't block the modal from appearing.
  const docsHandle = buildDocumentsPanel({
    // Type-qualified: events and partners share one untyped file-store
    // namespace, and legacy rows of both are numbered from 1 (see
    // js/utils/file-store-keys.js). An event id the app generated is already
    // prefixed and keys exactly as before.
    entityId: isEdit ? fileStoreKey('event', event.event_id) : null,
    // Until the one-time Setup repair runs, this event's existing files are
    // still under its bare id — matched by folder name so a partner sharing
    // that id cannot leak in.
    legacy: isEdit
      ? { key: legacyFileStoreKey('event', event.event_id), contextName: event.title || '' }
      : undefined,
    getContextName: () => {
      const input = form.querySelector('[name="title"]');
      return (input && input.value) || (isEdit ? (event.title || '') : '');
    },
    initialFiles: [],
    loading: isEdit,
    savePrompt: 'Save this event first to attach documents',
    // Analyze runs the attendee-list extraction on the Apps Script side and
    // drops the result into the descriptions panel as dated cards. Only
    // available in edit mode — new events have no event_id to attach to.
    onAnalyze: isEdit ? async (file) => {
      const titleInput = form.querySelector('[name="title"]');
      const eventTitle = (titleInput && titleInput.value) || event.title || '';
      const data = await fileApiRequest({
        action: 'analyzeDocument',
        docId: file.doc_id,
        driveUrl: file.drive_url,
        analysisType: 'attendee_list',
        entityType: 'event',
        eventTitle,
      });
      const fileName = data.fileName || file.file_name || 'Document';
      const dateISO = todayISO();
      const dateLabel = formatDate(dateISO);
      // Large attendee lists arrive split into htmlParts (Google Sheets
      // cells cap at 50k chars); a single result arrives as html.
      const htmlParts = Array.isArray(data.htmlParts) && data.htmlParts.length
        ? data.htmlParts
        : [data.html || ''];
      for (let i = 0; i < htmlParts.length; i++) {
        const partLabel = i > 0 ? ` (part ${i + 1} of ${htmlParts.length})` : '';
        const descriptionHtml =
          `<h4>📄 ${escapeHtml(fileName)} — Analyzed ${escapeHtml(dateLabel)}${escapeHtml(partLabel)}</h4>` +
          ensureHtml(htmlParts[i]);
        const descriptionId = uuid('dsc');
        const createdAt = nowISO();
        const values = [descriptionId, event.event_id, eventTitle, dateISO, descriptionHtml, createdAt];
        if (isConfigured()) {
          await appendRow(CONFIG.SHEET_EVENT_DESCRIPTIONS, values);
        } else {
          addDemoRow(CONFIG.SHEET_EVENT_DESCRIPTIONS, values);
        }
        workingDescriptions.push({
          description_id: descriptionId,
          event_id: event.event_id,
          event_title: eventTitle,
          description_date: dateISO,
          description_text: descriptionHtml,
          created_at: createdAt,
        });
      }
      // Persist structured per-contact rows to the Event_Contacts tab.
      // The Apps Script returns `contacts` alongside the HTML when the
      // attendee-list analysis ran on a structured file. Batched into a
      // single append call — attendee lists can run to hundreds of rows.
      const contacts = Array.isArray(data.contacts) ? data.contacts : [];
      if (contacts.length) {
        const savedAt = nowISO();
        const contactRows = contacts.map(c => [
          event.event_id,
          eventTitle,
          uuid('ctc'),
          c.name || 'Not specified',
          c.role || 'Not specified',
          c.company || 'Not specified',
          c.email || 'Not specified',
          '', // owner — unassigned until someone claims the contact
          'New',
          c.icp_role || '',
          c.seniority_tier || '',
          c.ai_confidence || '',
          c.ai_rationale || '',
          fileName,
          savedAt,
        ]);
        await appendRows(CONFIG.SHEET_EVENT_CONTACTS, contactRows);
      }
      file.analyzed = 'TRUE';
      refreshDescriptions();
      const contactNote = contacts.length ? ` — ${contacts.length} contacts saved to Event Contacts` : '';
      showToast(`Document analyzed and added to descriptions${contactNote}`, 'success');
    } : undefined,
  });

  // Sourced opportunities summary — shown only for existing events. New
  // events have no event_id yet, so nothing can be linked to them.
  const leadCountValue = Math.max(0, parseInt(event && event.lead_count, 10) || 0);
  const sourcedOppsSection = isEdit
    ? buildSourcedOppsSection(linkedOpps, totalPipeline, leadCountValue)
    : null;

  // Combine sections in modal content. The opportunities rollup sits at
  // the top so users see pipeline impact before anything else.
  const modalContent = el('div', {},
    sourcedOppsSection,
    form,
    descriptionsPanel,
    docsHandle.panel,
  );

  openModal({
    title: isEdit ? 'Edit event.' : 'New event.',
    content: modalContent,
    // apple-scope loads the Apple design tokens (tokens.css);
    // modal--apple applies the restyle (events-modal-apple.css).
    className: 'modal--xwide apple-scope modal--apple',
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Cancel'),
      el('button', {
        class: 'btn btn--primary',
        onClick: () => form.dispatchEvent(new Event('submit', { cancelable: true })),
      }, isEdit ? 'Save changes' : 'Create event'),
    ],
  });

  // Kick off the documents fetch only after the modal is on screen so the
  // user sees the form and descriptions immediately, then the document list
  // fills in. Errors are swallowed by refresh() itself.
  if (isEdit) docsHandle.refresh();
}

/**
 * Build the "Sourced Opportunities" panel that sits at the top of the
 * Edit Event modal: a count + total pipeline summary, and a clickable
 * list of the linked opportunities (clicking switches to the opp modal).
 */
function buildSourcedOppsSection(linkedOpps, totalPipeline, leadCount = 0) {
  const sorted = [...linkedOpps].sort(
    (a, b) => (parseFloat(b.deal_value) || 0) - (parseFloat(a.deal_value) || 0),
  );

  const stats = el('div', { class: 'event-opps-stats' },
    el('div', { class: 'event-opps-stats__metric' },
      el('div', { class: 'event-opps-stats__value' }, String(leadCount)),
      el('div', { class: 'event-opps-stats__label' },
        leadCount === 1 ? 'Lead' : 'Leads',
      ),
    ),
    el('div', { class: 'event-opps-stats__metric' },
      el('div', { class: 'event-opps-stats__value' }, String(linkedOpps.length)),
      el('div', { class: 'event-opps-stats__label' },
        linkedOpps.length === 1 ? 'Opportunity' : 'Opportunities',
      ),
    ),
    el('div', { class: 'event-opps-stats__metric' },
      el('div', { class: 'event-opps-stats__value' }, formatCurrency(totalPipeline)),
      el('div', { class: 'event-opps-stats__label' }, 'Total pipeline'),
    ),
  );

  const chevronSvg = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3l5 4-5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let listEl;
  if (sorted.length === 0) {
    listEl = el('div', { class: 'event-opps-empty' },
      'No opportunities sourced from this event yet.',
    );
  } else {
    listEl = el('div', { class: 'event-opps-list' },
      ...sorted.map(opp => {
        const statusClass = (opp.status || 'Registered')
          .toLowerCase()
          .replace(/\s+/g, '-');
        return el('button', {
          type: 'button',
          class: 'event-opp-row',
          onClick: () => openOppModal(opp, document.getElementById('view-container')),
        },
          el('div', { class: 'event-opp-row__main' },
            el('div', { class: 'event-opp-row__name' }, opp.deal_name || 'Untitled deal'),
            el('div', { class: 'event-opp-row__sub' },
              el('span', {}, opp.customer_name || '—'),
              el('span', { class: 'event-opp-row__dot' }, '·'),
              el('span', {}, opp.stage || '—'),
            ),
          ),
          el('div', { class: 'event-opp-row__right' },
            el('span', { class: 'event-opp-row__value' },
              formatCurrency(parseFloat(opp.deal_value) || 0),
            ),
            el('span', { class: `badge badge--${statusClass}` }, opp.status || 'Registered'),
          ),
          el('span', { class: 'event-opp-row__chevron', html: chevronSvg }),
        );
      }),
    );
  }

  return el('div', { class: 'event-opps-section' },
    el('h3', { class: 'event-opps-section__title' }, sectionIcon('briefcase', 'blue', { size: 'sm' }), 'Sourced opportunities'),
    stats,
    listEl,
  );
}

async function handleDelete(event) {
  const confirmed = await confirmDialog(
    'Delete Event',
    `Are you sure you want to delete "${event.title}"? This action cannot be undone.`
  );
  if (!confirmed) return;

  try {
    await deleteRowById(CONFIG.SHEET_EVENTS, 'event_id', event.event_id);
    showToast('Event deleted', 'success');
    reRender();
  } catch (err) {
    showToast(err.message || 'Failed to delete event', 'error');
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function cleanup() {
  cachedPartners = null;
  cachedEvents = null;
  destroyPlaybookPanel();
}
