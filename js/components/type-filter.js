// ============================================
// Shared Partner Type Filter
// ============================================
// Reusable type filter bar for Dashboard, Partners, Opportunities, Events views.

import { el, formatCurrency } from '../utils/dom.js';

const TYPE_FILTER_KEY = 'pp_type_filter';
const OLD_KEY = 'pp_dashboard_type_filter'; // legacy key, migrate once

const DEFAULT_TYPES = ['MSP/SI', 'Technology'];

// Preferred display order — types not listed appear at the end alphabetically
const TYPE_ORDER = ['MSP/SI', 'Technology', 'OEM', 'MENA Regional Distributor'];

export function loadTypeFilter() {
  try {
    let raw = localStorage.getItem(TYPE_FILTER_KEY);
    // Migrate from old dashboard-only key
    if (raw === null) {
      const old = localStorage.getItem(OLD_KEY);
      if (old !== null) {
        localStorage.setItem(TYPE_FILTER_KEY, old);
        localStorage.removeItem(OLD_KEY);
        raw = old;
      }
    }
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed; // [] means "All Types"
    }
  } catch { /* ignore */ }
  return DEFAULT_TYPES;
}

export function saveTypeFilter(selectedTypes) {
  localStorage.setItem(TYPE_FILTER_KEY, JSON.stringify(selectedTypes));
}

/**
 * Compute per-type partner counts and pipeline values.
 */
export function computeTypeData(partnerList, opportunities) {
  const data = {};
  partnerList.forEach(p => {
    const type = p.partner_type || 'Other';
    if (!data[type]) data[type] = { count: 0, pipeline: 0 };
    data[type].count++;
    const partnerPipeline = opportunities
      .filter(o => o.partner_id === p.partner_id && o.status !== 'Won')
      .reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);
    data[type].pipeline += partnerPipeline;
  });
  return data;
}

/**
 * Sort type names in the preferred display order.
 */
export function sortTypes(types) {
  return [...types].sort((a, b) => {
    const ai = TYPE_ORDER.indexOf(a);
    const bi = TYPE_ORDER.indexOf(b);
    const oa = ai >= 0 ? ai : TYPE_ORDER.length;
    const ob = bi >= 0 ? bi : TYPE_ORDER.length;
    return oa !== ob ? oa - ob : a.localeCompare(b);
  });
}

/**
 * Build the type filter button bar.
 *
 * @param {Object} opts
 * @param {string[]} opts.allUniqueTypes   - All available type names (will be sorted)
 * @param {Object}   opts.allTypeData      - From computeTypeData (unfiltered)
 * @param {number}   opts.allTotalPipeline - Sum of all pipeline values
 * @param {string[]} opts.validSelected    - Currently selected types ([] = all)
 * @param {function} opts.onChanged        - Called after selection changes
 * @returns {HTMLElement}
 */
export function buildTypeFilterBar({ allUniqueTypes, allTypeData, allTotalPipeline, validSelected, onChanged }) {
  const sorted = sortTypes(allUniqueTypes);
  const buttons = [];

  // "All Types" button
  const allActive = validSelected.length === 0;
  buttons.push(el('button', {
    class: allActive ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm',
    onClick: () => { saveTypeFilter([]); onChanged(); },
  },
    el('span', { class: 'type-filter-label' }, 'All Types'),
    el('span', { class: 'type-filter-pipeline' }, formatCurrency(allTotalPipeline)),
  ));

  sorted.forEach(type => {
    const d = allTypeData[type];
    if (!d) return;
    const isActive = validSelected.includes(type);
    buttons.push(el('button', {
      class: isActive ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm',
      onClick: () => {
        let next;
        if (isActive) {
          next = validSelected.filter(t => t !== type);
        } else {
          next = [...validSelected, type];
        }
        if (next.length === 0 || next.length === allUniqueTypes.length) next = [];
        saveTypeFilter(next);
        onChanged();
      },
    },
      el('span', { class: 'type-filter-label' }, type),
      el('span', { class: 'type-filter-pipeline' }, formatCurrency(d.pipeline)),
    ));
  });

  return el('div', { class: 'view-toggle type-filter-bar' }, ...buttons);
}

/**
 * Apply the type filter to partners and cascade to opportunities/events.
 *
 * @param {Object} opts
 * @param {Array}    opts.partners      - Full (base-filtered) partner list
 * @param {Array}    [opts.opportunities] - Full (base-filtered) opportunities
 * @param {Array}    [opts.events]        - Full (base-filtered) events
 * @param {string[]} opts.selected      - Selected type names ([] = all)
 * @returns {{ partners, opportunities, events }}
 */
export function applyTypeFilter({ partners, opportunities = [], events = [], selected }) {
  if (selected.length === 0) return { partners, opportunities, events };

  const tfPartners = partners.filter(p => selected.includes(p.partner_type));
  const tfIds = new Set(tfPartners.map(p => p.partner_id));
  const tfOpps = opportunities.filter(o => tfIds.has(o.partner_id));
  const tfEvents = events.filter(e => !e.partner_id || tfIds.has(e.partner_id));

  return { partners: tfPartners, opportunities: tfOpps, events: tfEvents };
}
