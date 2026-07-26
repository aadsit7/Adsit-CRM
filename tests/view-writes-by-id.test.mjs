// ============================================================
// The view write paths, driven directly
// ============================================================
// The rest of the id-addressing suite exercises js/sheets.js and
// js/utils/ai-actions.js. The view call sites — the ones a user actually
// triggers — were never loaded by any test, so the whole conversion could be
// reverted in those files and the suite stayed green.
//
// These drive the real functions out of admin-partners.js,
// admin-opportunities.js and admin-events.js against the demo store. They fail
// if a view goes back to writing by row index, or back to writing the columns
// it does not edit from a stale snapshot.
// ============================================================

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID_HERE',
  API_KEY: '',
}));

const {
  readSheetAsObjects, addDemoRow, invalidateSheetCache, deleteRowById, updateRowById,
} = await import('../js/sheets.js');
const { CONFIG } = await import('../js/config.js');

const { __partnerWriteInternals } = await import('../js/views/admin-partners.js');
const { __oppWriteInternals } = await import('../js/views/admin-opportunities.js');
const { __eventWriteInternals } = await import('../js/views/admin-events.js');

const { savePartnerEdit } = __partnerWriteInternals;
const { saveOppRow, saveOppStage } = __oppWriteInternals;
const { saveEventStatus } = __eventWriteInternals;

let seq = 0;
const ids = (n) => {
  const tag = `v${++seq}`;
  return Array.from({ length: n }, (_, i) => `${tag}_${i}`);
};

const P = CONFIG.SHEET_PARTNERS;
const O = CONFIG.SHEET_OPPORTUNITIES;
const E = CONFIG.SHEET_EVENTS;

const partnerRow = (id, name, { admin = 'FALSE', hash = 'HASH', tier = 'Gold' } = {}) =>
  [id, `${id}user`, name, 'MSP', tier, 'NA', '2026-01-01', admin, hash, 'Active', 'Denver'];
const oppRow = (id, deal, { notes = '', stage = 'Discovery', desc = 'original' } = {}) =>
  [id, 'p_1', deal, 'Customer', '1000', 'Open', stage, '2026-12-01', desc,
   '2026-01-01', '2026-01-01', notes, 'salesperson'];
const eventRow = (id, title, { status = 'Upcoming', checklist = '[]', pw = 's3cret' } = {}) =>
  [id, title, 'desc', '2026-06-01', '2026-06-02', 'Webinar', 'Denver', '', 'admin',
   '2026-01-01', status, 'p_1', checklist, '0', pw];

const rowById = async (sheet, field, id) =>
  (await readSheetAsObjects(sheet, { forceRefresh: true })).find(r => r[field] === id);

// ── admin-partners: the credential columns ──────────────────────────

test('editing a partner keeps the password hash the sheet actually holds', async () => {
  // The admin's form has no password field. If the write took password_hash
  // from the object the page loaded, a partner who changed their password
  // while that form sat open would be locked out of their own account.
  const [id] = ids(1);
  addDemoRow(P, partnerRow(id, 'Acme', { hash: 'HASH_ORIGINAL', admin: 'TRUE' }));
  invalidateSheetCache();

  const snapshot = await rowById(P, 'partner_id', id);
  assert.equal(snapshot.password_hash, 'HASH_ORIGINAL');

  // The partner rotates their password while the modal is open.
  await updateRowById(P, 'partner_id', id, (fresh) =>
    partnerRow(id, fresh.display_name, { hash: 'HASH_ROTATED', admin: fresh.is_admin }));

  await savePartnerEdit(id, {
    username: `${id}user`, display_name: 'Acme Renamed', partner_type: 'MSP',
    tier: 'Platinum', region: 'NA', status: 'Active', hq_location: 'Denver',
  });

  const after = await rowById(P, 'partner_id', id);
  assert.equal(after.display_name, 'Acme Renamed', 'the edit applied');
  assert.equal(after.tier, 'Platinum');
  assert.equal(after.password_hash, 'HASH_ROTATED', 'the new hash survived the edit');
  assert.equal(after.is_admin, 'TRUE', 'and the admin flag was not cleared');
});

test('editing a partner writes to that partner after another is deleted', async () => {
  // The stale-index case, end to end through the view's own write path.
  const [a, b, c] = ids(3);
  for (const [id, n] of [[a, 'Alpha'], [b, 'Beta'], [c, 'Gamma']]) addDemoRow(P, partnerRow(id, n));
  invalidateSheetCache();

  await deleteRowById(P, 'partner_id', a);
  await savePartnerEdit(c, {
    username: `${c}user`, display_name: 'Gamma Renamed', partner_type: 'MSP',
    tier: 'Gold', region: 'NA', status: 'Active', hq_location: 'Denver',
  });

  assert.equal((await rowById(P, 'partner_id', c)).display_name, 'Gamma Renamed');
  assert.equal((await rowById(P, 'partner_id', b)).display_name, 'Beta', 'the neighbour is untouched');
});

test('editing a partner that is gone writes nothing', async () => {
  const [survivor] = ids(1);
  addDemoRow(P, partnerRow(survivor, 'Survivor'));
  invalidateSheetCache();

  await assert.rejects(
    () => savePartnerEdit('p_vanished', {
      username: 'x', display_name: 'Ghost', partner_type: 'MSP',
      tier: 'Gold', region: 'NA', status: 'Active', hq_location: '',
    }),
    /no longer in/,
  );
  assert.equal((await rowById(P, 'partner_id', survivor)).display_name, 'Survivor');
});

// ── admin-opportunities: notes, and the kanban ──────────────────────

test('an inline field edit does not wipe the note history', async () => {
  // `notes` is the JSON array Randy appends to. The inline editor cannot edit
  // it, so it must come from the sheet — this slot was once hardcoded '',
  // which destroyed the history on every field edit.
  const [id] = ids(1);
  addDemoRow(O, oppRow(id, 'Deal', { notes: '[]' }));
  invalidateSheetCache();

  const opp = await rowById(O, 'opportunity_id', id);   // what the page holds

  // Randy adds a note, and someone else rewrites the description.
  await updateRowById(O, 'opportunity_id', id, (fresh) =>
    oppRow(id, fresh.deal_name, { notes: '["randy note"]', stage: fresh.stage, desc: 'CHANGED ELSEWHERE' }));

  // The user edits one inline field on the stale card.
  opp.deal_value = '9999';
  await saveOppRow(opp);

  const after = await rowById(O, 'opportunity_id', id);
  assert.equal(after.deal_value, '9999', 'the edit applied');
  assert.equal(after.notes, '["randy note"]', 'the note history survived');
  assert.equal(after.description, 'CHANGED ELSEWHERE', 'and so did the description');
  assert.equal(opp.updated_at, after.updated_at, 'the caller sees the timestamp that was written');
});

test('an inline field edit lands on its own deal after another is deleted', async () => {
  const [a, b] = ids(2);
  addDemoRow(O, oppRow(a, 'Deal A'));
  addDemoRow(O, oppRow(b, 'Deal B'));
  invalidateSheetCache();

  const oppB = await rowById(O, 'opportunity_id', b);
  await deleteRowById(O, 'opportunity_id', a);

  oppB.deal_name = 'Deal B Renamed';
  await saveOppRow(oppB);

  assert.equal((await rowById(O, 'opportunity_id', b)).deal_name, 'Deal B Renamed');
});

test('a kanban drag changes only the stage', async () => {
  const [id] = ids(1);
  addDemoRow(O, oppRow(id, 'Draggable', { notes: '["keep"]', stage: 'Discovery' }));
  invalidateSheetCache();

  // Someone renames the deal after the board was drawn.
  await updateRowById(O, 'opportunity_id', id, (fresh) =>
    oppRow(id, 'RENAMED ELSEWHERE', { notes: fresh.notes, stage: fresh.stage }));

  await saveOppStage(id, 'Negotiation');

  const after = await rowById(O, 'opportunity_id', id);
  assert.equal(after.stage, 'Negotiation', 'the drag applied');
  assert.equal(after.deal_name, 'RENAMED ELSEWHERE', 'the rename was not reverted');
  assert.equal(after.notes, '["keep"]', 'and neither were the notes');
});

test('a kanban drag onto a deleted deal writes nothing', async () => {
  const [a, b] = ids(2);
  addDemoRow(O, oppRow(a, 'Deal A'));
  addDemoRow(O, oppRow(b, 'Deal B'));
  invalidateSheetCache();

  await deleteRowById(O, 'opportunity_id', a);
  await assert.rejects(() => saveOppStage(a, 'Negotiation'), /no longer in/);
  assert.equal((await rowById(O, 'opportunity_id', b)).stage, 'Discovery',
    'the surviving deal was not moved in its place');
});

// ── admin-events: the kanban, and the column past the range ─────────

test('an event drag does not revert a checklist changed since the board was drawn', async () => {
  // Only the columns the drag actually writes are asserted here. The A:M range
  // that keeps lead_count and event_password out of the write is invisible in
  // demo mode — updateDemoRow replaces the whole row array rather than a range
  // — so it is pinned against a stubbed fetch instead, in
  // tests/sheets-batch-request-count.test.mjs.
  const [id] = ids(1);
  addDemoRow(E, eventRow(id, 'Summit', { status: 'Upcoming', checklist: '["old"]' }));
  invalidateSheetCache();

  await updateRowById(E, 'event_id', id, (fresh) =>
    eventRow(id, fresh.title, { status: fresh.status, checklist: '["updated elsewhere"]' }));

  await saveEventStatus(id, 'Completed');

  const after = await rowById(E, 'event_id', id);
  assert.equal(after.status, 'Completed', 'the drag applied');
  assert.equal(after.checklist, '["updated elsewhere"]', 'the newer checklist was not reverted');
});

test('an event drag lands on its own event after another is deleted', async () => {
  const [a, b] = ids(2);
  addDemoRow(E, eventRow(a, 'Event A'));
  addDemoRow(E, eventRow(b, 'Event B'));
  invalidateSheetCache();

  await deleteRowById(E, 'event_id', a);
  await saveEventStatus(b, 'Completed');

  assert.equal((await rowById(E, 'event_id', b)).status, 'Completed');
  assert.equal((await rowById(E, 'event_id', b)).title, 'Event B', 'and it is still the right event');
});

// ── The whole point, stated once ────────────────────────────────────

test('nothing outside sheets.js calls a positional write', async () => {
  // A structural backstop for a regression the behavioural tests above would
  // only catch in the files they cover.
  //
  // This scans for the CALL token rather than the import line. An earlier
  // version inspected only the line containing `from '../sheets.js'`, which a
  // multi-line import, an `import * as sheets`, a dynamic import or an alias
  // all walked straight past — and a file whose import did not match that
  // pattern passed vacuously. It also hard-coded a list of eight files, so a
  // view added later was unguarded. Every js/ file is checked now, and the
  // token survives reformatting because it is what the call site actually
  // looks like however the name arrived.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = new URL('../js/', import.meta.url);

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
  });

  const stripped = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')     // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');  // line comments

  const offenders = [];
  for (const file of walk(path.dirname(new URL(root).pathname))) {
    if (file.endsWith(`${path.sep}sheets.js`)) continue;   // defines them
    const src = stripped(fs.readFileSync(file, 'utf8'));
    for (const token of ['updateRow(', 'deleteRow(', 'updateDemoRow(', 'deleteDemoRow(']) {
      // The boundary deliberately allows a leading `.` so a namespace call
      // (`sheets.updateRow(...)`) is caught too. `updateRowById(` and
      // `updateRowsById(` do not contain the literal `updateRow(`, so they
      // cannot trip this.
      const re = new RegExp(`(^|[^A-Za-z0-9_])${token.replace('(', '\\(')}`, 'g');
      if (re.test(src)) offenders.push(`${path.relative(process.cwd(), file)} calls ${token}`);
    }
  }

  assert.deepEqual(offenders, [],
    'writes outside sheets.js must be addressed by id, not by row number');
});
