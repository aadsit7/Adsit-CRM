// ============================================================
// Tests for the ID-addressed write helpers in js/sheets.js
// ============================================================
// A row number is not an identity in a spreadsheet: deleting any row shifts
// every row beneath it up by one, so an index captured when a page loaded can
// address a different record later — and these writes replace a WHOLE row, so
// landing on the wrong one destroys it. findRowById / updateRowById /
// deleteRowById resolve the row from its own key at write time instead.
//
// These run against demo mode (no spreadsheet configured), which is the same
// code path minus the network: readSheetAsObjects serves the demo arrays and
// updateRow/deleteRow dispatch to their demo twins. The demo store is seeded
// and shared, so every test uses its own ids and asserts only about those.
// ============================================================

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// No spreadsheet id → isConfigured() is false → the demo store is used.
globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID_HERE',
  API_KEY: '',
}));

const {
  findRowById, updateRowById, deleteRowById, updateRow,
  readSheetAsObjects, addDemoRow, invalidateSheetCache, isConfigured,
} = await import('../js/sheets.js');

const { CONFIG } = await import('../js/config.js');
const SHEET = CONFIG.SHEET_PARTNERS;

assert.equal(isConfigured(), false, 'these tests must run against the demo store');

let seq = 0;
/** Unique ids per test, so tests never collide in the shared demo store. */
function ids(n) {
  const tag = `t${++seq}`;
  return Array.from({ length: n }, (_, i) => `p_${tag}_${i}`);
}

function partnerRow(id, name, extra = {}) {
  return [
    id, `${id}user`, name, extra.type || 'MSP', extra.tier || 'Gold',
    extra.region || 'NA', '2026-01-01', '', 'HASH',
    extra.status || 'Active', 'Denver',
  ];
}

function addPartners(rows) {
  for (const r of rows) addDemoRow(SHEET, r);
  invalidateSheetCache();
}

const nameOf = async (id) => {
  const rows = await readSheetAsObjects(SHEET, { forceRefresh: true });
  const r = rows.find(x => x.partner_id === id);
  return r ? r.display_name : null;
};

// ── Finding ─────────────────────────────────────────────────────────

test('findRowById resolves the row by its key, not its position', async () => {
  const [a, b, c] = ids(3);
  addPartners([partnerRow(a, 'Alpha'), partnerRow(b, 'Beta'), partnerRow(c, 'Gamma')]);

  const row = await findRowById(SHEET, 'partner_id', b);
  assert.equal(row.display_name, 'Beta');
  assert.ok(row._rowIndex > 1, 'the row carries its current index');
});

test('findRowById follows a record after a row above it is deleted', async () => {
  // The exact hazard: a delete shifts the rows beneath it, and a remembered
  // index would now address a different partner.
  const [a, b, c] = ids(3);
  addPartners([partnerRow(a, 'Alpha'), partnerRow(b, 'Beta'), partnerRow(c, 'Gamma')]);
  const before = await findRowById(SHEET, 'partner_id', c);

  await deleteRowById(SHEET, 'partner_id', a);

  const after = await findRowById(SHEET, 'partner_id', c);
  assert.equal(after.display_name, 'Gamma', 'still the same record');
  assert.equal(after._rowIndex, before._rowIndex - 1, 'and it really did move up one');
});

test('findRowById refuses when the record is gone rather than guessing', async () => {
  await assert.rejects(
    () => findRowById(SHEET, 'partner_id', 'p_definitely_missing'),
    (err) => {
      assert.equal(err.code, 'ROW_ID_NOT_RESOLVED');
      assert.match(err.message, /no longer in/);
      return true;
    },
  );
});

test('findRowById refuses when two rows share an id', async () => {
  // Duplicate ids mean the sheet is already inconsistent; picking one would
  // compound it invisibly.
  const [dup] = ids(1);
  addPartners([partnerRow(dup, 'First'), partnerRow(dup, 'Second')]);

  await assert.rejects(
    () => findRowById(SHEET, 'partner_id', dup),
    (err) => {
      assert.match(err.message, /2 rows .* share/);
      assert.match(err.message, /de-duplicate/);
      return true;
    },
  );
});

test('findRowById refuses a blank id', async () => {
  for (const bad of ['', '   ', null, undefined]) {
    await assert.rejects(() => findRowById(SHEET, 'partner_id', bad), /no partner_id was given/);
  }
});

test('findRowById trims both sides before comparing', async () => {
  const [a] = ids(1);
  addPartners([partnerRow(a, 'Alpha')]);
  assert.equal((await findRowById(SHEET, 'partner_id', `  ${a}  `)).display_name, 'Alpha');
});

// ── Updating ────────────────────────────────────────────────────────

test('updateRowById writes to the record, not to a remembered position', async () => {
  const [a, b, c] = ids(3);
  addPartners([partnerRow(a, 'Alpha'), partnerRow(b, 'Beta'), partnerRow(c, 'Gamma')]);
  // Shift everything below, exactly as a delete would.
  await deleteRowById(SHEET, 'partner_id', a);

  await updateRowById(SHEET, 'partner_id', c, partnerRow(c, 'Gamma Renamed'));

  assert.equal(await nameOf(c), 'Gamma Renamed');
  assert.equal(await nameOf(b), 'Beta', 'the neighbour is untouched');
});

test('updateRowById writes nothing when the record is gone', async () => {
  const [a] = ids(1);
  addPartners([partnerRow(a, 'Alpha')]);

  await assert.rejects(
    () => updateRowById(SHEET, 'partner_id', 'p_vanished', partnerRow('p_vanished', 'Ghost')),
    /no longer in/,
  );
  assert.equal(await nameOf(a), 'Alpha', 'no bystander was overwritten');
});

test('updateRowById accepts a callback so a caller can merge into the stored row', async () => {
  // Addressing the right row does not stop a stale snapshot from reverting the
  // columns the caller did not mean to touch — the callback form is how a
  // caller avoids that.
  const [a] = ids(1);
  addPartners([partnerRow(a, 'Alpha', { region: 'EMEA' })]);

  await updateRowById(SHEET, 'partner_id', a, (fresh) => {
    assert.equal(fresh.region, 'EMEA', 'the callback sees what is actually stored');
    return partnerRow(a, 'Alpha Renamed', { region: fresh.region });
  });

  const rows = await readSheetAsObjects(SHEET, { forceRefresh: true });
  const row = rows.find(r => r.partner_id === a);
  assert.equal(row.display_name, 'Alpha Renamed');
  assert.equal(row.region, 'EMEA', 'the untouched column survived');
});

test('updateRowById rejects a callback that does not return an array', async () => {
  const [a] = ids(1);
  addPartners([partnerRow(a, 'Alpha')]);
  await assert.rejects(() => updateRowById(SHEET, 'partner_id', a, () => 'nope'), /must be an array/);
  assert.equal(await nameOf(a), 'Alpha');
});

test('updateRowById can require a second column to still match', async () => {
  const [a] = ids(1);
  addPartners([partnerRow(a, 'Alpha', { status: 'Active' })]);

  await assert.rejects(
    () => updateRowById(SHEET, 'partner_id', a, partnerRow(a, 'X'), { expect: { status: 'Inactive' } }),
    /is now “Active”/,
  );
  assert.equal(await nameOf(a), 'Alpha', 'the mismatch wrote nothing');

  // …and succeeds when the expectation holds.
  await updateRowById(SHEET, 'partner_id', a, partnerRow(a, 'Alpha 2'), { expect: { status: 'Active' } });
  assert.equal(await nameOf(a), 'Alpha 2');
});

// ── Deleting ────────────────────────────────────────────────────────

test('deleteRowById removes the named record, not whatever sits at an index', async () => {
  const [a, b, c] = ids(3);
  addPartners([partnerRow(a, 'Alpha'), partnerRow(b, 'Beta'), partnerRow(c, 'Gamma')]);

  await deleteRowById(SHEET, 'partner_id', a);
  await deleteRowById(SHEET, 'partner_id', c);

  assert.equal(await nameOf(a), null);
  assert.equal(await nameOf(c), null, 'the second delete followed Gamma after the first shifted it');
  assert.equal(await nameOf(b), 'Beta', 'the survivor is the right one');
});

test('deleteRowById deletes nothing when the record is gone', async () => {
  const [a] = ids(1);
  addPartners([partnerRow(a, 'Alpha')]);
  const before = (await readSheetAsObjects(SHEET, { forceRefresh: true })).length;

  await assert.rejects(() => deleteRowById(SHEET, 'partner_id', 'p_never_existed'), /no longer in/);

  assert.equal((await readSheetAsObjects(SHEET, { forceRefresh: true })).length, before,
    'no bystander was removed');
});

test('deleteRowById deletes nothing when the id is ambiguous', async () => {
  const [dup] = ids(1);
  addPartners([partnerRow(dup, 'First'), partnerRow(dup, 'Second')]);
  const before = (await readSheetAsObjects(SHEET, { forceRefresh: true })).length;

  await assert.rejects(() => deleteRowById(SHEET, 'partner_id', dup), /share/);

  assert.equal((await readSheetAsObjects(SHEET, { forceRefresh: true })).length, before);
});

// ── The bug this exists to prevent, demonstrated ────────────────────

test('a remembered row index destroys a bystander; an id does not', async () => {
  // Both halves run the SAME sequence — capture, delete above, write — and
  // differ only in how the write addresses the row. The trailing bystander
  // matters: without it the stale index falls past the last row, where demo
  // mode's bounds check hides the damage that the real Sheets API would do.
  const [a, b, c, z] = ids(4);
  addPartners([partnerRow(a, 'Alpha'), partnerRow(b, 'Beta'), partnerRow(c, 'Gamma'), partnerRow(z, 'Bystander')]);

  const remembered = (await findRowById(SHEET, 'partner_id', c))._rowIndex;
  await deleteRowById(SHEET, 'partner_id', a);          // every row below shifts up one

  // The old way: write to the index captured before the delete.
  await updateRow(SHEET, remembered, partnerRow(c, 'Renamed'));

  const rows = await readSheetAsObjects(SHEET, { forceRefresh: true });
  assert.equal(rows.filter(r => r.partner_id === c).length, 2,
    'the write landed on the bystander, so two rows now share one partner_id');
  assert.equal(await nameOf(z), null, 'and the bystander was destroyed');

  // The new way, same setup.
  const [a2, b2, c2, z2] = ids(4);
  addPartners([partnerRow(a2, 'Alpha'), partnerRow(b2, 'Beta'), partnerRow(c2, 'Gamma'), partnerRow(z2, 'Bystander')]);
  await deleteRowById(SHEET, 'partner_id', a2);
  await updateRowById(SHEET, 'partner_id', c2, partnerRow(c2, 'Renamed'));

  const after = await readSheetAsObjects(SHEET, { forceRefresh: true });
  assert.equal(after.filter(r => r.partner_id === c2).length, 1, 'exactly one row still carries the id');
  assert.equal(await nameOf(c2), 'Renamed', 'the intended record was renamed');
  assert.equal(await nameOf(z2), 'Bystander', 'and the bystander is intact');
});
