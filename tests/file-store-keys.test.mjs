// ============================================================
// Tests for the file-store key + legacy attachment migration
// ============================================================
// Every attachment lives in ONE untyped namespace keyed by a record id, so two
// records of different types that share an id share a document list. The app's
// generated ids are prefixed and cannot collide; records seeded before that
// convention are numbered from 1 and do. These tests pin:
//   • fileStoreKey qualifies a legacy id and is a no-op for a prefixed one
//     (so existing attachments stay attached), and is idempotent
//   • the collision it exists to prevent genuinely cannot happen afterwards
//   • the migration resolves each legacy row to its real owner, refuses to
//     guess when it can't, and is safe to re-run
//   • only the id cell is ever written
// ============================================================

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENTITY_ID_PREFIXES,
  hasEntityPrefix,
  fileStoreKey,
  planDocumentKeyMigration,
  legacyFileStoreKey,
  legacyRowBelongsTo,
  resolveDocumentKeyWrites,
  documentKeyColumnLetter,
  describeDocumentKeyPlan,
} from '../js/utils/file-store-keys.js';

const HEADERS = ['doc_id', 'opportunity_id', 'customer_name', 'file_name', 'mime_type', 'drive_url', 'date_added', 'analyzed'];
const KEY_COL = documentKeyColumnLetter(HEADERS);

// ── The key ─────────────────────────────────────────────────────────

test('a legacy bare id gets its type prefix', () => {
  assert.equal(fileStoreKey('partner', '4'), 'p_4');
  assert.equal(fileStoreKey('event', '4'), 'evt_4');
  assert.equal(fileStoreKey('opportunity', '12'), 'opp_12');
  assert.equal(fileStoreKey('contact', '9'), 'pct_9');
});

// This is the whole point: partner 4 and event 4 were the same bucket.
test('a partner and an event sharing a numeric id no longer share a bucket', () => {
  assert.notEqual(fileStoreKey('partner', '4'), fileStoreKey('event', '4'));
  for (const id of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    const keys = new Set([
      fileStoreKey('partner', id),
      fileStoreKey('event', id),
      fileStoreKey('opportunity', id),
      fileStoreKey('contact', id),
    ]);
    assert.equal(keys.size, 4, `id ${id} still collides across entity types`);
  }
});

// An id the app generated must key exactly as it always has, or every existing
// attachment on that record silently disappears.
test('an already-prefixed id is returned untouched', () => {
  for (const id of ['p_1aw6j73z8pfg', 'evt_dx08xw1sult0q', 'opp_diysa512mwaza', 'pct_1nctka1rbedq']) {
    assert.equal(fileStoreKey('partner', id), id);
    assert.equal(fileStoreKey('event', id), id);
  }
});

test('fileStoreKey is idempotent', () => {
  const once = fileStoreKey('partner', '4');
  assert.equal(fileStoreKey('partner', once), once);
  assert.equal(fileStoreKey('partner', fileStoreKey('partner', once)), once);
});

test('a mistyped call cannot re-tag an id that already declares its type', () => {
  // Guards against `p_opp_…` if a call site ever passes the wrong entity type.
  assert.equal(fileStoreKey('partner', 'opp_abc'), 'opp_abc');
  assert.equal(fileStoreKey('event', 'pct_abc'), 'pct_abc');
});

test('a blank id stays blank so "no record yet" still reads as no record', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.equal(fileStoreKey('partner', v), '');
  }
});

test('an unknown entity type returns the id unchanged rather than inventing a namespace', () => {
  assert.equal(fileStoreKey('sasquatch', '4'), '4');
});

test('ids are trimmed before keying', () => {
  assert.equal(fileStoreKey('partner', '  4  '), 'p_4');
  assert.equal(fileStoreKey('partner', ' p_abc '), 'p_abc');
});

test('hasEntityPrefix recognizes every documented prefix and nothing else', () => {
  for (const p of Object.values(ENTITY_ID_PREFIXES)) {
    assert.equal(hasEntityPrefix(`${p}xyz`), true, `${p} should be recognized`);
  }
  for (const id of ['4', 'partner_4', 'x_4', '', null]) {
    assert.equal(hasEntityPrefix(id), false, `${String(id)} should not look prefixed`);
  }
});

// ── The migration plan ──────────────────────────────────────────────

const PARTNERS = [
  { partner_id: '4', display_name: 'Insight' },
  { partner_id: '6', display_name: 'Nerdio' },
  { partner_id: '7', display_name: 'Qualcomm' },
  { partner_id: 'p_1aw6j73z8pfg', display_name: 'Flexera' },
];
const EVENTS = [
  { event_id: '4', title: 'Roundtable #2 — Boardroom briefing' },
  { event_id: '7', title: 'Roundtable #2 — Healthcare' },
  { event_id: 'evt_dx08xw1sult0q', title: 'Q1 Free Tools Webinar' },
];

function docRow(fields) {
  return {
    _rowIndex: 2, doc_id: 'DOC1', opportunity_id: '', customer_name: '',
    file_name: 'file.pdf', mime_type: 'application/pdf', drive_url: 'https://drive/x',
    date_added: '2026-07-25', analyzed: 'FALSE',
    ...fields,
  };
}

test('a shared id is resolved to the record whose name matches the Drive folder', () => {
  const plan = planDocumentKeyMigration({
    documentRows: [
      // id 4 belongs to BOTH partner Insight and an event — the folder decides.
      docRow({ _rowIndex: 56, opportunity_id: '4', customer_name: 'Insight', file_name: 'Insight_GTM.pdf' }),
      docRow({ _rowIndex: 38, opportunity_id: '7', customer_name: 'Roundtable #2 — Healthcare', file_name: 'Attendees.pdf' }),
    ],
    partners: PARTNERS,
    events: EVENTS,
  });

  assert.equal(plan.ambiguous.length, 0);
  assert.deepEqual(plan.changes.map(c => [c.from, c.to, c.entityType]), [
    ['4', 'p_4', 'partner'],
    ['7', 'evt_7', 'event'],
  ]);
});

test('an id only one record type claims resolves even when the folder does not match', () => {
  // No event 6 exists, so a row keyed 6 can only be partner 6's.
  const plan = planDocumentKeyMigration({
    documentRows: [docRow({ _rowIndex: 54, opportunity_id: '6', customer_name: 'renamed since upload' })],
    partners: PARTNERS,
    events: EVENTS,
  });
  assert.equal(plan.ambiguous.length, 0);
  assert.deepEqual(plan.changes.map(c => c.to), ['p_6']);
});

test('a shared id whose folder matches neither record is left alone, not guessed', () => {
  const plan = planDocumentKeyMigration({
    documentRows: [docRow({ opportunity_id: '4', customer_name: 'Something Else Entirely' })],
    partners: PARTNERS,
    events: EVENTS,
  });
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.ambiguous.length, 1);
  assert.match(plan.ambiguous[0].reason, /does not identify/);
});

test('a partner and an event with the same id AND the same name stay ambiguous', () => {
  const plan = planDocumentKeyMigration({
    documentRows: [docRow({ opportunity_id: '9', customer_name: 'Roadshow' })],
    partners: [{ partner_id: '9', display_name: 'Roadshow' }],
    events: [{ event_id: '9', title: 'Roadshow' }],
  });
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.ambiguous.length, 1);
});

test('a bare id no record claims is reported, never rewritten', () => {
  const plan = planDocumentKeyMigration({
    documentRows: [docRow({ opportunity_id: '999', customer_name: 'Ghost' })],
    partners: PARTNERS,
    events: EVENTS,
  });
  assert.equal(plan.changes.length, 0);
  assert.match(plan.ambiguous[0].reason, /No partner or event has this id/);
});

test('already-qualified rows are counted and never touched', () => {
  const plan = planDocumentKeyMigration({
    documentRows: [
      docRow({ opportunity_id: 'opp_diysa512mwaza', customer_name: 'Acme' }),
      docRow({ _rowIndex: 3, opportunity_id: 'pct_1nctka1rbedq', customer_name: 'Jane Doe' }),
      docRow({ _rowIndex: 4, opportunity_id: 'p_1aw6j73z8pfg', customer_name: 'Flexera' }),
    ],
    partners: PARTNERS,
    events: EVENTS,
  });
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.ambiguous.length, 0);
  assert.equal(plan.alreadyQualified, 3);
});

test('folder matching ignores case and whitespace noise', () => {
  const plan = planDocumentKeyMigration({
    documentRows: [docRow({ opportunity_id: '4', customer_name: '  INSIGHT  ' })],
    partners: PARTNERS,
    events: EVENTS,
  });
  assert.deepEqual(plan.changes.map(c => c.to), ['p_4']);
});

test('the plan is idempotent — applying it and re-planning finds nothing', () => {
  const rows = [
    docRow({ _rowIndex: 56, opportunity_id: '4', customer_name: 'Insight' }),
    docRow({ _rowIndex: 38, opportunity_id: '7', customer_name: 'Roundtable #2 — Healthcare' }),
  ];
  const first = planDocumentKeyMigration({ documentRows: rows, partners: PARTNERS, events: EVENTS });
  const applied = rows.map(r => {
    const c = first.changes.find(x => x.rowIndex === r._rowIndex);
    return c ? { ...r, opportunity_id: c.to } : r;
  });
  const second = planDocumentKeyMigration({ documentRows: applied, partners: PARTNERS, events: EVENTS });
  assert.equal(second.changes.length, 0);
  assert.equal(second.ambiguous.length, 0);
  assert.equal(second.alreadyQualified, 2);
});

test('planDocumentKeyMigration tolerates empty / malformed input', () => {
  for (const input of [undefined, {}, { documentRows: null }, { documentRows: [null, 'x', {}] }]) {
    const plan = planDocumentKeyMigration(input);
    assert.equal(plan.changes.length, 0);
    assert.equal(plan.ambiguous.length, 0);
  }
});

// ── An id claimed by another record type is never assumed ───────────

test('a bare id an opportunity also uses is left alone, not swept onto the partner', () => {
  const rows = [docRow({ opportunity_id: '4', customer_name: 'Some Customer Inc' })];
  // Without the opportunity, the single-claimant rule would assign it to
  // partner 4 (no event 4 in this fixture).
  const naive = planDocumentKeyMigration({ documentRows: rows, partners: [PARTNERS[0]], events: [] });
  assert.deepEqual(naive.changes.map(c => c.to), ['p_4']);

  const guarded = planDocumentKeyMigration({
    documentRows: rows, partners: [PARTNERS[0]], events: [],
    opportunities: [{ opportunity_id: '4' }],
  });
  assert.equal(guarded.changes.length, 0);
  assert.match(guarded.ambiguous[0].reason, /Another record type also uses this id/);
});

test('a bare id a contact also uses is left alone too', () => {
  const guarded = planDocumentKeyMigration({
    documentRows: [docRow({ opportunity_id: '4', customer_name: 'whatever' })],
    partners: [PARTNERS[0]], events: [],
    contacts: [{ contact_id: '4' }],
  });
  assert.equal(guarded.changes.length, 0);
});

test('prefixed opportunity and contact ids do not make anything ambiguous', () => {
  const plan = planDocumentKeyMigration({
    documentRows: [docRow({ opportunity_id: '4', customer_name: 'Insight' })],
    partners: PARTNERS, events: EVENTS,
    opportunities: [{ opportunity_id: 'opp_diysa512mwaza' }],
    contacts: [{ contact_id: 'pct_1nctka1rbedq' }],
  });
  assert.deepEqual(plan.changes.map(c => c.to), ['p_4']);
});

// ── The write: identity is doc_id, never a row number ───────────────
// Removing an attachment runs sheet.deleteRow() in the Apps Script, which
// physically shifts every row below it up. A row index captured when the plan
// was built therefore cannot be trusted at write time.

test('the cell to write is resolved from doc_id against the sheet as it is now', () => {
  const rows = [
    docRow({ _rowIndex: 56, doc_id: 'DOC_A', opportunity_id: '4', customer_name: 'Insight' }),
    docRow({ _rowIndex: 38, doc_id: 'DOC_B', opportunity_id: '7', customer_name: 'Roundtable #2 — Healthcare' }),
  ];
  const plan = planDocumentKeyMigration({ documentRows: rows, partners: PARTNERS, events: EVENTS });

  // The same documents, but every row has shifted up by one since the plan.
  const shifted = rows.map(r => ({ ...r, _rowIndex: r._rowIndex - 1 }));
  const { updates, stale } = resolveDocumentKeyWrites(plan, shifted, KEY_COL);

  assert.equal(stale.length, 0);
  assert.deepEqual(updates.sort((a, b) => a.a1.localeCompare(b.a1)), [
    { a1: 'B37', value: 'evt_7' },   // followed DOC_B, not row 38
    { a1: 'B55', value: 'p_4' },     // followed DOC_A, not row 56
  ]);
});

test('a document deleted since the plan is reported, never written', () => {
  const rows = [docRow({ _rowIndex: 56, doc_id: 'DOC_A', opportunity_id: '4', customer_name: 'Insight' })];
  const plan = planDocumentKeyMigration({ documentRows: rows, partners: PARTNERS, events: EVENTS });

  const { updates, stale } = resolveDocumentKeyWrites(plan, [], KEY_COL);
  assert.equal(updates.length, 0);
  assert.equal(stale.length, 1);
  assert.match(stale[0].reason, /no longer in the sheet/);
});

test('a document already re-keyed by someone else is reported, never written twice', () => {
  const rows = [docRow({ _rowIndex: 56, doc_id: 'DOC_A', opportunity_id: '4', customer_name: 'Insight' })];
  const plan = planDocumentKeyMigration({ documentRows: rows, partners: PARTNERS, events: EVENTS });

  const applied = [{ ...rows[0], opportunity_id: 'p_4' }];
  const { updates, stale } = resolveDocumentKeyWrites(plan, applied, KEY_COL);
  assert.equal(updates.length, 0);
  assert.match(stale[0].reason, /is now “p_4”/);
});

test('nothing is written when the sheet has no opportunity_id column', () => {
  const rows = [docRow({ _rowIndex: 56, doc_id: 'DOC_A', opportunity_id: '4', customer_name: 'Insight' })];
  const plan = planDocumentKeyMigration({ documentRows: rows, partners: PARTNERS, events: EVENTS });

  assert.equal(documentKeyColumnLetter(['doc_id', 'customer_name']), '');
  const { updates, stale } = resolveDocumentKeyWrites(plan, rows, documentKeyColumnLetter(['doc_id', 'customer_name']));
  assert.equal(updates.length, 0);
  assert.match(stale[0].reason, /no opportunity_id column/);
});

test('the key column is derived from the header, not assumed to be B', () => {
  assert.equal(documentKeyColumnLetter(HEADERS), 'B');
  // Someone inserted a column in front — writes must follow it.
  assert.equal(documentKeyColumnLetter(['uploaded_by', ...HEADERS]), 'C');
  assert.equal(documentKeyColumnLetter([]), '');
});

test('a change whose row cannot be identified is reported, never written', () => {
  const stale = resolveDocumentKeyWrites(
    { changes: [{ docId: '', from: '4', to: 'p_4', fileName: 'x.pdf' }] }, [], 'B',
  ).stale;
  assert.equal(stale.length, 1);
  assert.match(stale[0].reason, /no doc_id/);
});

test('resolveDocumentKeyWrites tolerates empty / malformed input', () => {
  assert.deepEqual(resolveDocumentKeyWrites(null, null, 'B'), { updates: [], stale: [] });
  assert.deepEqual(resolveDocumentKeyWrites({ changes: [] }, [null, 'x'], 'B'), { updates: [], stale: [] });
});

// ── The summary both the preview and the toast read from ────────────

test('describeDocumentKeyPlan states the outcome plainly', () => {
  assert.match(describeDocumentKeyPlan({ changes: [], ambiguous: [], alreadyQualified: 57 }),
    /Nothing to migrate/);
  assert.match(describeDocumentKeyPlan({ changes: [1, 2], ambiguous: [], alreadyQualified: 53 }),
    /2 attachments to re-key/);
  assert.match(describeDocumentKeyPlan({ changes: [1], ambiguous: [1], alreadyQualified: 0 }),
    /1 attachment to re-key, 1 needing a manual decision/);
});

// ── The transition bridge ───────────────────────────────────────────
// Reads start asking for the qualified key the moment this ships, while the
// rows still hold the bare one until the repair is run. Without the bridge,
// real documents would vanish from real records in between.

test('legacyFileStoreKey returns the bare key only for a legacy record', () => {
  assert.equal(legacyFileStoreKey('partner', '4'), '4');
  assert.equal(legacyFileStoreKey('event', '7'), '7');
  // Already prefixed — nothing was ever filed anywhere else.
  assert.equal(legacyFileStoreKey('partner', 'p_1aw6j73z8pfg'), '');
  assert.equal(legacyFileStoreKey('event', 'evt_dx08xw1sult0q'), '');
  // Nothing to bridge for a blank id, or a type whose key never changes.
  assert.equal(legacyFileStoreKey('partner', ''), '');
  assert.equal(legacyFileStoreKey('sasquatch', '4'), '');
});

test('the bridge admits only rows whose folder names this record', () => {
  // The bare key is the SHARED bucket — this filter is what stops the bridge
  // from re-creating the very cross-listing the change exists to fix.
  const eventRow = { customer_name: 'Roundtable #2 — Healthcare', file_name: 'Attendees.pdf' };
  assert.equal(legacyRowBelongsTo(eventRow, 'Roundtable #2 — Healthcare'), true);
  assert.equal(legacyRowBelongsTo(eventRow, 'Qualcomm'), false, 'partner 7 must not see event 7’s file');
});

test('the bridge matches folder names case- and whitespace-insensitively', () => {
  assert.equal(legacyRowBelongsTo({ customer_name: '  INSIGHT ' }, 'Insight'), true);
  assert.equal(legacyRowBelongsTo({ customer_name: 'Round   table' }, 'Round table'), true);
});

test('the bridge refuses a row with no folder, and a record with no name', () => {
  assert.equal(legacyRowBelongsTo({ customer_name: '' }, 'Insight'), false);
  assert.equal(legacyRowBelongsTo({ customer_name: 'Insight' }, ''), false);
  assert.equal(legacyRowBelongsTo(null, 'Insight'), false);
});

test('the bridge and the migration agree about who owns a row', () => {
  // Whatever the bridge shows a record today is exactly what the repair will
  // file to that record permanently — otherwise documents would appear to move
  // when the admin runs it.
  const rows = [
    docRow({ _rowIndex: 56, doc_id: 'A', opportunity_id: '4', customer_name: 'Insight' }),
    docRow({ _rowIndex: 38, doc_id: 'B', opportunity_id: '7', customer_name: 'Roundtable #2 — Healthcare' }),
  ];
  const plan = planDocumentKeyMigration({ documentRows: rows, partners: PARTNERS, events: EVENTS });

  for (const [contextName, type] of [['Insight', 'partner'], ['Roundtable #2 — Healthcare', 'event']]) {
    const bridged = rows.filter(r => legacyRowBelongsTo(r, contextName));
    const planned = plan.changes.filter(c => c.entityLabel === contextName);
    assert.equal(bridged.length, planned.length, `${contextName}: bridge and plan disagree on count`);
    assert.equal(planned.every(c => c.entityType === type), true);
    assert.deepEqual(bridged.map(r => r.doc_id).sort(), planned.map(c => c.docId).sort());
  }
});
