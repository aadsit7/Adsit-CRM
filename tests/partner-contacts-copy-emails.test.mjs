// ============================================================
// Partner Contacts — the "Copy Emails" picker
// ============================================================
// The Contacts header carries a copy button that opens a picker: check the
// people you want and their email addresses go on the clipboard, ready to
// paste into the To: line of an email. These tests pin the contract that
// makes it safe to paste:
//   • emails ONLY — no names, roles, companies or other roster columns
//   • the addresses come out in the order the section lists them
//   • an address on two contacts is copied once (no duplicate recipient)
//   • a contact with no email is listed but cannot be selected
//   • unchecking a row removes exactly that address, nothing else
//   • the preview string is character-for-character what gets copied
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
    this.checked = false;
    this.indeterminate = false;
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
  // textContent is writable here (unlike the read-only shim the older view
  // tests use): the picker sets it to relabel the Copy button and to fill
  // the "what gets copied" preview, which is exactly what is asserted.
  setAttribute(k, v) {
    this._attrs[k] = v;
    if (k === 'disabled') this.disabled = !!v;
  }
  getAttribute(k) { return this._attrs[k] ?? null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  remove() {}
  get isConnected() { return false; }
  get textContent() {
    if (this._text !== undefined) return this._text;
    return this._children.map(c => c.textContent || '').join('')
      + String(this.innerHTML || '').replace(/<[^>]+>/g, '');
  }
  set textContent(v) { this._text = String(v); this._children = []; }
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

import {
  __partnerContactEmailCopyInternals,
  __partnerContactsTableInternals,
} from '../js/views/admin-partner-detail.js';

const {
  contactEmailAddress,
  contactEmailList,
  contactEmailListText,
  buildContactEmailPicker,
} = __partnerContactEmailCopyInternals;
const { buildPartnerContactsSection } = __partnerContactsTableInternals;

const PARTNER = { partner_id: 'p_1', display_name: 'Insight Enterprises' };

const contact = (name, email, extra = {}) => ({
  contact_id: `pct_${name.replace(/\W/g, '')}`,
  name,
  email,
  role: '',
  company: 'Insight Enterprises',
  ...extra,
});

const ROSTER = [
  contact('Jane Doe', 'jane@insight.com', { role: 'VP Alliances' }),
  contact('Rob Neal', 'rob@insight.com', { role: 'Director, Modern Work' }),
  contact('Priya Shah', 'priya@insight.com'),
];

// Fire the change listeners el() attached, the way a click on the label would.
function toggle(input, checked) {
  input.checked = checked;
  (input._listeners.change || []).forEach(fn => fn());
}

function clickCopy(picker) {
  (picker.copyButton._listeners.click || []).forEach(fn => fn());
}

// Walk the fake tree collecting every element with a given tag.
function findAll(node, tag, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.tagName === String(tag).toUpperCase()) out.push(node);
  for (const c of node._children || []) findAll(c, tag, out);
  return out;
}

// ── The address list ────────────────────────────────────────────────

test('addresses come out in roster order, trimmed', () => {
  assert.deepEqual(
    contactEmailList([contact('A', '  a@x.com '), contact('B', 'b@x.com')]),
    ['a@x.com', 'b@x.com'],
  );
});

test('a contact with no email contributes nothing', () => {
  assert.deepEqual(
    contactEmailList([contact('A', ''), contact('B', 'b@x.com'), contact('C', '   ')]),
    ['b@x.com'],
  );
  assert.deepEqual(contactEmailList([]), []);
  assert.deepEqual(contactEmailList(null), []);
});

test('the same address on two contacts is copied once', () => {
  // Two rows for one shared alias (or a duplicate the scan created) must not
  // become two recipients on the email.
  assert.deepEqual(
    contactEmailList([
      contact('Jane', 'jane@insight.com'),
      contact('Jane D.', 'JANE@Insight.com'),
      contact('Rob', 'rob@insight.com'),
    ]),
    ['jane@insight.com', 'rob@insight.com'],
    'dedupe is case-insensitive and keeps the first row’s casing',
  );
});

test('the clipboard string is comma-separated addresses and nothing else', () => {
  const text = contactEmailListText(ROSTER);
  assert.equal(text, 'jane@insight.com, rob@insight.com, priya@insight.com');
  for (const noise of ['Jane Doe', 'VP Alliances', 'Insight Enterprises', 'pct_']) {
    assert.ok(!text.includes(noise), `${noise} must not reach the clipboard`);
  }
});

test('contactEmailAddress survives a missing contact or field', () => {
  assert.equal(contactEmailAddress(null), '');
  assert.equal(contactEmailAddress({}), '');
  assert.equal(contactEmailAddress({ email: '  x@y.com ' }), 'x@y.com');
});

// ── The picker ──────────────────────────────────────────────────────

test('everyone with an email starts checked, so one click copies the roster', () => {
  const copied = [];
  const picker = buildContactEmailPicker(ROSTER, { onCopy: e => copied.push(e) });

  assert.equal(picker.rowInputs.length, 3);
  assert.ok(picker.rowInputs.every(r => r.input.checked), 'all mailable rows start selected');
  assert.equal(picker.selectAllInput.checked, true);
  assert.equal(picker.copyButton.disabled, false);
  assert.equal(picker.copyButton.textContent, 'Copy 3 emails');

  clickCopy(picker);
  assert.deepEqual(copied, [['jane@insight.com', 'rob@insight.com', 'priya@insight.com']]);
});

test('unchecking a row removes exactly that address', () => {
  const copied = [];
  const picker = buildContactEmailPicker(ROSTER, { onCopy: e => copied.push(e) });

  toggle(picker.rowInputs[1].input, false);
  assert.equal(picker.copyButton.textContent, 'Copy 2 emails');
  assert.equal(picker.selectAllInput.checked, false);
  assert.equal(picker.selectAllInput.indeterminate, true);

  clickCopy(picker);
  assert.deepEqual(copied, [['jane@insight.com', 'priya@insight.com']]);
});

test('one contact can be picked on its own', () => {
  const copied = [];
  const picker = buildContactEmailPicker(ROSTER, { onCopy: e => copied.push(e) });

  picker.rowInputs.forEach(({ input }) => toggle(input, false));
  toggle(picker.rowInputs[2].input, true);

  assert.equal(picker.copyButton.textContent, 'Copy 1 email');
  clickCopy(picker);
  assert.deepEqual(copied, [['priya@insight.com']]);
});

test('with nothing checked the Copy button is disabled and copies nothing', () => {
  const copied = [];
  const picker = buildContactEmailPicker(ROSTER, { onCopy: e => copied.push(e) });

  picker.rowInputs.forEach(({ input }) => toggle(input, false));
  assert.equal(picker.copyButton.disabled, true);
  assert.equal(picker.copyButton.textContent, 'Copy');
  assert.equal(picker.selectAllInput.indeterminate, false);

  clickCopy(picker);
  assert.deepEqual(copied, [], 'a disabled Copy must never reach the clipboard');
});

test('Select all clears and restores the whole roster', () => {
  const picker = buildContactEmailPicker(ROSTER, { onCopy: () => {} });
  const fireSelectAll = (checked) => {
    picker.selectAllInput.checked = checked;
    (picker.selectAllInput._listeners.change || []).forEach(fn => fn());
  };

  fireSelectAll(false);
  assert.deepEqual(picker.selectedEmails(), []);
  assert.ok(picker.rowInputs.every(r => r.input.checked === false));

  fireSelectAll(true);
  assert.deepEqual(picker.selectedEmails(),
    ['jane@insight.com', 'rob@insight.com', 'priya@insight.com']);
  assert.ok(picker.rowInputs.every(r => r.input.checked === true));
});

test('a contact with no email is listed but cannot be selected', () => {
  const roster = [
    contact('Jane Doe', 'jane@insight.com'),
    contact('Silent Sam', ''),
  ];
  const picker = buildContactEmailPicker(roster, { onCopy: () => {} });

  assert.equal(picker.rowInputs.length, 1, 'only the mailable contact is selectable');
  const boxes = findAll(picker.body, 'input');
  // select-all + one row per contact — nobody is dropped from the list
  assert.equal(boxes.length, 3);
  assert.equal(boxes[2].disabled, true, 'the email-less row’s checkbox is disabled');
  assert.equal(boxes[2].checked, false);

  const text = picker.body.textContent;
  assert.ok(text.includes('Silent Sam'), 'the person is still shown, not silently dropped');
  assert.ok(text.includes('No email on file'), 'and the reason they cannot be picked is stated');
  assert.deepEqual(picker.selectedEmails(), ['jane@insight.com']);
});

test('a roster where nobody has an email offers nothing to copy', () => {
  const picker = buildContactEmailPicker([contact('Silent Sam', '')], { onCopy: () => {} });
  assert.equal(picker.copyButton.disabled, true);
  assert.equal(picker.selectAllInput.disabled, true);
  assert.deepEqual(picker.selectedEmails(), []);
});

test('duplicates are deduped in the picker too, and the count matches', () => {
  const picker = buildContactEmailPicker([
    contact('Jane Doe', 'jane@insight.com'),
    contact('J. Doe', 'Jane@Insight.com'),
  ], { onCopy: () => {} });

  assert.equal(picker.rowInputs.length, 2, 'both rows are still shown and checkable');
  assert.deepEqual(picker.selectedEmails(), ['jane@insight.com']);
  assert.equal(picker.copyButton.textContent, 'Copy 1 email',
    'the button counts recipients, not rows');
});

test('the preview shows exactly the string that will be copied', () => {
  const picker = buildContactEmailPicker(ROSTER, { onCopy: () => {} });
  const previewText = () => {
    const [preview] = findAll(picker.body, 'div')
      .filter(d => d.classList.contains('partner-contacts-copy__preview'));
    return preview.textContent;
  };

  assert.equal(previewText(), contactEmailListText(ROSTER));

  toggle(picker.rowInputs[0].input, false);
  assert.equal(previewText(), 'rob@insight.com, priya@insight.com');

  picker.rowInputs.forEach(({ input }) => toggle(input, false));
  assert.match(previewText(), /Nobody selected/);
});

// ── The header button ───────────────────────────────────────────────

test('the Contacts header carries the copy button when there are contacts', () => {
  const section = buildPartnerContactsSection(PARTNER, ROSTER, new Map());
  const copyBtn = findAll(section, 'button')
    .find(b => b.getAttribute('aria-label') === 'Copy contact emails');

  assert.ok(copyBtn, 'the copy button sits in the Contacts section header');
  assert.equal(copyBtn.getAttribute('data-label'), 'Copy Emails',
    'phones re-attach the visible label from data-label');
  assert.ok(copyBtn.className.includes('partner-detail-page__section-cta--icon'),
    'it uses the same icon-only CTA idiom as the other section copy buttons');
});

test('an empty roster shows no copy button — there is nothing to copy', () => {
  const section = buildPartnerContactsSection(PARTNER, [], new Map());
  const copyBtn = findAll(section, 'button')
    .find(b => b.getAttribute('aria-label') === 'Copy contact emails');
  assert.equal(copyBtn, undefined);
});
