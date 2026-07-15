// Tests for the opportunity-matching logic used by
// getOpportunityDescription(). We import the internal helper
// directly so we can drive it with mocked opportunity arrays
// without spinning up a Sheets reader.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __mapPdfInternals } from '../js/utils/ai.js';

const { findOpportunityMatches, acronymOf, sharesPrefix, findMentionedOpportunities, clip } = __mapPdfInternals;

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

// ── findMentionedOpportunities: chat-grounding multi-match ────────────

test('findMentionedOpportunities expands EVERY named deal, not just the first', () => {
  const hits = findMentionedOpportunities(OPPORTUNITIES, 'compare Fabrikam Inc and Metro Health Systems for me');
  const ids = hits.map(o => o.opportunity_id).sort();
  assert.deepEqual(ids, ['opp_2', 'opp_3']);
});

test('findMentionedOpportunities returns both deals that share a customer', () => {
  const opps = [
    { opportunity_id: 'a', deal_name: 'Discovery', customer_name: 'Acme Corp' },
    { opportunity_id: 'b', deal_name: 'Expansion', customer_name: 'Acme Corp' },
    { opportunity_id: 'c', deal_name: 'Other',     customer_name: 'Zeta LLC' },
  ];
  const hits = findMentionedOpportunities(opps, "what's happening with Acme Corp?");
  assert.deepEqual(hits.map(o => o.opportunity_id).sort(), ['a', 'b']);
});

test('findMentionedOpportunities is voice-tolerant (spaced/again name)', () => {
  const opps = [{ opportunity_id: 'g', deal_name: 'Renewal', customer_name: 'Greenshield' }];
  const hits = findMentionedOpportunities(opps, 'catch me up on Green Shield');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunity_id, 'g');
});

test('findMentionedOpportunities matches a typed acronym (ANICO)', () => {
  const hits = findMentionedOpportunities(OPPORTUNITIES, 'deep dive on ANICO please');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunity_id, 'opp_1');
});

test('findMentionedOpportunities dedupes when multiple passes hit the same deal', () => {
  // "Fabrikam Inc" matches by name; nothing else should double-count it.
  const hits = findMentionedOpportunities(OPPORTUNITIES, 'Fabrikam Inc Fabrikam Inc');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunity_id, 'opp_2');
});

test('findMentionedOpportunities does not drag in unrelated deals from plain prose', () => {
  // Ordinary words must not acronym-match; no deal name appears here.
  assert.deepEqual(findMentionedOpportunities(OPPORTUNITIES, 'how is the pipeline looking this quarter'), []);
  assert.deepEqual(findMentionedOpportunities(OPPORTUNITIES, ''), []);
});

// ── clip: visible truncation ─────────────────────────────────────────

test('clip leaves short text untouched and marks long text', () => {
  assert.equal(clip('short', 100), 'short');
  const out = clip('x'.repeat(50), 10);
  assert.ok(out.startsWith('x'.repeat(10)));
  assert.ok(/truncated: 40 more characters/.test(out));
});

test('clip handles null/undefined safely', () => {
  assert.equal(clip(null, 10), '');
  assert.equal(clip(undefined, 10), '');
});
