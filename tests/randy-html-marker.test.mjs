// Regression tests for the Randy card-rendering contract. Cards with
// `response-container` in their class list must be injected as DOM
// (via sanitizeHTML), not escaped as text by the markdown renderer.
//
// containsHTMLResponse() lives inside randy.js and is not exported.
// Rather than refactor the whole file to export internals, we test
// the contract by string-matching the same regex the function uses.
// If a future edit changes that regex, updating this test is trivial;
// if the regex regresses to the old substring check, the multi-class
// cases here fail and catch it.

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/components/randy.js', import.meta.url), 'utf8');

// Extract the line that defines containsHTMLResponse's matcher. This
// keeps the test faithful to whatever pattern randy.js actually ships.
const matcherLine = source.match(/return\s+(\/.*response-container.*\/[gimuy]*)\.test/);
assert.ok(matcherLine, 'randy.js must define a regex-based containsHTMLResponse');
const rx = new RegExp(matcherLine[1].slice(1, matcherLine[1].lastIndexOf('/')),
                      matcherLine[1].slice(matcherLine[1].lastIndexOf('/') + 1));

test('matches a single-class response-container (preserves legacy contract)', () => {
  assert.ok(rx.test('<div class="response-container">hello</div>'));
});

test('matches a multi-class wrapper — the Bug 2 regression case', () => {
  assert.ok(rx.test('<div class="response-container randy-map-card">hi</div>'));
  assert.ok(rx.test('<div class="response-container randy-map-card randy-map-card--warning">hi</div>'));
  assert.ok(rx.test("<div class='response-container randy-map-card'>hi</div>"));
});

test('matches when response-container appears after other classes', () => {
  assert.ok(rx.test('<div class="foo response-container">hi</div>'));
  assert.ok(rx.test('<div class="foo response-container bar">hi</div>'));
});

test('does NOT match plain markdown text', () => {
  assert.equal(rx.test('**Summary**\n\nJust a plain assistant response.'), false);
});

test('does NOT match substring false-positive (response-containerish)', () => {
  // e.g. if some future class was named `response-containerless`, the
  // \b boundary should reject it.
  assert.equal(rx.test('<div class="response-containerless">x</div>'), false);
});
