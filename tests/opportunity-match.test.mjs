// Tests for the opportunity-matching logic used by
// getOpportunityDescription(). We import the internal helper
// directly so we can drive it with mocked opportunity arrays
// without spinning up a Sheets reader.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __mapPdfInternals } from '../js/utils/ai.js';

const { findOpportunityMatches, acronymOf, sharesPrefix } = __mapPdfInternals;

const OPPORTUNITIES = [
  { opportunity_id: 'opp_1', deal_name: 'MAP Renewal',                customer_name: 'American National Insurance Company' },
  { opportunity_id: 'opp_2', deal_name: 'SCCM to Intune Migration',   customer_name: 'Fabrikam Inc' },
  { opportunity_id: 'opp_3', deal_name: 'Cloud Desktop Optimization', customer_name: 'Metro Health Systems' },
  { opportunity_id: 'opp_4', deal_name: 'Network Refresh',            customer_name: 'EuroBank AG' },
  { opportunity_id: 'opp_5', deal_name: 'Edge Computing Platform',    customer_name: 'Adventure Works' },
];

test('exact case-insensitive match on customer_name', () => {
  const hits = findOpportunityMatches(OPPORTUNITIES, 'fabrikam inc');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunity_id, 'opp_2');
});

test('exact case-insensitive match on deal_name', () => {
  const hits = findOpportunityMatches(OPPORTUNITIES, 'network refresh');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunity_id, 'opp_4');
});

test('partial includes match on customer_name', () => {
  const hits = findOpportunityMatches(OPPORTUNITIES, 'American National');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunity_id, 'opp_1');
});

test('partial includes match on deal_name', () => {
  const hits = findOpportunityMatches(OPPORTUNITIES, 'Intune');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunity_id, 'opp_2');
});

test('acronym match — ANICO resolves to American National Insurance Company', () => {
  // acronym("American National Insurance Company") = "ANIC";
  // hint "ANICO" shares 4-char prefix with "ANIC" → match.
  const hits = findOpportunityMatches(OPPORTUNITIES, 'ANICO');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunity_id, 'opp_1');
});

test('acronym match — MHS resolves to Metro Health Systems', () => {
  const hits = findOpportunityMatches(OPPORTUNITIES, 'MHS');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunity_id, 'opp_3');
});

test('no match returns empty array', () => {
  assert.deepEqual(findOpportunityMatches(OPPORTUNITIES, 'completely unrelated name'), []);
});

test('reverse match — full sentence contains opp name (Timeline PDF preset use-case)', () => {
  const hits = findOpportunityMatches(OPPORTUNITIES, 'Put together a timeline PDF for Fabrikam Inc please');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunity_id, 'opp_2');
});

test('reverse match — sentence with punctuation-differing opp name still matches', () => {
  const opps = [
    { opportunity_id: 'x1', deal_name: 'Flexera - OEM Agreement Expansion', customer_name: 'Flexera' },
  ];
  // Hint uses a plain hyphen where the deal name uses " - "; normalization bridges the gap
  const hits = findOpportunityMatches(opps, 'Put together a timeline PDF for Flexera OEM Agreement Expansion');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunity_id, 'x1');
});

test('empty / whitespace hint returns empty array', () => {
  assert.deepEqual(findOpportunityMatches(OPPORTUNITIES, ''), []);
  assert.deepEqual(findOpportunityMatches(OPPORTUNITIES, '   '), []);
});

test('multiple partial matches are all returned', () => {
  const opps = [
    { opportunity_id: 'a', deal_name: 'Discovery', customer_name: 'Acme Corp' },
    { opportunity_id: 'b', deal_name: 'Expansion', customer_name: 'Acme Europe' },
  ];
  const hits = findOpportunityMatches(opps, 'Acme');
  assert.equal(hits.length, 2);
});

test('acronymOf handles multi-word names', () => {
  assert.equal(acronymOf('American National Insurance Company'), 'ANIC');
  assert.equal(acronymOf('Metro Health Systems'), 'MHS');
  assert.equal(acronymOf('fabrikam inc'), 'FI');
});

test('sharesPrefix requires the configured minimum overlap', () => {
  assert.equal(sharesPrefix('ANICO', 'ANIC', 3), true);   // 4-char overlap
  assert.equal(sharesPrefix('ANIC', 'ANICO', 3), true);   // bidirectional
  assert.equal(sharesPrefix('AN', 'ANIC', 3), false);     // only 2-char overlap
  assert.equal(sharesPrefix('', 'ABC'), false);
  assert.equal(sharesPrefix('ABC', 'XYZ'), false);
});
