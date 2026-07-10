// Tests for background MAP PDF generation behaviour — specifically the
// changes introduced to decouple the progress pill from the modal lifecycle.
//
// Covers:
//   1. Pill lands in the global body-fixed container, not the modal
//   2. Multiple concurrent generations each get their own pill
//   3. Pill label carries the opportunity name
//   4. Pill state persists (settled flag, text) after its host is removed
//   5. Scoped (legacy) path still works for backwards-compat

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Fake DOM ──────────────────────────────────────────────────────────────
// Richer stub than _setup.mjs — needs getElementById, appendChild, etc.
function makeFakeDoc() {
  const registry = new Map();

  function makeEl(tag = 'div') {
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      style: {},
      title: '',
      _html: '',
      _text: '',
      _removed: false,
      children,
      classList: (() => {
        const set = new Set();
        return {
          add(...cs)    { cs.forEach(c => set.add(c)); },
          remove(...cs) { cs.forEach(c => set.delete(c)); },
          contains(c)  { return set.has(c); },
          toggle(c, f) { f ? set.add(c) : set.delete(c); },
        };
      })(),
      get innerHTML() { return this._html; },
      set innerHTML(v) {
        this._html = String(v);
        // Populate element handles that createPill() uses via querySelector.
        this._stage   = { textContent: '', classList: { add() {}, remove() {} } };
        this._elapsed = { textContent: '', classList: { add() {}, remove() {} } };
        this._icon    = { classList: { add() {}, remove() {} }, innerHTML: '' };
      },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); },
      setAttribute() {},
      appendChild(child) { children.push(child); return child; },
      insertBefore(child, ref) {
        const i = children.indexOf(ref);
        if (i === -1) children.unshift(child);
        else children.splice(i, 0, child);
        return child;
      },
      querySelector(sel) {
        if (sel.includes('__stage'))   return this._stage   || null;
        if (sel.includes('__elapsed')) return this._elapsed || null;
        if (sel.includes('__icon'))    return this._icon    || null;
        if (sel.includes('--scoped'))  return children.find(c => c.className && c.className.includes('--scoped')) || null;
        return null;
      },
      querySelectorAll() { return []; },
      get firstChild() { return children[0] || null; },
      remove() { this._removed = true; },
      addEventListener() {},
    };
    return el;
  }

  const body = makeEl('body');

  return {
    _registry: registry,
    _body: body,
    createElement: (tag) => makeEl(tag || 'div'),
    getElementById(id) { return registry.get(id) || null; },
    get body() { return body; },
    _register(id, el) { registry.set(id, el); },
  };
}

// Install the fake document BEFORE importing the pill module so the module
// picks up our stub on first load.
const fakeDoc = makeFakeDoc();
globalThis.document = fakeDoc;

const {
  createPill, updatePillStage, markPillSuccess, markPillFailure,
  destroyPill, formatElapsed,
} = await import('../js/components/map-pdf-pill.js');

// ── Test 1: Pill lands in the global body-fixed container ─────────────────
test('createPill() with no options attaches to global body-fixed container', () => {
  // First call lazily creates #map-pdf-global-pill-stack on document.body.
  const pill = createPill('Starting…');
  assert.ok(pill.el, 'pill.el should be truthy');

  // The global host should now be appended to document.body.
  const globalHost = fakeDoc.body.children.find(c => c.id === 'map-pdf-global-pill-stack');
  assert.ok(globalHost, '#map-pdf-global-pill-stack should exist on document.body');

  // And the pill element should be a child of that host.
  const pillInHost = globalHost.children.some(c => c === pill.el);
  assert.ok(pillInHost, 'pill.el should be inside #map-pdf-global-pill-stack');

  destroyPill(pill);
});

// ── Test 2: Multiple concurrent generations each get a unique pill ─────────
test('two concurrent createPill() calls produce pills with distinct IDs', () => {
  const pill1 = createPill('Job 1 — Reading…');
  const pill2 = createPill('Job 2 — Synthesizing…');

  assert.ok(pill1.id, 'pill1 must have an id');
  assert.ok(pill2.id, 'pill2 must have an id');
  assert.notEqual(pill1.id, pill2.id, 'concurrent pill IDs must differ');
  assert.notEqual(pill1.el, pill2.el, 'concurrent pill elements must differ');

  destroyPill(pill1);
  destroyPill(pill2);
});

// ── Test 3: Label option embeds the opportunity name in the pill HTML ──────
test('createPill() with label option includes label text in innerHTML', () => {
  const pill = createPill('Building PDF…', { label: 'Acme Corp' });

  // The label is rendered via escapeHtml() — check for the raw string
  // (no special chars in "Acme Corp") in the element's innerHTML.
  assert.ok(
    pill.el.innerHTML.includes('Acme Corp'),
    'pill innerHTML should contain the opportunity label',
  );
  assert.ok(
    pill.el.innerHTML.includes('randy-map-pill__label'),
    'pill innerHTML should contain the label class',
  );

  destroyPill(pill);
});

// ── Test 4: Pill state persists after its DOM node is "removed" ────────────
// This simulates Scenario A: the modal closes (removing DOM) but the pill
// was created in the global container, so its JS object and interval remain
// valid. The key invariant: settled state and stage text survive independently
// of whether .el is still in the document.
test('pill settled state and stage text persist after pill.el.remove() is called', () => {
  const pill = createPill('Synthesizing 3 descriptions…');

  // Advance to a success state without the element being in a live document.
  pill.el.remove(); // simulates modal DOM teardown

  // The pill object still tracks settled = false at this point.
  assert.equal(pill.settled, false);

  // markPillSuccess should still function on the object.
  markPillSuccess(pill, 'Saved to Drive');
  assert.equal(pill.settled, true);
  assert.equal(pill.stageEl.textContent, 'Saved to Drive');
  assert.match(pill.elapsedEl.textContent, /✓$/);
});

// ── Test 5: scopeContainer (legacy) still routes pill into the given node ──
test('createPill() with scopeContainer anchors pill inside that element', () => {
  const fakeModal = fakeDoc.createElement('div');
  fakeModal.id = 'fake-modal-backdrop';

  const pill = createPill('Legacy scoped pill', { scopeContainer: fakeModal });
  assert.ok(pill.el, 'scoped pill.el should be truthy');

  // The modal container should now have a scoped stack child.
  const scopedStack = fakeModal.children.find(c =>
    c.className && c.className.includes('randy-map-pill-stack--scoped'),
  );
  assert.ok(scopedStack, 'scoped stack should exist inside scopeContainer');

  // And the pill should be inside that stack.
  const pillInStack = scopedStack.children.some(c => c === pill.el);
  assert.ok(pillInStack, 'pill.el should be inside the scoped stack');

  destroyPill(pill);
});
