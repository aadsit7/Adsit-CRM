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
// Delete description: confirmDialog=true → the row is deleted BY ID, callback fired, row removed.
test('description delete handler deletes by description_id and fires onDescriptionDeleted', async () => {
  const desc = { description_id: 'dsc_2', _rowIndex: 7 };
  const SHEET = 'OPP_DESCRIPTIONS';
  const cardRow = { remove: mock.fn() };
  let deletedId = null;
  const onDescriptionDeleted = mock.fn(id => { deletedId = id; });

  const deps = {
    confirmDialog: mock.fn(async () => true),
    deleteRowById: mock.fn(async () => {}),
    SHEET_OPP_DESCRIPTIONS: SHEET,
    showToast: mock.fn(),
  };

  const handler = makeDescriptionDeleteHandler(desc, cardRow, onDescriptionDeleted, deps);
  await handler();

  assert.equal(deps.confirmDialog.mock.calls.length, 1, 'confirmDialog should be called once');
  assert.equal(deps.deleteRowById.mock.calls.length, 1, 'the delete should be issued once');
  assert.deepEqual(deps.deleteRowById.mock.calls[0].arguments, [SHEET, 'description_id', 'dsc_2'],
    'addressed by description_id — never by the _rowIndex captured when the card was drawn');
  assert.equal(cardRow.remove.mock.calls.length, 1, 'cardRow.remove should be called');
  assert.equal(onDescriptionDeleted.mock.calls.length, 1, 'onDescriptionDeleted should be called');
  // The callback identifies the row by its id, never by a render-time index:
  // earlier deletes shift the array, so a captured index splices the wrong
  // entry (delete A then B used to remove C from the in-memory list).
  assert.equal(deletedId, 'dsc_2', 'onDescriptionDeleted should receive the description_id');
});

// ---- Test 3 ---------------------------------------------------------------
// Delete description: confirmDialog=false → nothing happens (no delete issued).
test('description delete handler does nothing when user cancels confirmation', async () => {
  const desc = { description_id: 'dsc_3', _rowIndex: 9 };
  const cardRow = { remove: mock.fn() };
  const onDescriptionDeleted = mock.fn();

  const deps = {
    confirmDialog: mock.fn(async () => false),
    deleteRowById: mock.fn(async () => {}),
    SHEET_OPP_DESCRIPTIONS: 'OPP_DESCRIPTIONS',
    showToast: mock.fn(),
  };

  const handler = makeDescriptionDeleteHandler(desc, cardRow, onDescriptionDeleted, deps);
  await handler();

  assert.equal(deps.confirmDialog.mock.calls.length, 1, 'confirmDialog should be called once');
  assert.equal(deps.deleteRowById.mock.calls.length, 0, 'no delete should be issued when cancelled');
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
// Unsaved descriptions get no inline buttons. The gate is the description_id,
// not the _rowIndex it used to be: the delete now addresses the row by that id,
// so gating on anything else can render a Delete button whose handler is
// guaranteed to fail. Unsaved cards carry a _tempId and no id (see
// descriptions-panel.js), so they are still correctly excluded.
test('inline action buttons hidden for descriptions that are not in the sheet', () => {
  const legacyDesc = { description_text: 'some text' }; // never persisted
  assert.equal(shouldShowDescriptionActions(legacyDesc, false), false,
    'no description_id — nothing to address a delete with');

  const tempDesc = { _tempId: 'tmp_1', _isNew: true, description_text: 'draft' };
  assert.equal(shouldShowDescriptionActions(tempDesc, false), false,
    'an unsaved card is removed locally, not deleted from the sheet');
});

// A description appended DURING this session — the document-analysis flow — has
// a real id and a real sheet row but never gets a _rowIndex. The old
// _rowIndex gate hid its Delete button, which is why deleting one used to
// leave the sheet row orphaned.
test('inline action buttons shown for a description appended during this session', () => {
  const analyzed = { description_id: 'dsc_7', description_text: 'from a document' };
  assert.equal(shouldShowDescriptionActions(analyzed, false), true,
    'it is in the sheet and addressable, so it must be deletable');
  assert.equal(shouldShowDescriptionActions(analyzed, /* selectionMode= */ true), false,
    'still hidden in selection mode');
});
