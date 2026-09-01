// Tests for the keyboard-shortcut combo matcher (js/utils/hotkeys.js).
//
// The one that motivated these: "?" — the only way to open the shortcuts
// help overlay — lives on the shifted layer of standard layouts, so the
// keydown that types it carries shiftKey=true. A matcher that requires
// shiftKey === false for the "?" combo makes the overlay unreachable.

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCombo, matches } from '../js/utils/hotkeys.js';

function keyEvent(key, { alt = false, ctrl = false, shift = false } = {}) {
  return { key, altKey: alt, ctrlKey: ctrl, shiftKey: shift };
}

test('"?" matches the shifted keypress that actually types it', () => {
  const parsed = parseCombo('?');
  assert.equal(matches(keyEvent('?', { shift: true }), parsed), true, 'US layout: Shift+/ types "?"');
  assert.equal(matches(keyEvent('?'), parsed), true, 'layouts with an unshifted "?" still work');
});

test('symbol combos still require the right key and modifiers', () => {
  const parsed = parseCombo('?');
  assert.equal(matches(keyEvent('/', { shift: true }), parsed), false, 'a different key does not match');
  assert.equal(matches(keyEvent('?', { shift: true, alt: true }), parsed), false, 'Alt is not part of the combo');
  assert.equal(matches(keyEvent('?', { shift: true, ctrl: true }), parsed), false, 'Ctrl is not part of the combo');
});

test('letter combos keep strict shift matching', () => {
  const altP = parseCombo('Alt+P');
  assert.equal(matches(keyEvent('p', { alt: true }), altP), true);
  assert.equal(matches(keyEvent('P', { alt: true, shift: true }), altP), false, 'Alt+Shift+P is a distinct combo');
  assert.equal(matches(keyEvent('p'), altP), false, 'Alt is required');
});

test('explicit Shift combos require shift, symbols included', () => {
  const ctrlShiftO = parseCombo('Ctrl+Shift+O');
  assert.equal(matches(keyEvent('O', { ctrl: true, shift: true }), ctrlShiftO), true);
  assert.equal(matches(keyEvent('o', { ctrl: true }), ctrlShiftO), false);
});
