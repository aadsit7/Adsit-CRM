// ============================================================
// Partner status vocabulary + the Partners page status filter
// ============================================================
// `targeting` is the pre-relationship state: the account is on the list and
// worth planning against, but nobody has connected with them yet. These tests
// pin the vocabulary, the dropdown options built from it, and the filtering
// the Partners page actually runs (via __partnerViewInternals, the same hook
// pattern as __partnerWriteInternals).

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  PARTNER_STATUSES, DEFAULT_PARTNER_STATUS,
  statusSlug, statusLabel, partnerStatus, partnerStatusOptions, matchesStatus,
} = await import('../js/utils/partner-status.js');

const { __partnerViewInternals } = await import('../js/views/admin-partners.js');
const { applyPartnerFilters } = __partnerViewInternals;

const partner = (name, status, extra = {}) => ({
  partner_id: `p_${name}`, display_name: name, username: name.toLowerCase(),
  partner_type: 'MSP/SI', region: 'North America', status, ...extra,
});

// ── Vocabulary ──────────────────────────────────────────────────────

test('targeting leads the lifecycle and the default is unchanged', () => {
  assert.deepEqual(PARTNER_STATUSES, ['targeting', 'engaged', 'active', 'inactive']);
  // Adding "targeting" must not change what a partner saved without touching
  // the dropdown gets written as.
  assert.equal(DEFAULT_PARTNER_STATUS, 'engaged');
});

test('a status is matched however the sheet cased it', () => {
  assert.equal(statusSlug('  Targeting '), 'targeting');
  assert.equal(partnerStatus({ status: 'ACTIVE' }), 'active');
  assert.equal(matchesStatus({ status: 'Targeting' }, 'targeting'), true);
});

test('a blank status column reads as active, the same as the badge shows', () => {
  assert.equal(partnerStatus({ status: '' }), 'active');
  assert.equal(partnerStatus({}), 'active');
  assert.equal(matchesStatus({ status: '' }, 'active'), true);
});

test('labels are title-cased for display', () => {
  assert.equal(statusLabel('targeting'), 'Targeting');
  assert.equal(statusLabel('inactive'), 'Inactive');
  assert.equal(statusLabel(''), '');
});

// ── Dropdown options ────────────────────────────────────────────────

test('options are counted from the partners on screen, in lifecycle order', () => {
  const opts = partnerStatusOptions([
    partner('A', 'active'), partner('B', 'targeting'),
    partner('C', 'Active'), partner('D', 'engaged'),
  ]);
  assert.deepEqual(opts, [
    { value: 'targeting', label: 'Targeting', count: 1 },
    { value: 'engaged', label: 'Engaged', count: 1 },
    { value: 'active', label: 'Active', count: 2 },
  ]);
});

test('a status nobody holds is not offered', () => {
  // Inactive partners are hidden entirely unless SHOW_INACTIVE_PARTNERS is on;
  // offering the status anyway would be a dropdown entry that shows nothing.
  const opts = partnerStatusOptions([partner('A', 'active')]);
  assert.deepEqual(opts.map(o => o.value), ['active']);
});

test('the selected status stays listed even at a count of zero', () => {
  const opts = partnerStatusOptions([partner('A', 'active')], 'targeting');
  assert.deepEqual(opts, [
    { value: 'targeting', label: 'Targeting', count: 0 },
    { value: 'active', label: 'Active', count: 1 },
  ]);
});

test('statuses outside the lifecycle still get an option, sorted last', () => {
  const opts = partnerStatusOptions([partner('A', 'archived'), partner('B', 'active')]);
  assert.deepEqual(opts.map(o => o.value), ['active', 'archived']);
});

// ── The page's filtering ────────────────────────────────────────────

const roster = [
  partner('Nerdio', 'active'),
  partner('Insight', 'Engaged'),
  partner('Rubrik', 'targeting', { hq_location: 'Palo Alto, California, USA' }),
  partner('Elantis', 'inactive'),
];

test('no status selected keeps everyone', () => {
  assert.equal(applyPartnerFilters(roster, { status: '' }).length, 4);
  assert.equal(applyPartnerFilters(roster).length, 4);
});

test('selecting a status keeps only that status', () => {
  const targeting = applyPartnerFilters(roster, { status: 'targeting' });
  assert.deepEqual(targeting.map(p => p.display_name), ['Rubrik']);
});

test('search and status filter together, not either/or', () => {
  assert.deepEqual(
    applyPartnerFilters(roster, { status: 'targeting', search: 'rub' }).map(p => p.display_name),
    ['Rubrik'],
  );
  // Same search, a status the match does not hold — nothing survives.
  assert.deepEqual(applyPartnerFilters(roster, { status: 'active', search: 'rub' }), []);
});

test('search still spans name, username, type, region and HQ', () => {
  const hit = (q) => applyPartnerFilters(roster, { search: q }).map(p => p.display_name);
  assert.deepEqual(hit('nerdio'), ['Nerdio']);
  assert.deepEqual(hit('palo alto'), ['Rubrik']);
  assert.equal(hit('msp/si').length, 4);
  assert.equal(hit('  ').length, 4); // whitespace is not a query
});
