// Regression tests for two Randy voice-control behaviors:
//
//   1. The bottom control row exposes a "New Chat" button (id
//      `randy-newchat-btn`) in place of the old "Type" toggle
//      (`randy-edit-btn`). The message input box is always visible, so a
//      dedicated type toggle is redundant.
//
//   2. The microphone must be OFF whenever the voice feature is off. The
//      browser's recording indicator only tracks an open SpeechRecognition,
//      so the fix is two source-level guards working together:
//        a. onStateEnter(PASSIVE) takes the "quiet" branch (abort mic, keep
//           history) whenever `isTypeModeActive || !voiceEnabled`.
//        b. startRecognition() refuses to (re)open the mic while in PASSIVE
//           with voice off — this stops onend/onerror auto-restarts from
//           resurrecting it.
//
// These are structural assertions against the shipped source, matching the
// style of randy-html-marker.test.mjs: randy.js is not structured to import
// its internals under Node (module-level `window.speechSynthesis`, deep DOM
// import graph), so we lock the contract by asserting the source contains the
// exact guards the fix depends on. If a future edit removes a guard, the
// corresponding case here fails and catches the regression.

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/components/randy.js', import.meta.url), 'utf8');

test('New Chat button replaces the Type toggle in the control row', () => {
  assert.ok(source.includes('id="randy-newchat-btn"'),
    'the bottom control row must render a New Chat button');
  assert.ok(source.includes('>New Chat<'),
    'the New Chat button must carry a "New Chat" label');
  assert.equal(source.includes('id="randy-edit-btn"'), false,
    'the old Type toggle button must be removed');
});

test('the message input row is always visible (no hidden attribute)', () => {
  const rowMatch = source.match(/<div class="randy-input-row" id="randy-input-row"([^>]*)>/);
  assert.ok(rowMatch, 'the input row element must exist');
  assert.equal(/\bhidden\b/.test(rowMatch[1]), false,
    'the input row must not be hidden — it is always available for typing');
});

test('PASSIVE state goes quiet (mic off) whenever voice is off', () => {
  // The quiet branch preserves history but stops the mic. It must trigger for
  // type mode AND for a plain voice-off toggle (voiceEnabled === false).
  assert.ok(source.includes('if (isTypeModeActive || !voiceEnabled) {'),
    'onStateEnter(PASSIVE) must take the quiet branch when voice is off');
});

test('startRecognition never opens the mic while paused with voice off', () => {
  assert.ok(source.includes('if (currentState === STATES.PASSIVE && !voiceEnabled) return;'),
    'startRecognition must bail in PASSIVE when voice is off, so onend/onerror ' +
    'restarts cannot reopen the mic');
});
