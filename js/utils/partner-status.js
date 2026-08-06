// ============================================
// Partner Status (relationship lifecycle)
// ============================================
//
// The Partners sheet's `status` column says where the relationship stands,
// earliest first:
//
//   targeting — an account we want but have not connected with yet. The row
//               exists so the account can be planned against; nobody has
//               made contact.
//   engaged   — a live conversation is running.
//   active    — a working partnership.
//   inactive  — dormant or wound down.
//
// Status is a CRM classification, not a maturity score — see
// docs/PARTNER_ANALYZER.md. Values are stored lowercase and rendered through
// statusLabel(), so a sheet holding "Active" and "active" still shows one
// consistent badge.
//
// This lives outside the views because the Partners page and the quick-add
// panel both write the column and have to agree on the vocabulary.

export const PARTNER_STATUSES = ['targeting', 'engaged', 'active', 'inactive'];

export const DEFAULT_PARTNER_STATUS = 'engaged';

/** Normalize a stored status for comparison and CSS class names. */
export function statusSlug(status) {
  return String(status ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * The status a partner row is treated as having. A blank column falls back to
 * `active`, which is what the Partners table has always shown for those rows —
 * the filter has to agree with the badge or filtering would hide rows that
 * visibly carry the status being filtered for.
 */
export function partnerStatus(partner) {
  return statusSlug(partner?.status) || 'active';
}

/** Title-case a status for display. Unknown values pass through capitalized. */
export function statusLabel(status) {
  const slug = statusSlug(status);
  if (!slug) return '';
  return slug.split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Lifecycle order first, then anything else the sheet holds, alphabetically.
function compareStatus(a, b) {
  const ai = PARTNER_STATUSES.indexOf(a);
  const bi = PARTNER_STATUSES.indexOf(b);
  const oa = ai >= 0 ? ai : PARTNER_STATUSES.length;
  const ob = bi >= 0 ? bi : PARTNER_STATUSES.length;
  return oa !== ob ? oa - ob : a.localeCompare(b);
}

/**
 * Options for the Partners page status dropdown, counted from the partners
 * actually on screen so the list can never offer a status that would return
 * nothing — inactive partners, for one, are hidden entirely unless the admin's
 * SHOW_INACTIVE_PARTNERS toggle is on.
 *
 * `selected` is always included, at a count of 0 if need be, so a filter that
 * stops matching (after a type-filter change, say) stays visible and
 * reversible instead of silently resetting to "All".
 *
 * @param {Array}  partners
 * @param {string} [selected] - currently selected status ('' = all)
 * @returns {Array<{value: string, label: string, count: number}>}
 */
export function partnerStatusOptions(partners, selected = '') {
  const counts = new Map();
  for (const p of partners || []) {
    const s = partnerStatus(p);
    counts.set(s, (counts.get(s) || 0) + 1);
  }

  const sel = statusSlug(selected);
  if (sel && !counts.has(sel)) counts.set(sel, 0);

  return [...counts.keys()].sort(compareStatus).map(value => ({
    value,
    label: statusLabel(value),
    count: counts.get(value),
  }));
}

/** Does this partner match the selected status? '' selects everything. */
export function matchesStatus(partner, selected) {
  const sel = statusSlug(selected);
  if (!sel) return true;
  return partnerStatus(partner) === sel;
}
