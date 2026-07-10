// Tests for detectMapPdfIntent() — pure function, no browser deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectMapPdfIntent } from '../js/utils/map-pdf-intent.js';

// ── Positive: triggers + hint extraction ─────────────────────────
const POSITIVE = [
  ['Create a MAP PDF for ANICO',                              'ANICO'],
  ['create a map for American National',                      'American National'],
  ['Create map pdf for HCA',                                  'HCA'],
  ['Generate a MAP for ANICO',                                'ANICO'],
  ['generate a mutual action plan for the PSE deal',          'PSE'],
  ['Build a MAP PDF on the ANICO opportunity',                'ANICO'],
  ['Build a map pdf for Fabrikam',                            'Fabrikam'],
  ['Can you make me a MAP PDF for the PSE deal?',             'PSE'],
  ['make a map pdf for TechCorp',                             'TechCorp'],
  ['new MAP for Metro Health',                                'Metro Health'],
  ['New map pdf for Acme Corp',                               'Acme Corp'],
  ['Update the MAP for ANICO',                                'ANICO'],
  ['update map pdf for Contoso',                              'Contoso'],
  ['mutual action plan pdf for Tailspin Toys',                'Tailspin Toys'],
  ['meeting recap pdf for the Fabrikam account',              'Fabrikam'],
  ['create a MAP',                                            null],       // no hint given
  ['update the map',                                          null],       // no hint given
];

for (const [input, expectedHint] of POSITIVE) {
  test(`triggers + extracts hint: ${JSON.stringify(input)}`, () => {
    const out = detectMapPdfIntent(input);
    assert.equal(out.triggered, true, `expected triggered=true for ${input}`);
    assert.equal(out.opportunityHint, expectedHint, `hint mismatch for ${input}`);
  });
}

// ── Negative: must NOT trigger ───────────────────────────────────
const NEGATIVE = [
  "What's the pipeline looking like for ANICO?",
  'Show me partners on a map',               // ambiguous "on a map" must NOT fire
  'Can you pull up the ANICO opportunity?',
  'Give me a summary of the Fabrikam deal',
  'What did we discuss with TechCorp last week?',
  'Hello Randy',
  '',
  null,
  undefined,
  'Send the MAP to the customer',            // MAP mentioned, no creation verb
];

for (const input of NEGATIVE) {
  test(`does NOT trigger: ${JSON.stringify(input)}`, () => {
    const out = detectMapPdfIntent(input);
    assert.equal(out.triggered, false, `expected triggered=false for ${JSON.stringify(input)}`);
    assert.equal(out.opportunityHint, null);
  });
}

// ── Edge cases ───────────────────────────────────────────────────
test('strips trailing filler words like "please" and "now"', () => {
  assert.equal(detectMapPdfIntent('create a map for ANICO now please').opportunityHint, 'ANICO');
});

test('handles punctuation after hint', () => {
  assert.equal(detectMapPdfIntent('Create a MAP PDF for ANICO.').opportunityHint, 'ANICO');
  assert.equal(detectMapPdfIntent('Create a MAP PDF for ANICO?').opportunityHint, 'ANICO');
});

test('returns null hint for "create a MAP" with no company', () => {
  const out = detectMapPdfIntent('create a MAP PDF');
  assert.equal(out.triggered, true);
  assert.equal(out.opportunityHint, null);
});
