// ============================================
// Admin Partner Management View
// ============================================

import { readSheetAsObjects, appendRow, updateRowById, deleteRowById, isConfigured, addDemoRow } from '../sheets.js';
import { CONFIG } from '../config.js';
import { sha256 } from '../utils/hash.js';
import { el, mount, uuid, $, debounce, formatCurrency, collapsibleSection } from '../utils/dom.js';
import { navigate } from '../router.js';
import { nowISO, formatDate } from '../utils/date.js';
import { tierSlug, TIER_OPTIONS, TIER_COLORS } from '../utils/tiers.js';
import { openModal, closeModal, confirmDialog } from '../components/modal.js';
import { buildForm } from '../components/form.js';
import { showToast } from '../components/toast.js';
import { setTopbarTitle } from '../components/sidebar.js';
import { filterPartners } from '../utils/filters.js';
import { loadTypeFilter, saveTypeFilter, computeTypeData, buildTypeFilterBar, applyTypeFilter } from '../components/type-filter.js';

export const title = 'Partners';

let allPartners = [];
let allOpportunities = [];
let partnerRevenue = {};

export async function render(container) {
  setTopbarTitle('Partner Management');

  mount(container, el('div', { class: 'loading-overlay' }, el('div', { class: 'spinner' })));

  try {
    await loadPartnerData();
    renderWithTypeFilter(container);
  } catch (err) {
    mount(container, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'Error loading partners'),
      el('div', { class: 'empty-state__description' }, err.message)
    ));
  }
}

// Pull the sheets this view renders from into module state. Split out of
// render() so a re-render after a mutation can refresh them too — see
// reRender().
async function loadPartnerData() {
  const [partners, opportunities] = await Promise.all([
    readSheetAsObjects(CONFIG.SHEET_PARTNERS),
    readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
  ]);
  allPartners = partners;
  allOpportunities = opportunities;

  // Compute revenue lookup per partner
  partnerRevenue = {};
  for (const opp of opportunities) {
    const pid = opp.partner_id;
    if (!partnerRevenue[pid]) partnerRevenue[pid] = { totalPipeline: 0, wonValue: 0, oppCount: 0 };
    if (opp.status === 'Won') {
      partnerRevenue[pid].wonValue += parseFloat(opp.deal_value) || 0;
    } else {
      partnerRevenue[pid].totalPipeline += parseFloat(opp.deal_value) || 0;
    }
    partnerRevenue[pid].oppCount += 1;
  }
}

function renderWithTypeFilter(container) {
  const partnerList = filterPartners(allPartners);
  const selectedTypes = loadTypeFilter();
  const allTypeData = computeTypeData(partnerList, allOpportunities);
  const allUniqueTypes = Object.keys(allTypeData);
  const allTotalPipeline = allOpportunities.filter(o => o.status !== 'Won').reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);
  const validSelected = selectedTypes.filter(t => allUniqueTypes.includes(t));

  const { partners: tfPartners } = applyTypeFilter({ partners: partnerList, selected: validSelected });

  const filterBar = buildTypeFilterBar({
    allUniqueTypes, allTypeData, allTotalPipeline, validSelected,
    onChanged: () => renderWithTypeFilter(container),
  });

  renderView(container, tfPartners, filterBar);
}

// Re-render AFTER re-reading the sheet.
//
// This used to redraw the module-level `allPartners` without refetching, which
// made every mutation leave the view describing a spreadsheet that no longer
// existed. Deleting a partner is the sharp case: rows below the deleted one
// shift up, but the in-memory rows kept their old `_rowIndex`, so the very next
// Edit or Delete wrote a full 11-column row — partner_id, is_admin and
// password_hash included — over an innocent partner. No second tab or race was
// needed; two clicks did it. The deleted partner also stayed on screen, and a
// newly added one never appeared.
//
// Writes invalidate that sheet's cache entry (see sheets.js), so this read is
// fresh rather than served from the 30s TTL.
function reRender() {
  const viewContainer = document.getElementById('view-container');
  return loadPartnerData()
    .then(() => renderWithTypeFilter(viewContainer))
    .catch((err) => {
      // Never leave the view showing pre-mutation data: the write already
      // happened, so a silent failure here would be the same stale-list lie.
      showToast(err.message || 'Saved, but the list could not be refreshed. Reload the page.', 'error');
    });
}

function partnerInitials(name) {
  return (name || '').split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
}

// ============================================
// Bento Dashboard
// ============================================

// ============================================
// Main View
// ============================================

const VIEW_STORAGE_KEY = 'admin-partners-view';

function loadActiveView() {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    return saved === 'card' ? 'card' : 'list';
  } catch {
    return 'list';
  }
}

function saveActiveView(view) {
  try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch {}
}

function renderView(container, partners, filterBar) {
  let searchQuery = '';
  let activeView = loadActiveView();

  function applyFilters() {
    let result = [...partners];
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(p =>
        p.display_name?.toLowerCase().includes(q) ||
        p.username?.toLowerCase().includes(q) ||
        p.partner_type?.toLowerCase().includes(q) ||
        p.region?.toLowerCase().includes(q) ||
        p.hq_location?.toLowerCase().includes(q)
      );
    }
    return result;
  }

  const listBtn = el('button', { class: 'btn btn--sm', onClick: () => switchView('list') }, 'List');
  const cardBtn = el('button', { class: 'btn btn--sm', onClick: () => switchView('card') }, 'Cards');

  function applyToggleClasses() {
    listBtn.className = activeView === 'list' ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
    cardBtn.className = activeView === 'card' ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
  }
  applyToggleClasses();

  function switchView(view) {
    if (view === activeView) return;
    activeView = view;
    saveActiveView(view);
    applyToggleClasses();
    renderContent(applyFilters());
  }

  const content = el('div', {},
    filterBar,
    el('div', { class: 'section-header' },
      el('div', {},
        el('h2', { class: 'section-header__title' }, 'Partners'),
        el('p', { class: 'section-header__subtitle' }, `${partners.length} registered partners`)
      ),
      el('div', { style: { display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' } },
        el('div', { class: 'view-toggle', style: { marginBottom: '0' } }, listBtn, cardBtn),
        el('div', { class: 'search-bar' },
          el('span', { class: 'search-bar__icon', html: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M12.5 12.5L16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' }),
          el('input', {
            class: 'search-bar__input',
            type: 'text',
            placeholder: 'Search partners...',
            onInput: debounce((e) => {
              searchQuery = e.target.value;
              renderContent(applyFilters());
            }, 200),
          })
        ),
        el('button', {
          class: 'btn btn--primary',
          onClick: () => openPartnerModal(null),
        },
          el('span', { html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' }),
          'Add Partner'
        ),
      )
    ),

    el('div', { id: 'partners-view' })
  );

  mount(container, content);
  renderContent(applyFilters());

  function renderContent(filtered) {
    const host = $('#partners-view');
    if (!host) return;
    host.innerHTML = '';
    host.className = '';

    if (filtered.length === 0) {
      host.appendChild(
        el('div', { class: 'empty-state' },
          el('div', { class: 'empty-state__title' }, 'No partners found'),
          el('div', { class: 'empty-state__description' }, 'Try adjusting your search or add a new partner.')
        )
      );
      return;
    }

    const sorted = sortPartnersByPipeline(filtered);
    if (activeView === 'list') {
      host.appendChild(renderList(sorted));
    } else {
      host.className = 'partner-card-grid stagger';
      sorted.forEach(p => host.appendChild(buildPartnerCard(p)));
    }
  }
}

function sortPartnersByPipeline(partners) {
  return [...partners].sort((a, b) => {
    const aRev = partnerRevenue[a.partner_id]?.totalPipeline || 0;
    const bRev = partnerRevenue[b.partner_id]?.totalPipeline || 0;
    if (bRev !== aRev) return bRev - aRev;
    const aOpp = partnerRevenue[a.partner_id]?.oppCount || 0;
    const bOpp = partnerRevenue[b.partner_id]?.oppCount || 0;
    return bOpp - aOpp;
  });
}

function renderList(partners) {
  return el('div', { class: 'table-wrapper' },
    el('table', { class: 'table' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'Partner'),
          el('th', {}, 'Tier'),
          el('th', {}, 'Type'),
          el('th', {}, 'Pipeline'),
          el('th', {}, 'Won'),
          el('th', {}, 'Opportunities'),
          el('th', {}, 'Status'),
          el('th', {}, 'Actions')
        )
      ),
      el('tbody', {},
        ...partners.map(p => {
          const tierClass = tierSlug(p.tier);
          const initials = partnerInitials(p.display_name);
          const rev = partnerRevenue[p.partner_id];
          const pipeline = rev ? rev.totalPipeline : 0;
          const wonValue = rev ? rev.wonValue : 0;
          const oppCount = rev ? rev.oppCount : 0;

          return el('tr', {
            class: 'table__row--clickable',
            onClick: () => navigate(`/admin/partner-detail?id=${p.partner_id}`),
          },
            el('td', {},
              el('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                el('div', { class: `partner-avatar partner-avatar--sm partner-avatar--${tierClass}` }, initials),
                el('div', {},
                  el('a', {
                    href: '#',
                    class: 'deal-name-link',
                    onClick: (e) => { e.preventDefault(); navigate(`/admin/partner-detail?id=${p.partner_id}`); },
                  }, p.display_name),
                  el('div', { style: { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' } }, p.username || '')
                )
              )
            ),
            el('td', {}, el('span', { class: `badge badge--${tierClass}` }, p.tier || 'Registered')),
            el('td', {}, p.partner_type || '—'),
            el('td', { style: { fontWeight: 'var(--font-semibold)' } }, formatCurrency(pipeline)),
            el('td', {}, wonValue > 0 ? formatCurrency(wonValue) : '—'),
            el('td', {}, String(oppCount)),
            el('td', {}, el('span', { class: `badge badge--xs badge--${p.status?.toLowerCase() || 'active'}` }, p.status || 'active')),
            el('td', {},
              el('div', { class: 'table__actions' },
                el('button', { class: 'btn btn--ghost btn--sm', onClick: (e) => { e.stopPropagation(); navigate(`/admin/partner-detail?id=${p.partner_id}`); } }, 'View'),
                el('button', { class: 'btn btn--ghost btn--sm', onClick: (e) => { e.stopPropagation(); openPartnerModal(p); } }, 'Edit'),
                el('button', { class: 'btn btn--ghost btn--sm', style: { color: 'var(--color-danger)' }, onClick: (e) => { e.stopPropagation(); handleDelete(p); } }, 'Delete')
              )
            )
          );
        })
      )
    )
  );
}

function buildPartnerCard(p) {
  const tierClass = tierSlug(p.tier);
  const initials = partnerInitials(p.display_name);
  const rev = partnerRevenue[p.partner_id];
  const pipeline = rev ? rev.totalPipeline : 0;
  const wonValue = rev ? rev.wonValue : 0;
  const oppCount = rev ? rev.oppCount : 0;

  return el('div', { class: 'partner-mgmt-card' },
    el('div', { class: 'partner-mgmt-card__header' },
      el('div', { class: `partner-avatar partner-avatar--${tierClass}` }, initials),
      el('div', { class: 'partner-mgmt-card__info' },
        el('div', { class: 'partner-mgmt-card__name' }, p.display_name),
        el('div', { class: 'partner-mgmt-card__username' }, p.username),
      ),
      el('span', { class: `badge badge--${tierClass}` }, p.tier || 'Registered')
    ),
    el('div', { class: 'partner-mgmt-card__details' },
      detailRow('Pipeline', formatCurrency(pipeline)),
      wonValue > 0 ? detailRow('Won', formatCurrency(wonValue)) : null,
      detailRow('Opportunities', String(oppCount)),
      detailRow('Type', p.partner_type || '—'),
      detailRow('Status', null, el('span', { class: `badge badge--xs badge--${p.status?.toLowerCase() || 'active'}` }, p.status || 'active')),
    ),
    el('div', { class: 'partner-mgmt-card__actions' },
      el('button', {
        class: 'btn btn--primary btn--sm',
        style: { flex: '1' },
        onClick: () => navigate(`/admin/partner-detail?id=${p.partner_id}`),
      }, 'View'),
      el('button', {
        class: 'btn btn--secondary btn--sm',
        style: { flex: '1' },
        onClick: () => openPartnerModal(p),
      }, 'Edit'),
      el('button', {
        class: 'btn btn--ghost btn--sm btn--icon',
        style: { color: 'var(--color-danger)' },
        title: 'Delete partner',
        onClick: () => handleDelete(p),
        html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M12.67 4v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4h9.34z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      }),
    )
  );
}

function detailRow(label, textValue, element) {
  return el('div', { class: 'partner-mgmt-card__row' },
    el('span', { class: 'partner-mgmt-card__label' }, label),
    element || el('span', { class: 'partner-mgmt-card__value' }, textValue || '—'),
  );
}

async function handleDelete(partner) {
  const confirmed = await confirmDialog(
    'Delete Partner',
    `Are you sure you want to delete "${partner.display_name}"? This cannot be undone.`
  );
  if (!confirmed) return;

  try {
    await deleteRowById(CONFIG.SHEET_PARTNERS, 'partner_id', partner.partner_id);
    showToast('Partner deleted', 'success');
    reRender();
  } catch (err) {
    showToast(err.message || 'Failed to delete partner', 'error');
  }
}

function openPartnerModal(partner) {
  const isEdit = !!partner;

  const fields = [
    { name: 'username', label: 'Username', required: true, placeholder: 'e.g., nerdio' },
    { name: 'display_name', label: 'Company Name', required: true, placeholder: 'e.g., Nerdio' },
    { type: 'row-start' },
    {
      name: 'partner_type', label: 'Partner Type', type: 'select', required: true,
      placeholder: 'Select type...',
      options: ['Technology', 'MSP/SI', 'OEM', 'MENA Regional Distributor'],
    },
    {
      name: 'tier', label: 'Tier', type: 'select', required: true,
      placeholder: 'Select tier...',
      options: TIER_OPTIONS,
    },
    { type: 'row-end' },
    { type: 'row-start' },
    { name: 'region', label: 'Region', required: true, placeholder: 'e.g., North America' },
    {
      name: 'status', label: 'Status', type: 'select',
      default: 'engaged',
      options: ['engaged', 'active', 'inactive'],
    },
    { type: 'row-end' },
    { name: 'hq_location', label: 'HQ Location', placeholder: 'e.g., Chicago, Illinois, USA' },
  ];

  const initialValues = isEdit ? {
    username: partner.username,
    display_name: partner.display_name,
    partner_type: partner.partner_type,
    tier: partner.tier,
    region: partner.region,
    status: partner.status,
    hq_location: partner.hq_location,
  } : {};

  const form = buildForm(fields, async (data) => {
    try {
      if (isEdit) {
        // The columns this form edits come from `data`; the three it does not
        // come from `fresh` — the row as it is in the sheet right now, not as
        // it was when the modal opened. That matters most for password_hash:
        // a partner who changed their password while an admin had this form
        // open would otherwise have the old hash written back over it, locking
        // them out. is_admin is the same shape of problem with worse
        // consequences.
        await updateRowById(CONFIG.SHEET_PARTNERS, 'partner_id', partner.partner_id, (fresh) => [
          fresh.partner_id,
          data.username,
          data.display_name,
          data.partner_type,
          data.tier,
          data.region,
          fresh.created_at,
          fresh.is_admin || 'FALSE',
          fresh.password_hash || '',
          data.status,
          data.hq_location || '',
        ]);

        showToast('Partner updated successfully!', 'success');
      } else {
        const passwordHash = await sha256(CONFIG.DEFAULT_PASSWORD);
        const values = [
          uuid('p'),
          data.username,
          data.display_name,
          data.partner_type,
          data.tier,
          data.region,
          nowISO(),
          'FALSE',
          passwordHash,
          data.status || 'engaged',
          data.hq_location || '',
        ];

        if (isConfigured()) {
          await appendRow(CONFIG.SHEET_PARTNERS, values);
        } else {
          addDemoRow(CONFIG.SHEET_PARTNERS, values);
        }

        showToast('Partner added successfully!', 'success');
      }

      closeModal();
      reRender();
    } catch (err) {
      showToast(err.message || 'Failed to save partner', 'error');
    }
  }, initialValues);

  openModal({
    title: isEdit ? 'Edit Partner' : 'Add New Partner',
    content: form,
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Cancel'),
      el('button', {
        class: 'btn btn--primary',
        onClick: () => form.dispatchEvent(new Event('submit', { cancelable: true })),
      }, isEdit ? 'Save Changes' : 'Add Partner'),
    ],
  });
}

export function cleanup() {}
