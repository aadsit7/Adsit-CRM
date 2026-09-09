// ============================================
// Admin Dashboard View — Command Center
// ============================================

import { readSheetAsObjects } from '../sheets.js';
import { CONFIG } from '../config.js';
import { el, mount, formatCurrency, debounce } from '../utils/dom.js';
import { navigate, getCurrentPath } from '../router.js';
import { setTopbar, setTopbarTitle } from '../components/sidebar.js';
import { tierSlug, TIER_COLORS, TIER_ICONS } from '../utils/tiers.js';
import { formatDate, parseDate } from '../utils/date.js';
import { openEventModal } from './admin-events.js';
import { filterPartners, filterOpportunities, filterEvents } from '../utils/filters.js';
import { loadTypeFilter, saveTypeFilter, computeTypeData, buildTypeFilterBar, applyTypeFilter } from '../components/type-filter.js';
import { mountQuickFormInline, unmountQuickFormInline, QUICK_FORM_SAVED_EVENT } from '../components/quick-form.js';
import { openModal, closeModal } from '../components/modal.js';
import { sanitizeHtml } from '../utils/sanitize-html.js';
import { ensureHtml, stripHtml } from '../components/quill-editor.js';

export const title = 'Admin Dashboard';

let mapInstance = null;
let mapMarkers = [];

// Activity Hub / Partners tab. Module-level so an in-place repaint (type
// filter click, a Quick Add save) keeps the tab the user was on; reset in
// cleanup() so a fresh visit always opens on Activity Hub.
let activeTabState = 'activity';

// Quick Add lives at the bottom of this page. When it writes a row, the
// dashboard re-reads the sheets and repaints in place so the new note, deal,
// partner or event appears in the cards above without a manual reload.
let quickAddSavedHandler = null;
let refreshGeneration = 0;

// How many description notes each Partner Activity card shows.
const RECENT_NOTES_LIMIT = 3;

// How far ahead the Upcoming Joint Events timeline looks.
const UPCOMING_WINDOW_DAYS = 90;

// ============================================
// Partner Type Filter — localStorage helpers
// ============================================

const TYPE_COLORS = {
  'Technology':                'var(--color-primary-lighter)',
  'OEM':                       'var(--color-warning)',
  'MSP/SI':                    'var(--color-accent)',
  'MENA Regional Distributor': 'var(--color-danger)',
};

const EVENT_TYPE_COLORS = {
  'Webinar': '#0000CC',
  'Workshop': '#2222DD',
  'Conference': '#1A1A2E',
  'Campaign': '#CC8800',
  'Other': '#4A4A5A',
};

const HQ_COORDINATES = {
  'Edmonton, Alberta, Canada': [53.5461, -113.4938],
  'New Jersey, USA': [40.0583, -74.4057],
  'Bengaluru, India': [12.9716, 77.5946],
  'Chandler, Arizona, USA': [33.3062, -111.8413],
  'Redmond, Washington, USA': [47.6740, -122.1215],
  'Chicago, Illinois, USA': [41.8781, -87.6298],
  'San Diego, California, USA': [32.7157, -117.1611],
  'Dubai, UAE': [25.2048, 55.2708],
  'Montreal, Quebec, Canada': [45.5017, -73.5673],
  'Austin, Texas, USA': [30.2672, -97.7431],
};

// ============================================
// Demand Gen Dashboard Helpers
// ============================================

// Single brand-cyan fill for all bars per the Recast brief —
// consistent hue, no off-brand colors (was a 6-color rainbow palette).
const CHART_BAR_COLOR = '#0000CC';

function computePartnerSourceData(opportunities, partners) {
  const byPartner = {};
  for (const opp of opportunities) {
    const pid = opp.partner_id;
    if (!byPartner[pid]) byPartner[pid] = { total: 0 };
    const val = parseFloat(opp.deal_value) || 0;
    byPartner[pid].total += val;
  }

  return Object.entries(byPartner)
    .map(([pid, d]) => {
      const p = partners.find(p => p.partner_id === pid);
      return { name: p ? p.display_name : pid, total: d.total };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);
}

function buildPartnerSourceChart(opportunities, partners, onBarClick) {
  const data = computePartnerSourceData(opportunities, partners);

  if (data.length === 0) {
    return el('div', { class: 'dashboard-page__chart-card' },
      el('div', { class: 'dashboard-page__chart-title' }, 'Opportunity Source by Partner'),
      el('div', { class: 'dashboard-page__chart-subtitle' }, 'No opportunity data available')
    );
  }

  const maxVal = Math.max(...data.map(d => d.total));

  const rows = data.map(d => {
    const pct = maxVal > 0 ? (d.total / maxVal) * 100 : 0;

    return el('div', {
      class: 'dashboard-page__bar-row' + (onBarClick ? ' dashboard-page__bar-row--clickable' : ''),
      dataset: { partnerName: d.name },
      onClick: onBarClick ? () => onBarClick(d.name) : undefined,
    },
      el('div', { class: 'dashboard-page__bar-row__label', title: d.name }, d.name),
      el('div', { class: 'dashboard-page__bar-row__bar' },
        pct > 0 ? el('div', {
          class: 'dashboard-page__bar-row__segment',
          style: { width: pct + '%', background: CHART_BAR_COLOR },
          title: formatCurrency(d.total),
        }) : null,
      ),
      el('div', { class: 'dashboard-page__bar-row__value' }, formatCurrency(d.total)),
    );
  });

  return el('div', { class: 'dashboard-page__chart-card' },
    el('div', { class: 'dashboard-page__chart-title' }, 'Opportunity Source by Partner'),
    el('div', { class: 'dashboard-page__chart-subtitle' }, 'Top partners by deal value'),
    el('div', { class: 'dashboard-page__bar-list' }, ...rows),
  );
}

function buildDashboardStatCell(label, value, onClick) {
  return el('div', {
    class: 'dashboard-page__stat-cell dashboard-page__stat-cell--clickable',
    onClick,
  },
    el('div', { class: 'dashboard-page__stat-label' }, label),
    el('div', { class: 'dashboard-page__stat-value' }, String(value)),
  );
}

async function loadDashboardData() {
  const [partners, opportunities, events, transcripts] = await Promise.all([
    readSheetAsObjects(CONFIG.SHEET_PARTNERS),
    readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
    readSheetAsObjects(CONFIG.SHEET_EVENTS),
    // Description notes are optional — a workbook without the Transcripts
    // sheet still gets its dashboard, just without the notes rows.
    readSheetAsObjects(CONFIG.SHEET_TRANSCRIPTS).catch(() => []),
  ]);
  return { partners, opportunities, events, transcripts };
}

export async function render(container) {
  setTopbarTitle('Dashboard');
  mount(container, el('div', { class: 'loading-overlay' }, el('div', { class: 'spinner' })));

  try {
    const data = await loadDashboardData();
    renderDashboard(container, data);
  } catch (err) {
    mount(container, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'Error loading data'),
      el('div', { class: 'empty-state__description' }, err.message)
    ));
  }
}

// In-place repaint after a Quick Add save: no spinner, and the result is
// dropped if the user has left the route or a newer refresh has started.
async function refreshDashboard(container) {
  const generation = ++refreshGeneration;
  try {
    const data = await loadDashboardData();
    if (generation !== refreshGeneration) return;
    if (getCurrentPath() !== '/admin/dashboard' || !container.isConnected) return;
    renderDashboard(container, data);
  } catch (err) {
    // The row was saved (Quick Add already toasted); the cards just stay as
    // they were until the next visit.
    console.warn('Dashboard refresh after Quick Add save failed:', err);
  }
}

function bindQuickAddRefresh(container) {
  unbindQuickAddRefresh();
  quickAddSavedHandler = () => { refreshDashboard(container); };
  document.addEventListener(QUICK_FORM_SAVED_EVENT, quickAddSavedHandler);
}

function unbindQuickAddRefresh() {
  if (!quickAddSavedHandler) return;
  document.removeEventListener(QUICK_FORM_SAVED_EVENT, quickAddSavedHandler);
  quickAddSavedHandler = null;
}

function renderDashboard(container, data) {
  const { partners, opportunities, events, transcripts } = data;
  // An in-place re-render (type-filter click) replaces the DOM holding the
  // Leaflet map, but the module-level mapInstance survived — the next Map
  // View click then called invalidateSize() on a map bound to the detached
  // old node and the panel stayed blank until leaving the route. Tear the
  // old map down with its DOM.
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  mapMarkers = [];

  // --- Base filtered lists (admin/inactive/cancelled excluded) ---
  const partnerList = filterPartners(partners);
  const filteredOpps = filterOpportunities(opportunities);
  const filteredEvents = filterEvents(events);

  // --- Type filter (multi-select, persisted in localStorage) ---
  const selectedTypes = loadTypeFilter();

  // Unfiltered type data for button labels (always show full counts)
  const allTypeData = computeTypeData(partnerList, filteredOpps);
  const allUniqueTypes = Object.keys(allTypeData);
  // Excludes Won like the per-type chips (computeTypeData) and the
  // Partners page — the "All Types" figure used to include Won revenue
  // and disagree with the sum of the chips beside it.
  const allTotalPipeline = filteredOpps.filter(o => o.status !== 'Won').reduce((sum, o) => sum + (parseFloat(o.deal_value) || 0), 0);

  // Prune selectedTypes: remove any that no longer exist in the data
  const validSelected = selectedTypes.filter(t => allUniqueTypes.includes(t));
  if (validSelected.length !== selectedTypes.length) saveTypeFilter(validSelected);

  // Apply type filter
  const { partners: tfPartners, opportunities: tfOpps, events: tfEvents } = applyTypeFilter({
    partners: partnerList, opportunities: filteredOpps, events: filteredEvents, selected: validSelected,
  });
  const tfUpcoming = tfEvents.filter(e => e.status === 'Upcoming' || e.status === 'In Progress');

  const tfTotalPipeline = tfOpps
    .filter(o => o.status !== 'Won')
    .reduce((sum, o) => sum + (parseFloat(o.deal_value) || 0), 0);
  const tfWonValue = tfOpps
    .filter(o => o.status === 'Won')
    .reduce((sum, o) => sum + (parseFloat(o.deal_value) || 0), 0);

  // Per-partner stats (type-filtered)
  const partnerStats = tfPartners.map(partner => {
    const partnerOpps = tfOpps.filter(o => o.partner_id === partner.partner_id);
    const partnerEvents = tfEvents.filter(e => e.partner_id === partner.partner_id);
    const upcomingPartnerEvents = partnerEvents.filter(e => e.status === 'Upcoming' || e.status === 'In Progress');
    const total = partnerOpps.length;
    const pipelineVal = partnerOpps.filter(o => o.status !== 'Won').reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);
    const wonVal = partnerOpps.filter(o => o.status === 'Won').reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);
    return {
      partner,
      stats: { totalDeals: total, totalValue: pipelineVal, wonValue: wonVal },
      events: partnerEvents,
      upcomingEvents: upcomingPartnerEvents,
      notes: pickRecentNotes(transcripts, partner.partner_id, RECENT_NOTES_LIMIT),
    };
  }).sort((a, b) => b.stats.totalValue - a.stats.totalValue);

  // Type distribution data (type-filtered, for partners view)
  const typeData = computeTypeData(tfPartners, tfOpps);
  const uniqueTypes = Object.keys(typeData);

  // --- Type filter button bar (shared module) ---
  const typeFilterBar = buildTypeFilterBar({
    allUniqueTypes, allTypeData, allTotalPipeline, validSelected,
    onChanged: () => renderDashboard(container, data),
  });

  // Tab state — persisted across in-place repaints (see activeTabState).
  let activeTab = activeTabState;

  // Tab buttons (switchTab below sets the active class once mounted)
  const activityTabBtn = el('button', {
    class: 'btn btn--secondary btn--sm',
    onClick: () => switchTab('activity'),
  }, 'Activity Hub');

  const partnersTabBtn = el('button', {
    class: 'btn btn--secondary btn--sm',
    onClick: () => switchTab('partners'),
  }, 'Partners');

  // Tab containers, inside the hub's own scroll body (the hub is a bounded
  // panel beside the chart so the Quick Add form below stays within reach
  // no matter how many partners are active).
  const activityView = el('div', { id: 'dashboard-activity-view' });
  const partnersView = el('div', { id: 'dashboard-partners-view', style: { display: 'none' } });
  const hubBody = el('div', { class: 'dashboard-page__hub-body' }, activityView, partnersView);

  function switchTab(tab) {
    activeTab = tab;
    activeTabState = tab;
    activityTabBtn.className = tab === 'activity' ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
    partnersTabBtn.className = tab === 'partners' ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
    activityView.style.display = tab === 'activity' ? '' : 'none';
    partnersView.style.display = tab === 'partners' ? '' : 'none';

    if (tab === 'partners' && !partnersView.hasChildNodes()) {
      buildPartnersView(partnersView, tfPartners, partnerStats, typeData, uniqueTypes, tfTotalPipeline, tfOpps);
    }
  }

  // Build activity view content (partner activity cards with their joint
  // events and latest description notes). The Upcoming Joint Events
  // timeline lives in the top split's left column, not in this tab.
  buildActivityView(activityView, partnerStats, container);

  // Interactive stat card handlers
  let activeStatKey = '';
  function toggleStat(key) {
    if (activeStatKey === key) { activeStatKey = ''; } else { activeStatKey = key; }
    document.querySelectorAll('.dashboard-page__stat-strip .dashboard-page__stat-cell').forEach(cell => {
      cell.classList.remove('dashboard-page__stat-cell--active');
    });
    if (activeStatKey === 'partners') { switchTab('partners'); }
    else if (activeStatKey === 'pipeline') { switchTab('activity'); }
    else if (activeStatKey === 'events') {
      // The Upcoming Joint Events panel lives in the top split (always
      // visible), so just scroll it into view — no tab switch needed.
      const panel = document.querySelector('.dashboard-page__events-panel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (activeStatKey) {
      const keyMap = { partners: 0, pipeline: 1, won: 2, events: 3 };
      const cells = document.querySelectorAll('.dashboard-page__stat-strip .dashboard-page__stat-cell');
      if (cells[keyMap[activeStatKey]]) cells[keyMap[activeStatKey]].classList.add('dashboard-page__stat-cell--active');
    }
  }

  // Partner bar click handler — filters Activity Hub to that partner. The
  // hub header names the active filter and offers a way back, so a list
  // narrowed by a chart click never reads as "partners went missing".
  let activeBarPartner = null;
  const hubFilterName = el('span', { class: 'dashboard-page__hub-filter__name' });
  const hubFilter = el('div', { class: 'dashboard-page__hub-filter', hidden: true },
    el('span', { class: 'dashboard-page__hub-filter__label' }, 'Showing'),
    hubFilterName,
    el('button', {
      type: 'button',
      class: 'dashboard-page__hub-filter__clear',
      onClick: () => { if (activeBarPartner) onBarClick(activeBarPartner); },
    }, 'Show all'),
  );

  function onBarClick(partnerName) {
    if (activeBarPartner === partnerName) { activeBarPartner = null; } else { activeBarPartner = partnerName; }
    document.querySelectorAll('.dashboard-page__bar-row--clickable').forEach(row => {
      row.classList.toggle('dashboard-page__bar-row--active', row.dataset.partnerName === activeBarPartner);
    });
    switchTab('activity');
    const activityCards = activityView.querySelectorAll('.activity-card');
    activityCards.forEach(card => {
      const name = card.querySelector('.activity-card__name');
      if (!activeBarPartner || (name && name.textContent === activeBarPartner)) {
        card.style.display = '';
      } else {
        card.style.display = 'none';
      }
    });
    hubFilterName.textContent = activeBarPartner || '';
    hubFilter.hidden = !activeBarPartner;
    hubBody.scrollTop = 0;
  }

  // Topbar header: eyebrow title + meta + type-filter chips
  const partnersLabel = tfPartners.length === 1 ? '1 partner' : `${tfPartners.length} partners`;
  const meta = `· ${partnersLabel} · ${formatCurrency(tfTotalPipeline)} pipeline · ${formatCurrency(tfWonValue)} won`;
  setTopbar({
    title: 'Dashboard',
    meta,
    chips: typeFilterBar,
  });

  // Bottom band: host for the singleton Quick Add form (the same panel the
  // floating Randy "Add" button uses). Mounted after the content is in the
  // DOM, below.
  const quickFormHost = el('div', { class: 'dashboard-page__quickform-host' });

  // Right half of the split: the Activity Hub / Partners panel. Tabs sit in
  // a fixed header; the views scroll inside the panel body.
  const hub = el('section', { class: 'dashboard-page__hub', 'aria-label': 'Activity Hub' },
    el('div', { class: 'dashboard-page__hub-header' },
      el('div', { class: 'view-toggle dashboard-page__hub-tabs' }, activityTabBtn, partnersTabBtn),
      hubFilter,
    ),
    hubBody,
  );

  const content = el('div', { class: 'dashboard-page' },
    // Top zone: full-width KPI strip, then a 50/50 split. The left column
    // stacks the flat Opportunity Source chart above the Upcoming Joint
    // Events timeline; the right column is the Activity Hub panel, capped
    // to the viewport so Quick Add below is always one scroll away.
    el('div', { class: 'dashboard-page__top' },
      el('div', { class: 'dashboard-page__stat-strip stagger' },
        buildDashboardStatCell('Total Partners', tfPartners.length, () => toggleStat('partners')),
        buildDashboardStatCell('Total Pipeline', formatCurrency(tfTotalPipeline), () => toggleStat('pipeline')),
        buildDashboardStatCell('Revenue Won', formatCurrency(tfWonValue), () => toggleStat('won')),
        buildDashboardStatCell('Upcoming Events', tfUpcoming.length, () => toggleStat('events')),
      ),
      el('div', { class: 'dashboard-page__split' },
        el('div', { class: 'dashboard-page__split-left' },
          buildPartnerSourceChart(tfOpps, tfPartners, onBarClick),
          buildUpcomingEventsPanel(tfUpcoming, partnerStats, container),
        ),
        hub,
      ),
    ),

    // Quick Add — full width at the bottom of the page.
    el('section', { class: 'dashboard-page__quickadd', 'aria-label': 'Quick Add' }, quickFormHost),
  );

  mount(container, content);

  // Apply the (possibly persisted) tab now that the views are in the DOM.
  switchTab(activeTab);

  // Embed the shared Quick Add form into the bottom band. cleanup() returns
  // it to the body so the floating Randy "Add" toggle keeps working on
  // other pages.
  mountQuickFormInline(quickFormHost);
  bindQuickAddRefresh(container);
}

// ============================================
// Description notes (Transcripts rows) shown on the activity cards
// ============================================

function noteTime(note) {
  // Same ordering key the partner page's Descriptions section sorts by, so
  // "the last three" here are the top three there.
  const t = new Date(note.conversation_date || note.created_at || '').getTime();
  return Number.isNaN(t) ? 0 : t;
}

function noteCreatedTime(note) {
  const t = new Date(note.created_at || '').getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The newest `limit` non-empty description notes for one partner, newest
 * first. Ties on conversation date fall back to created_at so two notes
 * logged the same day keep the order they were written in.
 */
function pickRecentNotes(transcripts, partnerId, limit = RECENT_NOTES_LIMIT) {
  const pid = String(partnerId || '').trim();
  if (!pid || !Array.isArray(transcripts)) return [];
  return transcripts
    .filter(t => t && String(t.partner_id || '').trim() === pid)
    .filter(t => stripHtml(t.transcript_text || '').trim() !== '')
    .sort((a, b) => (noteTime(b) - noteTime(a)) || (noteCreatedTime(b) - noteCreatedTime(a)))
    .slice(0, limit);
}

/** One-line plain-text preview of a note's rich text. */
function notePreview(note, maxChars = 140) {
  const text = stripHtml(note.transcript_text || '').replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars - 1).trimEnd() + '\u2026' : text;
}

function noteDateLabel(note) {
  const conv = formatDate(note.conversation_date);
  return conv !== '\u2014' ? conv : formatDate(note.created_at);
}

function partnerInitials(partner) {
  return (partner.display_name || '')
    .split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
}

// Read-only viewer for a note chip: the full rich text, who it belongs to,
// and a jump to the partner page where it can be edited.
function openNoteModal(note, partner) {
  const tc = tierSlug(partner.tier);
  const dateLabel = noteDateLabel(note);
  openModal({
    title: `Description Note \u00B7 ${dateLabel}`,
    className: 'modal--wide dashboard-note-modal',
    content: el('div', { class: 'dashboard-note-view' },
      el('div', { class: 'dashboard-note-view__meta' },
        el('div', { class: `partner-avatar partner-avatar--${tc} partner-avatar--sm` }, partnerInitials(partner)),
        el('div', { class: 'dashboard-note-view__who' },
          el('div', { class: 'dashboard-note-view__partner' }, partner.display_name),
          el('div', { class: 'dashboard-note-view__date' }, `Logged ${dateLabel}`),
        ),
      ),
      el('div', {
        class: 'transcript-card__text dashboard-note-view__text',
        html: sanitizeHtml(ensureHtml(note.transcript_text || '')),
      }),
    ),
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Close'),
      el('button', {
        class: 'btn btn--primary',
        onClick: () => {
          closeModal();
          navigate(`/admin/partner-detail?id=${partner.partner_id}`);
        },
      }, 'Open Partner'),
    ],
  });
}

const NOTE_CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

function buildNoteChip(note, partner) {
  const dateLabel = noteDateLabel(note);
  return el('button', {
    type: 'button',
    class: 'activity-card__note',
    title: `Open the description note of ${dateLabel}`,
    onClick: (e) => {
      e.stopPropagation();
      openNoteModal(note, partner);
    },
  },
    el('span', { class: 'activity-card__note-date' }, dateLabel),
    el('span', { class: 'activity-card__note-text' }, notePreview(note)),
    el('span', { class: 'activity-card__note-arrow', html: NOTE_CHEVRON_SVG }),
  );
}

// Exposed for unit tests (same hook pattern as __partnerViewInternals).
export const __dashboardInternals = { pickRecentNotes, notePreview, noteDateLabel, RECENT_NOTES_LIMIT, UPCOMING_WINDOW_DAYS };

// ============================================
// Activity Hub View
// ============================================

function buildActivityView(container, partnerStats, viewContainer) {
  const activePartners = partnerStats.filter(ps => ps.stats.totalDeals > 0 || ps.upcomingEvents.length > 0);

  // Partner Activity Cards
  const partnerHubTitle = el('div', { class: 'section-header' },
    el('div', {},
      el('h3', { class: 'section-header__title' }, 'Partner Activity'),
      el('p', { class: 'section-header__subtitle' },
        `${activePartners.length} partner${activePartners.length === 1 ? '' : 's'} with active deals or upcoming events`
      )
    )
  );

  const partnerCards = activePartners
    .map(({ partner, stats, upcomingEvents: partnerUpcoming, notes = [] }) => {
      const tc = tierSlug(partner.tier);
      const initials = partnerInitials(partner);

      const eventChips = partnerUpcoming.slice(0, 3).map(evt =>
        el('div', {
          class: 'activity-card__event-chip',
          onClick: (e) => {
            e.stopPropagation();
            // onSaved refreshes THIS view: openEventModal's default repaint
            // targets the Events page, which is not on screen here.
            openEventModal(evt, viewContainer, () => {
              if (getCurrentPath() === '/admin/dashboard') render(viewContainer);
            });
          },
        },
          el('span', {
            class: 'activity-card__event-dot',
            style: { background: EVENT_TYPE_COLORS[evt.event_type] || 'var(--color-text-muted)' },
          }),
          el('span', {
            class: 'activity-card__event-type-badge',
            style: { background: EVENT_TYPE_COLORS[evt.event_type] || 'var(--color-text-muted)' },
          }, evt.event_type),
          el('span', { class: 'activity-card__event-name' }, evt.title),
          el('span', { class: 'activity-card__event-date' }, formatDate(evt.event_date))
        )
      );

      if (partnerUpcoming.length > 3) {
        eventChips.push(el('div', { class: 'activity-card__event-more' },
          `+${partnerUpcoming.length - 3} more events`
        ));
      }

      return el('div', {
        class: 'activity-card',
        onClick: () => navigate(`/admin/partner-detail?id=${partner.partner_id}`),
      },
        el('div', { class: 'activity-card__header' },
          el('div', { class: `partner-avatar partner-avatar--${tc} partner-avatar--sm` }, initials),
          el('div', { class: 'activity-card__info' },
            el('div', { class: 'activity-card__name' }, partner.display_name),
            el('div', { class: 'activity-card__type' },
              el('span', { class: `badge badge--xs badge--${tc}` },
                el('span', { class: 'badge__icon', html: TIER_ICONS[tc] || '' }),
                partner.tier
              ),
              el('span', { class: 'activity-card__partner-type' }, partner.partner_type)
            )
          )
        ),
        el('div', { class: 'activity-card__metrics' },
          el('div', { class: 'activity-card__metric' },
            el('div', { class: 'activity-card__metric-value' }, String(stats.totalDeals)),
            el('div', { class: 'activity-card__metric-label' }, 'Deals')
          ),
          el('div', { class: 'activity-card__metric' },
            el('div', { class: 'activity-card__metric-value' }, formatCurrency(stats.totalValue)),
            el('div', { class: 'activity-card__metric-label' }, 'Pipeline')
          ),
          stats.wonValue > 0 ? el('div', { class: 'activity-card__metric' },
            el('div', { class: 'activity-card__metric-value' }, formatCurrency(stats.wonValue)),
            el('div', { class: 'activity-card__metric-label' }, 'Won')
          ) : null,
          el('div', { class: 'activity-card__metric' },
            el('div', { class: 'activity-card__metric-value' }, String(partnerUpcoming.length)),
            el('div', { class: 'activity-card__metric-label' }, 'Events')
          ),
        ),
        partnerUpcoming.length > 0
          ? el('div', { class: 'activity-card__events' },
              el('div', { class: 'activity-card__events-title' }, 'Joint Events'),
              ...eventChips
            )
          : null,
        // Latest description notes, each opening a read-only viewer. Sits
        // beneath Joint Events (or where Joint Events would be).
        notes.length > 0
          ? el('div', { class: 'activity-card__notes' },
              el('div', { class: 'activity-card__notes-title' },
                notes.length === 1 ? 'Latest Description Note' : 'Latest Description Notes'
              ),
              ...notes.map(note => buildNoteChip(note, partner)),
            )
          : null
      );
    });

  container.appendChild(partnerHubTitle);

  if (partnerCards.length > 0) {
    container.appendChild(el('div', { class: 'activity-grid' }, ...partnerCards));
  } else {
    container.appendChild(el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'No partner activity yet'),
      el('div', { class: 'empty-state__description' }, 'Deals and events will appear here.')
    ));
  }
}

// ============================================
// Upcoming Joint Events Panel
// Rendered in the dashboard top split's left column, stacked beneath the
// Opportunity Source chart (previously lived at the bottom of the
// Activity Hub tab).
// ============================================

function buildUpcomingEventsPanel(upcomingEvents, partnerStats, viewContainer) {
  // parseDate, not new Date('YYYY-MM-DD'): the bare form parses as UTC
  // midnight, which in US timezones lands the previous local day — so an
  // event happening TODAY was excluded from this panel (while the KPI
  // counted it), and the month badge below showed "Sep" for an Oct 1 event.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(todayStart);
  windowEnd.setDate(windowEnd.getDate() + UPCOMING_WINDOW_DAYS);

  const timelineEvents = upcomingEvents
    .filter(evt => {
      const d = parseDate(evt.event_date);
      return d && d >= todayStart && d <= windowEnd;
    })
    .sort((a, b) => (parseDate(a.event_date) || 0) - (parseDate(b.event_date) || 0));

  const timelineTitle = el('div', { class: 'section-header' },
    el('div', {},
      el('h3', { class: 'section-header__title' }, 'Upcoming Joint Events'),
      el('p', { class: 'section-header__subtitle' },
        timelineEvents.length === 0
          ? `Next ${UPCOMING_WINDOW_DAYS} days`
          : `${timelineEvents.length} event${timelineEvents.length === 1 ? '' : 's'} in the next ${UPCOMING_WINDOW_DAYS} days`
      )
    )
  );

  const getPartnerName = (pid) => {
    if (!pid) return 'All Partners';
    const ps = partnerStats.find(p => p.partner.partner_id === pid);
    return ps ? ps.partner.display_name : pid;
  };

  const timelineCards = timelineEvents.map(evt => {
    return el('div', {
      class: 'timeline-card',
      onClick: () => openEventModal(evt, viewContainer, () => {
        if (getCurrentPath() === '/admin/dashboard') render(viewContainer);
      }),
    },
      el('div', { class: 'timeline-card__date-col' },
        el('div', { class: 'timeline-card__month' },
          (parseDate(evt.event_date) || new Date()).toLocaleDateString('en-US', { month: 'short' })
        ),
        el('div', { class: 'timeline-card__day' },
          String(parseInt((evt.event_date || '').split('-')[2], 10) || (parseDate(evt.event_date) || new Date()).getDate())
        )
      ),
      el('div', { class: 'timeline-card__content' },
        el('div', { class: 'timeline-card__title' }, evt.title),
        el('div', { class: 'timeline-card__details' },
          el('span', {
            class: 'badge badge--xs',
            style: { background: EVENT_TYPE_COLORS[evt.event_type] || 'var(--color-text-muted)', color: '#fff' }
          }, evt.event_type),
          el('span', { class: 'timeline-card__partner' }, getPartnerName(evt.partner_id)),
          evt.location
            ? el('span', { class: 'timeline-card__location' }, evt.location)
            : null,
        )
      )
    );
  });

  const body = timelineCards.length > 0
    ? el('div', { class: 'timeline-list' }, ...timelineCards)
    : el('div', { class: 'empty-state' },
        el('div', { class: 'empty-state__title' }, 'No upcoming events'),
        el('div', { class: 'empty-state__description' }, `Events in the next ${UPCOMING_WINDOW_DAYS} days will appear here.`)
      );

  return el('div', { class: 'dashboard-page__events-panel' }, timelineTitle, body);
}

// ============================================
// Partners View (Grid + Map — original dashboard)
// ============================================

function buildPartnersView(container, partnerList, partnerStats, typeData, uniqueTypes, totalPipeline, opportunities) {
  // Build thumbnail elements
  const thumbElements = partnerStats.map(({ partner, stats }) => partnerThumbnail(partner, stats));

  // Filter state
  let activeFilter = 'all';

  // Search bar
  const searchInput = el('input', {
    class: 'form-input',
    type: 'text',
    placeholder: 'Search partners...',
    style: { maxWidth: '320px' },
  });

  function filterPartners() {
    const query = searchInput.value.toLowerCase().trim();
    thumbElements.forEach((thumb, i) => {
      const partner = partnerStats[i].partner;
      const matchesSearch = !query || partner.display_name.toLowerCase().includes(query);
      const matchesType = activeFilter === 'all' || partner.partner_type === activeFilter;
      thumb.style.display = (matchesSearch && matchesType) ? '' : 'none';
    });
    updateMapMarkers();
  }

  const onSearch = debounce(filterPartners, 200);
  searchInput.addEventListener('input', onSearch);

  // Type breakdown cards
  const typeCards = [];
  const allCard = el('div', {
    class: 'type-card type-card--active',
    onClick: () => applyFilter('all'),
  },
    el('div', { class: 'type-card__header' },
      el('div', { class: 'type-card__color', style: { background: '#0000CC' } }),
      el('div', { class: 'type-card__name' }, 'All Types')
    ),
    el('div', { class: 'type-card__count' }, String(partnerList.length)),
    el('div', { class: 'type-card__pipeline' }, formatCurrency(totalPipeline) + ' pipeline')
  );
  allCard.dataset.type = 'all';
  typeCards.push(allCard);

  uniqueTypes.forEach(type => {
    const d = typeData[type];
    const card = el('div', {
      class: 'type-card',
      onClick: () => applyFilter(type),
    },
      el('div', { class: 'type-card__header' },
        el('div', { class: 'type-card__color', style: { background: TYPE_COLORS[type] || 'var(--color-text-muted)' } }),
        el('div', { class: 'type-card__name' }, type)
      ),
      el('div', { class: 'type-card__count' }, String(d.count)),
      el('div', { class: 'type-card__pipeline' }, formatCurrency(d.pipeline) + ' pipeline')
    );
    card.dataset.type = type;
    typeCards.push(card);
  });

  function applyFilter(type) {
    activeFilter = type;
    typeCards.forEach(c => {
      c.classList.toggle('type-card--active', c.dataset.type === type);
    });
    filterPartners();
  }

  // Donut chart
  const donut = buildDonut(partnerList, typeData);

  // View toggle buttons
  const gridBtn = el('button', {
    class: 'btn btn--primary btn--sm',
    onClick: () => switchView('grid'),
  }, 'Grid View');

  const mapBtn = el('button', {
    class: 'btn btn--secondary btn--sm',
    onClick: () => switchView('map'),
  }, 'Map View');

  // Grid view container
  const gridView = el('div', { id: 'dashboard-grid-view' },
    el('div', { style: { marginBottom: 'var(--space-6)' } }, searchInput),
    partnerList.length > 0
      ? el('div', { class: 'partner-thumb-grid stagger' }, ...thumbElements)
      : el('div', { class: 'empty-state' },
          el('div', { class: 'empty-state__title' }, 'No partners yet'),
          el('div', { class: 'empty-state__description' }, 'Add partners to get started.')
        )
  );

  // Map view container
  const mapView = el('div', { id: 'dashboard-map-view', style: { display: 'none' } },
    el('div', { id: 'leaflet-map', class: 'leaflet-map-container' })
  );

  container.appendChild(
    el('div', {},
      // Type distribution section
      el('div', { class: 'type-distribution' },
        donut,
        el('div', { class: 'type-breakdown' }, ...typeCards)
      ),

      // View toggle
      el('div', { class: 'view-toggle' }, gridBtn, mapBtn),

      // Views
      gridView,
      mapView,
    )
  );

  function switchView(view) {
    const gv = document.getElementById('dashboard-grid-view');
    const mv = document.getElementById('dashboard-map-view');
    if (!gv || !mv) return;

    if (view === 'map') {
      gv.style.display = 'none';
      mv.style.display = 'block';
      gridBtn.className = 'btn btn--secondary btn--sm';
      mapBtn.className = 'btn btn--primary btn--sm';

      if (!mapInstance) {
        setTimeout(() => { initMap(partnerList); updateMapMarkers(); }, 50);
      } else {
        mapInstance.invalidateSize();
        updateMapMarkers();
      }
    } else {
      gv.style.display = '';
      mv.style.display = 'none';
      gridBtn.className = 'btn btn--primary btn--sm';
      mapBtn.className = 'btn btn--secondary btn--sm';
    }
  }

  function updateMapMarkers() {
    if (!mapInstance) return;
    mapMarkers.forEach(({ marker, partner }) => {
      const visible = activeFilter === 'all' || partner.partner_type === activeFilter;
      if (visible) {
        marker.addTo(mapInstance);
      } else {
        marker.remove();
      }
    });
  }
}

function buildDonut(partnerList, typeData) {
  const total = partnerList.length;
  if (total === 0) {
    return el('div', { class: 'type-donut', style: { background: 'var(--color-border-light)' } },
      el('div', { class: 'type-donut__hole' },
        el('div', { class: 'type-donut__total' }, '0'),
        el('div', { class: 'type-donut__label' }, 'Partners')
      )
    );
  }

  let cumulative = 0;
  const stops = [];
  for (const [type, d] of Object.entries(typeData)) {
    const start = cumulative;
    cumulative += (d.count / total) * 360;
    const color = TYPE_COLORS[type] || 'var(--color-text-muted)';
    stops.push(`${color} ${start}deg ${cumulative}deg`);
  }

  return el('div', { class: 'type-donut', style: {
    background: `conic-gradient(${stops.join(', ')})`
  }},
    el('div', { class: 'type-donut__hole' },
      el('div', { class: 'type-donut__total' }, String(total)),
      el('div', { class: 'type-donut__label' }, 'Partners')
    )
  );
}

function initMap(partners) {
  const mapEl = document.getElementById('leaflet-map');
  if (!mapEl || !window.L) return;

  mapInstance = L.map(mapEl).setView([25, 0], 2);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(mapInstance);

  mapMarkers = [];

  partners.forEach(partner => {
    const loc = partner.hq_location;
    if (!loc) return;

    const coords = HQ_COORDINATES[loc];
    if (!coords) return;

    const tc = tierSlug(partner.tier);
    const color = TIER_COLORS[tc] || '#0000CC';

    const icon = L.divIcon({
      className: 'map-marker',
      html: `<div class="map-marker__pin" style="background:${color}; --pin-color:${color}">
        <span>${(partner.display_name || '?').slice(0, 2).toUpperCase()}</span>
      </div>`,
      iconSize: [36, 44],
      iconAnchor: [18, 44],
      popupAnchor: [0, -46],
    });

    // Popup content is raw HTML to Leaflet — partner fields are sheet data,
    // so they are escaped like every other render path in this file.
    const escAttr = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const marker = L.marker(coords, { icon }).addTo(mapInstance);
    marker.bindPopup(`
      <div class="map-popup">
        <div class="map-popup__name">${escAttr(partner.display_name)}</div>
        <div class="map-popup__row"><span class="map-popup__label">Type:</span> ${escAttr(partner.partner_type || '—')}</div>
        <div class="map-popup__row"><span class="map-popup__label">Region:</span> ${escAttr(partner.region || '—')}</div>
        <div class="map-popup__row"><span class="map-popup__label">HQ:</span> ${escAttr(partner.hq_location)}</div>
        <div class="map-popup__row"><span class="map-popup__label">Tier:</span> ${escAttr(partner.tier || '—')}</div>
        <div class="map-popup__link"><a href="#/admin/partner-detail?id=${encodeURIComponent(partner.partner_id || '')}">View Partner →</a></div>
      </div>
    `, { maxWidth: 250 });

    mapMarkers.push({ marker, partner });
  });

  if (mapMarkers.length > 0) {
    const group = L.featureGroup(mapMarkers.map(m => m.marker));
    mapInstance.fitBounds(group.getBounds().pad(0.3));
  }
}

function partnerThumbnail(partner, stats) {
  const tc = tierSlug(partner.tier);
  const initials = (partner.display_name || '')
    .split(/\s+/)
    .map(w => w[0] || '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';

  return el('div', {
    class: 'partner-thumb',
    onClick: () => navigate(`/admin/partner-detail?id=${partner.partner_id}`),
  },
    el('div', { class: `partner-avatar partner-avatar--${tc}` }, initials),
    el('div', { class: 'partner-thumb__name' }, partner.display_name),
    el('span', { class: `badge badge--xs badge--${tc}` },
      el('span', { class: 'badge__icon', html: TIER_ICONS[tc] || '' }),
      partner.tier
    ),
    partner.hq_location
      ? el('div', { class: 'partner-thumb__location' }, partner.hq_location)
      : null,
    el('div', { class: 'partner-thumb__stats' },
      `${stats.totalDeals} deals \u00B7 ${formatCurrency(stats.totalValue)}`
    )
  );
}

export function cleanup() {
  // Return the shared Quick Add form to the body so the floating Randy
  // "Add" button toggle keeps working on other pages.
  unmountQuickFormInline();
  unbindQuickAddRefresh();
  refreshGeneration++; // drop any in-flight refresh
  activeTabState = 'activity';
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  mapMarkers = [];
}
