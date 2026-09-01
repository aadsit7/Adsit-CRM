// Tests for the shared HTML sanitizer (js/utils/sanitize-html.js).
//
// The DOM-walking pass needs a real DOMParser, which Node doesn't ship, so
// these tests cover the pure pieces: the URL scheme gate (the part regex
// blacklists kept getting wrong) and the fail-closed non-browser fallback.

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeHtml, isSafeUrl, safeUrl } from '../js/utils/sanitize-html.js';

test('isSafeUrl blocks executable schemes, entity tricks aside', () => {
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
  assert.equal(isSafeUrl('JAVASCRIPT:alert(1)'), false);
  assert.equal(isSafeUrl('java\tscript:alert(1)'), false, 'embedded tab is stripped before scheme detection');
  assert.equal(isSafeUrl(' javascript:alert(1)'), false, 'leading space is stripped');
  assert.equal(isSafeUrl('data:text/html,<script>1</script>'), false);
  assert.equal(isSafeUrl('vbscript:msgbox'), false);
});

test('isSafeUrl allows the schemes links actually use', () => {
  assert.equal(isSafeUrl('https://example.com/report'), true);
  assert.equal(isSafeUrl('http://example.com'), true);
  assert.equal(isSafeUrl('mailto:a@b.com'), true);
  assert.equal(isSafeUrl('tel:+15551234'), true);
  assert.equal(isSafeUrl('#/admin/partners'), true);
  assert.equal(isSafeUrl('/relative/path'), true);
  assert.equal(isSafeUrl(''), true);
});

test('safeUrl passes safe URLs through and neuters unsafe ones', () => {
  assert.equal(safeUrl('https://example.com'), 'https://example.com');
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl(null), '');
});

test('sanitizeHtml fails closed to escaped text without DOMParser', () => {
  // Node has no DOMParser, so the fallback must neutralize markup entirely
  // rather than passing it through.
  const out = sanitizeHtml('<svg/onload=alert(1)>hi');
  assert.ok(!out.includes('<svg'), 'no live element survives');
  assert.ok(out.includes('&lt;svg'), 'markup is escaped, content kept');
});
