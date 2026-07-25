// ============================================================
// Partner Contacts table — the Analyzer PDF column
// ============================================================
// The Contacts table on the partner page shows a link to each contact's
// Analyzer-generated Account Intelligence Brief in place of the old Phone
// column. These tests pin the wiring (not just the pure lookup, which
// analyzer-export-files.test.mjs covers):
//   • the header row is exactly Name · Role · Company · Email · Analyzer PDF ·
//     Sources · Actions — Phone is gone, column count is unchanged
//   • a contact WITH a brief gets a real link to its Drive URL
//   • a contact WITHOUT one gets an honest dash, never a dead link
//   • a brief whose Drive link never resolved is shown as present-but-unlinked
//   • one contact's brief never appears on another contact's row
// ============================================================

// ---- Minimal DOM shim (same approach as inline-row-actions.test.mjs) ----
class _FakeNode {
  constructor() { this._children = []; this._listeners = {}; }
  appendChild(c) { this._children.push(c); return c; }
  replaceChildren(...cc) { this._children = cc; }
  get childNodes() { return this._children; }
  addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); }
  removeEventListener() {}
}
class _FakeElement extends _FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.style = {};
    this.dataset = {};
    this._attrs = {};
    this.innerHTML = '';
    this.value = '';
    this.disabled = false;
    this.nodeType = 1;
    const classes = new Set();
    this.classList = {
      add: (...c) => c.filter(Boolean).forEach(cc => classes.add(cc)),
      remove: (...c) => c.forEach(cc => classes.delete(cc)),
      toggle: (c, f) => (f !== undefined ? (f ? classes.add(c) : classes.delete(c))
        : (classes.has(c) ? classes.delete(c) : classes.add(c))),
      contains: (c) => classes.has(c),
    };
    Object.defineProperty(this, 'className', {
      get: () => [...classes].join(' '),
      set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    });
  }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k] ?? null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  remove() {}
  get isConnected() { return false; }
  get textContent() {
    return this._children.map(c => c.textContent || '').join('')
      + String(this.innerHTML || '').replace(/<[^>]+>/g, '');
  }
}

if (!globalThis.Node) globalThis.Node = _FakeNode;
if (!globalThis.document) {
  globalThis.document = {
    createElement: tag => new _FakeElement(tag),
    createTextNode: t => Object.assign(new _FakeNode(), { textContent: String(t), nodeType: 3 }),
    body: new _FakeElement('body'),
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: () => null,
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

import { __partnerContactsTableInternals } from '../js/views/admin-partner-detail.js';
import { indexContactAnalyzerPdfs } from '../js/utils/analyzer-export-files.js';

const { contactAnalyzerPdfCell, buildContactsTable } = __partnerContactsTableInternals;

const PARTNER = { partner_id: 'p_1', display_name: 'Insight Enterprises' };

function docRow(fields) {
  return {
    _rowIndex: 2,
    doc_id: 'DOC1',
    opportunity_id: '',
    file_name: '',
    drive_url: '',
    date_added: '2026-07-25',
    ...fields,
  };
}

// Walk the fake tree collecting every element with a given tag.
function findAll(node, tag, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.tagName === tag.toUpperCase()) out.push(node);
  for (const c of node._children || []) findAll(c, tag, out);
  return out;
}

// ── The column contract ─────────────────────────────────────────────

test('the Contacts table header replaces Phone with Analyzer PDF', () => {
  const table = buildContactsTable(PARTNER, [
    { contact_id: 'pct_a', name: 'Jane Doe', email: 'jane@insight.com', phone: '555-0100' },
  ], new Map());

  const headers = findAll(table, 'th').map(th => th.textContent);
  assert.deepEqual(headers, ['Name', 'Role', 'Company', 'Email', 'Analyzer PDF', 'Sources', 'Actions']);
  assert.ok(!headers.includes('Phone'), 'Phone column must be gone');
  assert.equal(headers.length, 7, 'column count is unchanged, so the mobile card layout still holds');
});

test('a contact phone number is no longer rendered into the table', () => {
  const table = buildContactsTable(PARTNER, [
    { contact_id: 'pct_a', name: 'Jane Doe', phone: '555-0100' },
  ], new Map());
  assert.ok(!table.textContent.includes('555-0100'),
    'the phone number must not leak into any cell');
});

// ── The cell ────────────────────────────────────────────────────────

test('a contact with a brief gets a link to its Drive URL', () => {
  const index = indexContactAnalyzerPdfs([
    docRow({ opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_Doe_2026-07-20.pdf', drive_url: 'https://drive.google.com/file/d/abc/view' }),
  ]);

  const cell = contactAnalyzerPdfCell({ contact_id: 'pct_a', name: 'Jane Doe' }, index);
  assert.equal(cell.tagName, 'A');
  assert.equal(cell.getAttribute('href'), 'https://drive.google.com/file/d/abc/view');
  assert.equal(cell.getAttribute('target'), '_blank');
  assert.equal(cell.getAttribute('rel'), 'noopener');
  assert.equal(cell.getAttribute('title'), 'Account_Brief_Jane_Doe_2026-07-20.pdf');
  assert.match(cell.textContent, /Brief/);
});

test('the link is dated so a stale brief is visible at a glance', () => {
  const index = indexContactAnalyzerPdfs([
    docRow({ opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-07-20.pdf', drive_url: 'https://drive/x' }),
  ]);
  const cell = contactAnalyzerPdfCell({ contact_id: 'pct_a' }, index);
  assert.match(cell.textContent, /Brief · /, 'the cell should carry the brief date');
});

test('a contact with no brief gets a dash, never a dead link', () => {
  const index = indexContactAnalyzerPdfs([
    docRow({ opportunity_id: 'pct_other', file_name: 'Account_Brief_Rob_2026-07-20.pdf', drive_url: 'https://drive/rob' }),
  ]);

  const cell = contactAnalyzerPdfCell({ contact_id: 'pct_a', name: 'Jane Doe' }, index);
  assert.notEqual(cell.tagName, 'A', 'must not render an anchor when there is nothing to open');
  assert.equal(cell.textContent, '—');
});

test('another contact’s brief never appears on this row', () => {
  const index = indexContactAnalyzerPdfs([
    docRow({ opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-07-20.pdf', drive_url: 'https://drive/jane' }),
    docRow({ _rowIndex: 3, opportunity_id: 'pct_b', file_name: 'Account_Brief_Rob_2026-07-21.pdf', drive_url: 'https://drive/rob' }),
  ]);

  assert.equal(contactAnalyzerPdfCell({ contact_id: 'pct_a' }, index).getAttribute('href'), 'https://drive/jane');
  assert.equal(contactAnalyzerPdfCell({ contact_id: 'pct_b' }, index).getAttribute('href'), 'https://drive/rob');
});

test('an attached brief with no resolved Drive link is reported, not hidden', () => {
  const index = indexContactAnalyzerPdfs([
    docRow({ opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-07-20.pdf', drive_url: '' }),
  ]);

  const cell = contactAnalyzerPdfCell({ contact_id: 'pct_a' }, index);
  assert.notEqual(cell.tagName, 'A');
  assert.match(cell.textContent, /no link/, 'the brief exists — saying "—" would be false');
  assert.match(cell.getAttribute('title') || '', /attached to this contact/);
});

test('a manually uploaded PDF on a contact is not presented as an Analyzer brief', () => {
  const index = indexContactAnalyzerPdfs([
    docRow({ opportunity_id: 'pct_a', file_name: 'Jane Doe signed NDA.pdf', drive_url: 'https://drive/nda' }),
  ]);
  assert.equal(contactAnalyzerPdfCell({ contact_id: 'pct_a' }, index).textContent, '—');
});

test('the cell survives a missing index and a contact with no id', () => {
  assert.equal(contactAnalyzerPdfCell({ contact_id: 'pct_a' }, null).textContent, '—');
  assert.equal(contactAnalyzerPdfCell({}, new Map()).textContent, '—');
  assert.equal(contactAnalyzerPdfCell(null, new Map()).textContent, '—');
});

test('the newest brief is the one linked when a contact has been re-analyzed', () => {
  const index = indexContactAnalyzerPdfs([
    docRow({ _rowIndex: 2, opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-05-01.pdf', drive_url: 'https://drive/old' }),
    docRow({ _rowIndex: 3, opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-07-20.pdf', drive_url: 'https://drive/new' }),
  ]);
  assert.equal(contactAnalyzerPdfCell({ contact_id: 'pct_a' }, index).getAttribute('href'), 'https://drive/new');
});
