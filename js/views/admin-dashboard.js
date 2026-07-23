// ============================================
// Admin Dashboard View — Command Center
// ============================================

import { readSheetAsObjects } from '../sheets.js';
import { CONFIG } from '../config.js';
import { el, mount, formatCurrency, debounce } from '../utils/dom.js';
import { navigate } from '../router.js';
import { setTopbar, setTopbarTitle } from '../components/sidebar.js';
import { tierSlug, TIER_COLORS, TIER_ICONS } from '../utils/tiers.js';
import { formatDate } from '../utils/date.js';
import { openEventModal } from './admin-events.js';
import { filterPartners, filterOpportunities, filterEvents } from '../utils/filters.js';
import { loadTypeFilter, saveTypeFilter, computeTypeData, buildTypeFilterBar, applyTypeFilter } from '../components/type-filter.js';
import { mountQuickFormInline, unmountQuickFormInline } from '../components/quick-form.js';

export const title = 'Admin Dashboard';

let mapInstance = null;
let mapMarkers = [];

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
  'Webinar': '#2F6BFF',
  'Workshop': '#2F6BFF',
  'Conference': '#171D2B',
  'Campaign': '#B97A1A',
  'Other': '#4A5468',
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
const CHART_BAR_COLOR = '#2F6BFF';

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

export async function render(container) {
  setTopbarTitle('Dashboard');
  mount(container, el('div', { class: 'loading-overlay' }, el('div', { class: 'spinner' })));

  try {
    const [partners, opportunities, events] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_PARTNERS),
      readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
      readSheetAsObjects(CONFIG.SHEET_EVENTS),
    ]);
    renderDashboard(container, partners, opportunities, events);
  } catch (err) {
    mount(container, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'Error loading data'),
      el('div', { class: 'empty-state__description' }, err.message)
    ));
  }
}

function renderDashboard(container, partners, opportunities, events) {
  // --- Base filtered lists (admin/inactive/cancelled excluded) ---
  const partnerList = filterPartners(partners);
  const filteredOpps = filterOpportunities(opportunities);
  const filteredEvents = filterEvents(events);

  // --- Type filter (multi-select, persisted in localStorage) ---
  const selectedTypes = loadTypeFilter();

  // Unfiltered type data for button labels (always show full counts)
  const allTypeData = computeTypeData(partnerList, filteredOpps);
  const allUniqueTypes = Object.keys(allTypeData);
  const allTotalPipeline = filteredOpps.reduce((sum, o) => sum + (parseFloat(o.deal_value) || 0), 0);

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
    };
  }).sort((a, b) => b.stats.totalValue - a.stats.totalValue);

  // Type distribution data (type-filtered, for partners view)
  const typeData = computeTypeData(tfPartners, tfOpps);
  const uniqueTypes = Object.keys(typeData);

  // --- Type filter button bar (shared module) ---
  const typeFilterBar = buildTypeFilterBar({
    allUniqueTypes, allTypeData, allTotalPipeline, validSelected,
    onChanged: () => renderDashboard(container, partners, opportunities, events),
  });

  // Tab state
  let activeTab = 'activity';

  // Tab buttons
  const activityTabBtn = el('button', {
    class: 'btn btn--primary btn--sm',
    onClick: () => switchTab('activity'),
  }, 'Activity Hub');

  const partnersTabBtn = el('button', {
    class: 'btn btn--secondary btn--sm',
    onClick: () => switchTab('partners'),
  }, 'Partners');

  // Tab containers
  const activityView = el('div', { id: 'dashboard-activity-view' });
  const partnersView = el('div', { id: 'dashboard-partners-view', style: { display: 'none' } });

  function switchTab(tab) {
    activeTab = tab;
    activityTabBtn.className = tab === 'activity' ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
    partnersTabBtn.className = tab === 'partners' ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
    activityView.style.display = tab === 'activity' ? '' : 'none';
    partnersView.style.display = tab === 'partners' ? '' : 'none';

    if (tab === 'partners' && !partnersView.hasChildNodes()) {
      buildPartnersView(partnersView, tfPartners, partnerStats, typeData, uniqueTypes, tfTotalPipeline, tfOpps);
    }
  }

  // Build activity view content (partner activity cards). The Upcoming
  // Joint Events timeline now lives in the top split's left column, so it
  // is no longer rendered inside the Activity Hub tab.
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

  // Partner bar click handler — filters Activity Hub to that partner
  let activeBarPartner = null;
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
  }

  // Topbar header: eyebrow title + meta + type-filter chips
  const partnersLabel = tfPartners.length === 1 ? '1 partner' : `${tfPartners.length} partners`;
  const meta = `· ${partnersLabel} · ${formatCurrency(tfTotalPipeline)} pipeline · ${formatCurrency(tfWonValue)} won`;
  setTopbar({
    title: 'Dashboard',
    meta,
    chips: typeFilterBar,
  });

  // Right half of the split: host the singleton Quick Add form inline
  // (moved here from the dedicated Randy page). Mounted after the content
  // is in the DOM, below.
  const quickFormHost = el('div', { class: 'dashboard-page__quickform-host' });

  const content = el('div', { class: 'dashboard-page' },
    // Top zone: full-width KPI strip, then a 50/50 split. The left column
    // stacks the flat Opportunity Source chart above the Upcoming Joint
    // Events timeline, so it fills the height evenly beside the taller
    // Quick Add form on the right.
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
        quickFormHost,
      ),
    ),

    // Tabs + views (full width below)
    el('div', { class: 'view-toggle' }, activityTabBtn, partnersTabBtn),
    activityView,
    partnersView,
  );

  mount(container, content);

  // Embed the shared Quick Add form into the right half of the split. It's
  // the same singleton the floating Randy "Add" button uses; cleanup()
  // returns it to the body so that toggle keeps working elsewhere.
  mountQuickFormInline(quickFormHost);
}

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
    .map(({ partner, stats, upcomingEvents: partnerUpcoming }) => {
      const tc = tierSlug(partner.tier);
      const initials = (partner.display_name || '')
        .split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';

      const eventChips = partnerUpcoming.slice(0, 3).map(evt =>
        el('div', {
          class: 'activity-card__event-chip',
          onClick: (e) => {
            e.stopPropagation();
            openEventModal(evt, viewContainer);
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
  const now = new Date();
  const sixtyDaysOut = new Date(now);
  sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60);

  const timelineEvents = upcomingEvents
    .filter(evt => {
      const d = new Date(evt.event_date);
      return d >= now && d <= sixtyDaysOut;
    })
    .sort((a, b) => new Date(a.event_date) - new Date(b.event_date));

  const timelineTitle = el('div', { class: 'section-header' },
    el('div', {},
      el('h3', { class: 'section-header__title' }, 'Upcoming Joint Events'),
      el('p', { class: 'section-header__subtitle' },
        timelineEvents.length === 0
          ? 'Next 60 days'
          : `${timelineEvents.length} event${timelineEvents.length === 1 ? '' : 's'} in the next 60 days`
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
      onClick: () => openEventModal(evt, viewContainer),
    },
      el('div', { class: 'timeline-card__date-col' },
        el('div', { class: 'timeline-card__month' },
          new Date(evt.event_date).toLocaleDateString('en-US', { month: 'short' })
        ),
        el('div', { class: 'timeline-card__day' },
          String(parseInt((evt.event_date || '').split('-')[2], 10) || new Date(evt.event_date).getDate())
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
        el('div', { class: 'empty-state__description' }, 'Events in the next 60 days will appear here.')
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
      el('div', { class: 'type-card__color', style: { background: '#2F6BFF' } }),
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
    const color = TIER_COLORS[tc] || '#2F6BFF';

    const icon = L.divIcon({
      className: 'map-marker',
      html: `<div class="map-marker__pin" style="background:${color}">
        <span>${(partner.display_name || '?').slice(0, 2).toUpperCase()}</span>
      </div>`,
      iconSize: [36, 44],
      iconAnchor: [18, 44],
      popupAnchor: [0, -46],
    });

    const marker = L.marker(coords, { icon }).addTo(mapInstance);
    marker.bindPopup(`
      <div class="map-popup">
        <div class="map-popup__name">${partner.display_name}</div>
        <div class="map-popup__row"><span class="map-popup__label">Type:</span> ${partner.partner_type || '—'}</div>
        <div class="map-popup__row"><span class="map-popup__label">Region:</span> ${partner.region || '—'}</div>
        <div class="map-popup__row"><span class="map-popup__label">HQ:</span> ${partner.hq_location}</div>
        <div class="map-popup__row"><span class="map-popup__label">Tier:</span> ${partner.tier || '—'}</div>
        <div class="map-popup__link"><a href="#/admin/partner-detail?id=${partner.partner_id}">View Partner →</a></div>
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
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  mapMarkers = [];
}
