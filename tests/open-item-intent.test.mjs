// Tests for the open-item intent + deterministic matchers — pure
// functions, no browser deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectOpenItemIntent,
  matchDocuments,
  resolveDescriptionTarget,
  parseOrdinalPick,
  parseSpokenDate,
  stripOpportunityTokens,
  contentTokens,
  formatSpokenDate,
  hintMentionsName,
} from '../js/utils/open-item-intent.js';

// ── detectOpenItemIntent: positives ──────────────────────────────
const POSITIVE = [
  // [input, itemType, opportunityHint, itemHint contains...]
  ['Open the pricing doc for ANICO',                    'document', 'ANICO',      'pricing'],
  ['open up the signed contract pdf for the PSE deal',  'document', 'PSE',        'contract'],
  ['Pull up the MAP PDF for American National',         'document', 'American National', 'map'],
  ['Show me the timeline pdf on Greenshield',           'document', 'Greenshield', 'timeline'],
  ['can you open the proposal document for Fabrikam?',  'document', 'Fabrikam',   'proposal'],
  ['view the spreadsheet for Metro Health',             'document', 'Metro Health', 'spreadsheet'],
  ['open the ANICO pricing doc',                        'document', null,         'anico'],
  ['bring up the documents for Tailspin Toys',          'document', 'Tailspin Toys', 'documents'],
  ['open the latest description note for ANICO',        'note',     'ANICO',      'latest'],
  ['open the note from April 22 for ANICO',             'note',     'ANICO',      'april 22'],
  ['show me the meeting recap for Nerdio',              'note',     'Nerdio',     'meeting recap'],
  ['open the description note for ANICO from April 22nd', 'note',   'ANICO',      'april 22nd'],
  ['pull up the notes on pricing for ANICO',            'note',     'ANICO',      'pricing'],
  ['open the description for the Greenshield deal',     'note',     'Greenshield', 'description'],
];

for (const [input, itemType, oppHint, itemContains] of POSITIVE) {
  test(`detects ${itemType}: ${JSON.stringify(input)}`, () => {
    const out = detectOpenItemIntent(input);
    assert.equal(out.triggered, true, `expected triggered=true for ${input}`);
    assert.equal(out.itemType, itemType);
    assert.equal(out.opportunityHint, oppHint, `opp hint mismatch for ${input}`);
    if (itemContains) {
      assert.ok((out.itemHint || '').toLowerCase().includes(itemContains),
        `expected itemHint ${JSON.stringify(out.itemHint)} to contain ${JSON.stringify(itemContains)}`);
    }
  });
}

// ── detectOpenItemIntent: negatives ──────────────────────────────
const NEGATIVE = [
  'Create a MAP PDF for ANICO',                 // creation → MAP flow
  'generate a mutual action plan for PSE',      // creation
  'make me a map pdf for TechCorp',             // creation
  'open up a new map pdf for ANICO',            // "new" → creation
  "What's the latest note on ANICO about?",     // question, no open verb
  'tell me about the Fabrikam deal',            // question
  'Open the dashboard',                         // plain navigation
  'open Nerdio',                                // open_detail navigation
  'go to opportunities',                        // navigation
  'update the close date for Greenshield',      // data action
  'Hello Randy',
  '',
  null,
  undefined,
];

for (const input of NEGATIVE) {
  test(`does NOT trigger: ${JSON.stringify(input)}`, () => {
    const out = detectOpenItemIntent(input);
    assert.equal(out.triggered, false, `expected triggered=false for ${JSON.stringify(input)}`);
  });
}

// ── matchDocuments ────────────────────────────────────────────────
const FILES = [
  { file_name: 'MAP_ANICO_2026-06-01.pdf',      date_added: '2026-06-01T10:00:00Z' },
  { file_name: 'Timeline_ANICO_2026-06-20.pdf', date_added: '2026-06-20T10:00:00Z' },
  { file_name: 'Pricing Proposal v2.pdf',       date_added: '2026-05-11T10:00:00Z' },
  { file_name: 'Signed Contract.docx',          date_added: '2026-04-02T10:00:00Z' },
  { file_name: 'User Counts.xlsx',              date_added: '2026-03-15T10:00:00Z' },
];

test('matchDocuments: exact normalized name', () => {
  const out = matchDocuments(FILES, 'signed contract');
  assert.equal(out.length, 1);
  assert.equal(out[0].file_name, 'Signed Contract.docx');
});

test('matchDocuments: substring containment', () => {
  const out = matchDocuments(FILES, 'pricing proposal');
  assert.equal(out.length, 1);
  assert.equal(out[0].file_name, 'Pricing Proposal v2.pdf');
});

test('matchDocuments: single token narrows to one file', () => {
  const out = matchDocuments(FILES, 'the pricing doc');
  assert.equal(out.length, 1);
  assert.equal(out[0].file_name, 'Pricing Proposal v2.pdf');
});

test('matchDocuments: "map" finds the MAP pdf', () => {
  const out = matchDocuments(FILES, 'map pdf');
  assert.equal(out.length, 1);
  assert.equal(out[0].file_name, 'MAP_ANICO_2026-06-01.pdf');
});

test('matchDocuments: ambiguous token returns all candidates', () => {
  // "anico" appears in both generated PDFs → user must pick.
  const out = matchDocuments(FILES, 'anico');
  assert.equal(out.length, 2);
});

test('matchDocuments: "latest" breaks ties by date_added', () => {
  const out = matchDocuments(FILES, 'the latest anico pdf');
  assert.equal(out.length, 1);
  assert.equal(out[0].file_name, 'Timeline_ANICO_2026-06-20.pdf');
});

test('matchDocuments: type filter alone ("the spreadsheet")', () => {
  const out = matchDocuments(FILES, 'the spreadsheet');
  assert.equal(out.length, 1);
  assert.equal(out[0].file_name, 'User Counts.xlsx');
});

test('matchDocuments: bare "the document" returns whole pool', () => {
  const out = matchDocuments(FILES, 'the document');
  assert.equal(out.length, FILES.length);
});

test('matchDocuments: "latest document" returns newest file', () => {
  const out = matchDocuments(FILES, 'the latest document');
  assert.equal(out.length, 1);
  assert.equal(out[0].file_name, 'Timeline_ANICO_2026-06-20.pdf');
});

test('matchDocuments: nothing plausible → empty', () => {
  assert.deepEqual(matchDocuments(FILES, 'quarterly budget forecast'), []);
});

test('matchDocuments: empty file list → empty', () => {
  assert.deepEqual(matchDocuments([], 'pricing'), []);
});

// ── resolveDescriptionTarget ─────────────────────────────────────
const DESCS = [
  { date: '2026-06-25', text: 'Follow-up call. Discussed security review and legal redlines.', category: 'meeting_recap' },
  { date: '2026-04-22', text: 'Kickoff meeting with Gerard and Matias. Pricing tiers requested.', category: 'meeting_recap' },
  { date: '2026-03-02', text: 'Deal registered from the Nerdio referral.', category: 'opportunity_note' },
];

test('notes: no hint on multi-note opp defaults to latest, flagged', () => {
  const out = resolveDescriptionTarget(DESCS, '');
  assert.equal(out.index, 0);
  assert.equal(out.defaulted, true);
});

test('notes: filler-only hint ("the description note") defaults to latest', () => {
  const out = resolveDescriptionTarget(DESCS, 'the description note');
  assert.equal(out.index, 0);
  assert.equal(out.defaulted, true);
});

test('notes: "latest" → index 0', () => {
  assert.equal(resolveDescriptionTarget(DESCS, 'the latest note').index, 0);
});

test('notes: "oldest" → last index', () => {
  assert.equal(resolveDescriptionTarget(DESCS, 'the first note').index, 2);
});

test('notes: exact date match', () => {
  assert.equal(resolveDescriptionTarget(DESCS, 'the note from April 22nd').index, 1);
});

test('notes: date with year', () => {
  assert.equal(resolveDescriptionTarget(DESCS, 'note from April 22, 2026').index, 1);
});

test('notes: numeric date', () => {
  assert.equal(resolveDescriptionTarget(DESCS, '4/22').index, 1);
});

test('notes: month-only with one hit', () => {
  assert.equal(resolveDescriptionTarget(DESCS, 'the March note').index, 2);
});

test('notes: date that matches nothing → none', () => {
  assert.deepEqual(resolveDescriptionTarget(DESCS, 'the note from January 9'), { none: true });
});

test('notes: category "opportunity note"', () => {
  assert.equal(resolveDescriptionTarget(DESCS, 'the opportunity note').index, 2);
});

test('notes: category "meeting recap" picks newest recap', () => {
  assert.equal(resolveDescriptionTarget(DESCS, 'the meeting recap').index, 0);
});

test('notes: keyword match against content', () => {
  assert.equal(resolveDescriptionTarget(DESCS, 'the note about the security review').index, 0);
});

test('notes: keyword tie → candidates', () => {
  const descs = [
    { date: '2026-06-01', text: 'Pricing discussion round two.' },
    { date: '2026-05-01', text: 'Pricing discussion round one.' },
  ];
  const out = resolveDescriptionTarget(descs, 'the pricing note');
  assert.deepEqual(out.candidates, [0, 1]);
});

test('notes: empty list → none', () => {
  assert.deepEqual(resolveDescriptionTarget([], 'latest'), { none: true });
});

// ── parseSpokenDate ───────────────────────────────────────────────
test('parseSpokenDate variants', () => {
  assert.deepEqual(parseSpokenDate('April 22nd'), { year: null, month: 3, day: 22 });
  assert.deepEqual(parseSpokenDate('22nd of April 2026'), { year: 2026, month: 3, day: 22 });
  assert.deepEqual(parseSpokenDate('2026-04-22'), { year: 2026, month: 3, day: 22 });
  assert.deepEqual(parseSpokenDate('4/22/26'), { year: 2026, month: 3, day: 22 });
  assert.deepEqual(parseSpokenDate('march'), { year: null, month: 2, day: null });
  assert.equal(parseSpokenDate('the pricing doc'), null);
});

test('formatSpokenDate reads ISO dates without timezone drift', () => {
  assert.equal(formatSpokenDate('2026-04-22'), 'April 22, 2026');
});

// ── parseOrdinalPick ──────────────────────────────────────────────
test('ordinal picks', () => {
  assert.equal(parseOrdinalPick('the first one', 3), 0);
  assert.equal(parseOrdinalPick('second', 3), 1);
  assert.equal(parseOrdinalPick('number 3', 3), 2);
  assert.equal(parseOrdinalPick('the last one', 4), 3);
  assert.equal(parseOrdinalPick('one', 3), 0);
  assert.equal(parseOrdinalPick('the pricing proposal', 3), -1);
  assert.equal(parseOrdinalPick('7', 3), -1); // out of range
});

// ── helpers ───────────────────────────────────────────────────────
test('stripOpportunityTokens removes the resolved opp name', () => {
  assert.equal(stripOpportunityTokens('anico pricing doc', ['ANICO', 'ANICO Renewal']), 'pricing doc');
  assert.equal(
    stripOpportunityTokens('greenshield map pdf', ['Greenshield', 'Greenshield Expansion']),
    'map pdf');
});

test('hintMentionsName: containment either way, normalized', () => {
  assert.equal(hintMentionsName('anico pricing', 'ANICO'), true);
  assert.equal(hintMentionsName('anico', 'American National (ANICO)'), true);
  assert.equal(hintMentionsName('pricing proposal', 'Premium Retail Insights'), false);
  assert.equal(hintMentionsName('ge', 'General Electric'), false); // too short
});

test('contentTokens drops filler words', () => {
  assert.deepEqual(contentTokens('open the latest description note please boss'), ['open']);
  assert.deepEqual(contentTokens('the pricing proposal doc'), ['pricing', 'proposal']);
});
