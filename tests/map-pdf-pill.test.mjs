// Tests for js/components/map-pdf-pill.js. The pill manipulates the
// DOM, so we spin up a minimal document stub rather than installing
// jsdom as a dev dep. Only the surface contracts are tested: stage
// updates, timer formatting, success/failure transitions.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stand-in just rich enough for the pill's DOM touches.
function makeFakeDoc() {
  const listeners = new Map();
  function makeEl() {
    const el = {
      id: '',
      className: '',
      children: [],
      classList: {
        _set: new Set(),
        add(...cs) { cs.forEach(c => this._set.add(c)); },
        remove(...cs) { cs.forEach(c => this._set.delete(c)); },
        contains(c) { return this._set.has(c); },
      },
      _text: '',
      _html: '',
      get innerHTML() { return this._html; },
      set innerHTML(v) {
        this._html = String(v);
        // Populate three trivial "child query" handles the pill code reaches for.
        this._stage = { textContent: '' };
        this._elapsed = { textContent: '' };
        this._icon = { classList: { add() {}, remove() {} }, innerHTML: '' };
      },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); },
      setAttribute() {},
      appendChild(child) { this.children.push(child); return child; },
      insertBefore(child) { this.children.unshift(child); return child; },
      querySelector(sel) {
        if (sel.includes('__stage'))   return this._stage   || { textContent: '' };
        if (sel.includes('__elapsed')) return this._elapsed || { textContent: '' };
        if (sel.includes('__icon'))    return this._icon    || { classList: { add() {}, remove() {} }, innerHTML: '' };
        return null;
      },
      get firstChild() { return this.children[0] || null; },
      remove() {},
    };
    return el;
  }
  return {
    _map: new Map(),
    createElement: () => makeEl(),
    getElementById(id) { return this._map.get(id) || null; },
    body: makeEl(),
    _register(id, el) { this._map.set(id, el); },
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
}

globalThis.document = makeFakeDoc();

// Stub a #randy-root that getStackHost() will find.
const randyRoot = globalThis.document.createElement();
randyRoot.id = 'randy-root';
globalThis.document._register('randy-root', randyRoot);

const { createPill, updatePillStage, markPillSuccess, markPillFailure, destroyPill, formatElapsed } =
  await import('../js/components/map-pdf-pill.js');

// ── formatElapsed is pure ────────────────────────────────────
test('formatElapsed: 0ms → "0:00"',     () => assert.equal(formatElapsed(0),       '0:00'));
test('formatElapsed: 8.9s → "0:08"',    () => assert.equal(formatElapsed(8900),    '0:08'));
test('formatElapsed: 9.0s → "0:09"',    () => assert.equal(formatElapsed(9000),    '0:09'));
test('formatElapsed: 59s → "0:59"',     () => assert.equal(formatElapsed(59_500),  '0:59'));
test('formatElapsed: 60s → "1:00"',     () => assert.equal(formatElapsed(60_000),  '1:00'));
test('formatElapsed: 83s → "1:23"',     () => assert.equal(formatElapsed(83_000),  '1:23'));
test('formatElapsed: clamps negative', () => assert.equal(formatElapsed(-1000),   '0:00'));

// ── createPill returns a usable handle ───────────────────────
test('createPill returns {el, id, stageEl, elapsedEl}', () => {
  const pill = createPill('Hello…');
  assert.ok(pill.el);
  assert.match(String(pill.id), /^map-pill-/);
  // Cleanup so the interval doesn't leak across tests.
  destroyPill(pill);
});

// ── Randy's face is the persistent identity badge on every pill ──
test('createPill includes the Randy avatar badge by default', () => {
  const pill = createPill('Working…');
  assert.match(pill.el.innerHTML, /randy-map-pill__avatar/);
  assert.match(pill.el.innerHTML, /assets\/randy-avatar\.png/);
  destroyPill(pill);
});

test('createPill omits the avatar when { avatar: false }', () => {
  const pill = createPill('Working…', { avatar: false });
  assert.ok(!pill.el.innerHTML.includes('randy-map-pill__avatar'));
  destroyPill(pill);
});

test('createPill accepts a custom avatar URL', () => {
  const pill = createPill('Working…', { avatar: 'assets/other.png' });
  assert.match(pill.el.innerHTML, /assets\/other\.png/);
  destroyPill(pill);
});

// ── updatePillStage swaps stage text ─────────────────────────
test('updatePillStage sets stageEl.textContent', () => {
  const pill = createPill('Stage A');
  updatePillStage(pill, 'Stage B');
  assert.equal(pill.stageEl.textContent, 'Stage B');
  destroyPill(pill);
});

// ── markPillSuccess settles the pill and sets final text ─────
test('markPillSuccess settles pill, sets stage + elapsed text', () => {
  const pill = createPill('Working…');
  markPillSuccess(pill, 'Saved to Acme');
  assert.equal(pill.settled, true);
  assert.equal(pill.stageEl.textContent, 'Saved to Acme');
  assert.match(pill.elapsedEl.textContent, /✓$/);
  // Another call is a no-op
  markPillSuccess(pill, 'ignored');
  assert.equal(pill.stageEl.textContent, 'Saved to Acme');
});

// ── markPillFailure settles the pill and sets error text ─────
test('markPillFailure settles pill with error copy', () => {
  const pill = createPill('Working…');
  markPillFailure(pill, 'Something broke');
  assert.equal(pill.settled, true);
  assert.equal(pill.stageEl.textContent, 'Something broke');
});

// ── updatePillStage is a no-op once settled ─────────────────
test('updatePillStage ignores settled pills', () => {
  const pill = createPill('Working…');
  markPillSuccess(pill, 'Done');
  updatePillStage(pill, 'shouldNotAppear');
  assert.equal(pill.stageEl.textContent, 'Done');
});
