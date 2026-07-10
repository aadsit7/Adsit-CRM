// ============================================
// Content Visibility Filters
// ============================================
//
// Shared filtering helpers that respect admin
// content-visibility toggle settings. Each function
// reads the current toggle state from runtime config
// so changes take effect on the next view render.

import { getRuntimeConfig } from '../config.js';

/**
 * Filter partners: always excludes admins, optionally excludes inactive.
 */
export function filterPartners(partners) {
  const showInactive = getRuntimeConfig('SHOW_INACTIVE_PARTNERS');
  return partners.filter(p => {
    if (String(p.is_admin).toUpperCase() === 'TRUE') return false;
    if (!showInactive && String(p.status).toLowerCase() === 'inactive') return false;
    return true;
  });
}

/**
 * Filter events: optionally excludes Completed (past) and Cancelled events.
 */
export function filterEvents(events) {
  const showPast = getRuntimeConfig('SHOW_PAST_EVENTS');
  const showCancelled = getRuntimeConfig('SHOW_CANCELLED_EVENTS');
  return events.filter(e => {
    if (!showCancelled && e.status === 'Cancelled') return false;
    if (!showPast && e.status === 'Completed') return false;
    return true;
  });
}

/**
 * Filter opportunities: optionally excludes Lost opportunities.
 */
export function filterOpportunities(opportunities) {
  const showClosedLost = getRuntimeConfig('SHOW_CLOSED_LOST_OPPS');
  return opportunities.filter(o => {
    if (!showClosedLost && o.status === 'Lost') return false;
    return true;
  });
}
