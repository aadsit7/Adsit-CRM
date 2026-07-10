/**
 * Tests for inline Edit/Delete buttons on description and document rows
 * (feat/inline-row-actions).
 *
 * Tests use the __inlineRowActionsInternals test hook exported from
 * admin-opportunities.js, following the same pattern as
 * __mapPdfInternals in ai.js. The hook exposes pure helper functions
 * and handler factories so behaviour can be verified without a full
 * browser DOM environment.
 */

// ---- Minimal DOM shim required by the import chain ----
class _FakeNode {
  constructor() { this._children = []; this._listeners = {}; }
  appendChild(c) { this._children.push(c); return c; }
  replaceChildren(...cc) { this._children = cc; }
  get childNodes() { return this._children; }
  addEventListener(ev, fn) {
    if (!this._listeners[ev]) this._listeners[ev] = [];
    this._listeners[ev].push(fn);
  }
  removeEventListener() {}
}
class _FakeElement extends _FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.dataset = {};
    this._attrs = {};
    this.innerHTML = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.type = '';
    this.title = '';
    this.checked = false;
    this.nodeType = 1;
    const classes = new Set();
    this.classList = {
      add: (...c) => c.filter(Boolean).forEach(cc => classes.add(cc)),
      remove: (...c) => c.forEach(cc => classes.delete(cc)),
      toggle: (c, f) => (f !== undefined ? (f ? classes.add(c) : classes.delete(c))
        : (classes.has(c) ? classes.delete(c) : classes.add(c))),
      contains: (c) => classes.has(c),
      _classes: classes,
    };
    Object.defineProperty(this, 'className', {
      get: () => [...classes].join(' '),
      set: (v) => { classes.clear(); v.split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    });
  }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k] ?? null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  remove() { this._removed = true; }
  replaceWith(e) { this._replacedWith = e; }
  get isConnected() { return false; }
  get textContent() {
    return this._children.map(c => c.textContent || '').join('')
      + (this.innerHTML || '').replace(/<[^>]+>/g, '');
  }
}

if (!globalThis.Node) globalThis.Node = _FakeNode;
if (!globalThis.document) {
  const _root = new _FakeElement('div');
  _root.id = 'modal-root';
  globalThis.document = {
    createElement: tag => new _FakeElement(tag),
    createTextNode: t => Object.assign(new _FakeNode(), { textContent: String(t), nodeType: 3 }),
    body: new _FakeElement('body'),
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: id => id === 'modal-root' ? _root : null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}
if (!globalThis.window) globalThis.window = { Quill: null };
if (!globalThis.localStorage) {
  const _s = new Map();
  globalThis.localStorage = {
    getItem: k => _s.get(k) ?? null,
    setItem: (k, v) => _s.set(k, String(v)),
    removeItem: k => _s.delete(k),
    clear: () => _s.clear(),
  };
}
if (!globalThis.fetch) globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
if (!globalThis.MutationObserver) globalThis.MutationObserver = class { observe() {} disconnect() {} };
// ---- End shim ----

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { __inlineRowActionsInternals } from '../js/views/admin-opportunities.js';

const {
  shouldShowDescriptionActions,
  makeDescriptionDeleteHandler,
  makeDocumentDeleteHandler,
} = __inlineRowActionsInternals;

// ---- Test 1 ---------------------------------------------------------------
// Edit button renders for a sheet-backed description in normal (non-selection) view.
// The same condition controls whether the Delete button renders.
test('inline action buttons shown for sheet-backed description in normal mode', () => {
  const desc = { description_id: 'dsc_1', _rowIndex: 5 };
  assert.equal(shouldShowDescriptionActions(desc, /* selectionMode= */ false), true,
    'shouldShowDescriptionActions should return true when desc has _rowIndex and selectionMode is false');
});

// ---- Test 2 ---------------------------------------------------------------
// Delete description: confirmDialog=true → deleteRow called, callback fired, row removed.
test('description delete handler calls deleteRow and onDescriptionDeleted when confirmed', async () => {
  const desc = { description_id: 'dsc_2', _rowIndex: 7 };
  const SHEET = 'OPP_DESCRIPTIONS';
  const cardRow = { remove: mock.fn() };
  let deletedIdx = null;
  const onDescriptionDeleted = mock.fn(i => { deletedIdx = i; });

  const deps = {
    confirmDialog: mock.fn(async () => true),
    isConfigured: () => true,
    deleteRow: mock.fn(async () => {}),
    deleteDemoRow: mock.fn(),
    SHEET_OPP_DESCRIPTIONS: SHEET,
    showToast: mock.fn(),
  };

  const handler = makeDescriptionDeleteHandler(desc, 2, cardRow, onDescriptionDeleted, deps);
  await handler();

  assert.equal(deps.confirmDialog.mock.calls.length, 1, 'confirmDialog should be called once');
  assert.equal(deps.deleteRow.mock.calls.length, 1, 'deleteRow should be called once');
  assert.equal(deps.deleteRow.mock.calls[0].arguments[0], SHEET, 'deleteRow sheet arg correct');
  assert.equal(deps.deleteRow.mock.calls[0].arguments[1], 7, 'deleteRow rowIndex arg correct');
  assert.equal(cardRow.remove.mock.calls.length, 1, 'cardRow.remove should be called');
  assert.equal(onDescriptionDeleted.mock.calls.length, 1, 'onDescriptionDeleted should be called');
  assert.equal(deletedIdx, 2, 'onDescriptionDeleted should receive the correct index');
});

// ---- Test 3 ---------------------------------------------------------------
// Delete description: confirmDialog=false → nothing happens (deleteRow NOT called).
test('description delete handler does nothing when user cancels confirmation', async () => {
  const desc = { description_id: 'dsc_3', _rowIndex: 9 };
  const cardRow = { remove: mock.fn() };
  const onDescriptionDeleted = mock.fn();

  const deps = {
    confirmDialog: mock.fn(async () => false),
    isConfigured: () => true,
    deleteRow: mock.fn(async () => {}),
    deleteDemoRow: mock.fn(),
    SHEET_OPP_DESCRIPTIONS: 'OPP_DESCRIPTIONS',
    showToast: mock.fn(),
  };

  const handler = makeDescriptionDeleteHandler(desc, 0, cardRow, onDescriptionDeleted, deps);
  await handler();

  assert.equal(deps.confirmDialog.mock.calls.length, 1, 'confirmDialog should be called once');
  assert.equal(deps.deleteRow.mock.calls.length, 0, 'deleteRow should NOT be called when cancelled');
  assert.equal(cardRow.remove.mock.calls.length, 0, 'cardRow.remove should NOT be called');
  assert.equal(onDescriptionDeleted.mock.calls.length, 0, 'onDescriptionDeleted should NOT be called');
});

// ---- Test 4 ---------------------------------------------------------------
// Document delete (details modal): confirmDialog=true → fileApiRequest called, file spliced, row removed.
test('document delete handler calls fileApiRequest and removes row when confirmed', async () => {
  const file = { doc_id: 'doc_42', file_name: 'report.pdf' };
  const files = [
    { doc_id: 'doc_41', file_name: 'other.pdf' },
    { ...file },
    { doc_id: 'doc_43', file_name: 'another.pdf' },
  ];
  const row = { remove: mock.fn() };

  const deps = {
    confirmDialog: mock.fn(async () => true),
    fileApiRequest: mock.fn(async () => {}),
    showToast: mock.fn(),
  };

  const handler = makeDocumentDeleteHandler(file, files, row, deps);
  await handler();

  assert.equal(deps.confirmDialog.mock.calls.length, 1, 'confirmDialog should be called once');
  assert.equal(deps.fileApiRequest.mock.calls.length, 1, 'fileApiRequest should be called once');
  const callArg = deps.fileApiRequest.mock.calls[0].arguments[0];
  assert.equal(callArg.action, 'deleteFile', 'fileApiRequest action should be deleteFile');
  assert.equal(callArg.docId, 'doc_42', 'fileApiRequest docId should match the file');
  assert.equal(row.remove.mock.calls.length, 1, 'row.remove should be called');
  assert.equal(files.length, 2, 'file should be spliced from the files array');
  assert.ok(!files.find(f => f.doc_id === 'doc_42'), 'deleted file should not be in the files array');
});

// ---- Test 5 ---------------------------------------------------------------
// Selection mode (MAP PDF generation): inline buttons are NOT rendered.
test('inline action buttons hidden when selectionMode is active', () => {
  const desc = { description_id: 'dsc_5', _rowIndex: 3 };
  assert.equal(shouldShowDescriptionActions(desc, /* selectionMode= */ true), false,
    'shouldShowDescriptionActions should return false in selection mode');
});

// ---- Test 6 ---------------------------------------------------------------
// Descriptions without a sheet row index (legacy / unsaved): no inline buttons.
// This also covers the Edit-all modal separation — the edit modal's descriptionCard
// components never produce .row-action-btn elements; the inline buttons only exist
// in buildDetailsDescriptionsSection which guards on desc._rowIndex.
test('inline action buttons hidden for descriptions without a sheet row index', () => {
  const legacyDesc = { description_text: 'some text' }; // no _rowIndex, no description_id
  assert.equal(shouldShowDescriptionActions(legacyDesc, false), false,
    'shouldShowDescriptionActions should return false when desc._rowIndex is absent');

  const tempDesc = { description_id: 'dsc_6', _tempId: 'tmp_1' }; // _isNew desc, no _rowIndex
  assert.equal(shouldShowDescriptionActions(tempDesc, false), false,
    'shouldShowDescriptionActions should return false for an unsaved description with no _rowIndex');
});
