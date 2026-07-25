// ============================================================
// Phase 3: every update addresses its row by id, and merges
// ============================================================
// Two distinct defects, fixed together because the fix for the first hands
// you the fix for the second for free:
//
//   1. Addressing.   updateRow(sheet, rowIndex, values) writes to a POSITION.
//                    Any delete above that row moves it.
//   2. Reversion.    These writes replace a WHOLE row, assembled from an
//                    object read when the page loaded. Every column the caller
//                    did not mean to touch is reverted to that snapshot.
//
// updateRowById already re-reads to locate the row, so its callback form can
// hand the caller the row as it stands — at no extra cost.
//
// Runs against demo mode, like the Phase 1 and 2 suites. The demo store is
// shared, so every test uses its own ids.
// ============================================================

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID_HERE',
  API_KEY: '',
}));

const {
  updateRowById, deleteRowById, readSheetAsObjects,
  addDemoRow, invalidateSheetCache, updateRow,
} = await import('../js/sheets.js');
const { executeAction } = await import('../js/utils/ai-actions.js');
const { CONFIG } = await import('../js/config.js');

let seq = 0;
const ids = (n) => {
  const tag = `u${++seq}`;
  return Array.from({ length: n }, (_, i) => `${tag}_${i}`);
};

const SHEET = CONFIG.SHEET_OPPORTUNITIES;
const DESCS = CONFIG.SHEET_OPP_DESCRIPTIONS;

const oppRow = (id, deal, { notes = '', stage = 'Discovery' } = {}) => [
  id, 'p_1', deal, 'Customer', '1000', 'Open', stage,
  '2026-12-01', 'desc', '2026-01-01', '2026-01-01', notes, 'salesperson',
];
const descRow = (id, text) => [id, 'opp_x', 'Deal', '2026-01-01', text, '2026-01-01', 'general'];

const oppById = async (id) =>
  (await readSheetAsObjects(SHEET, { forceRefresh: true })).find(r => r.opportunity_id === id);

// ── The defect this phase exists to fix ─────────────────────────────

test('deleting one description and editing another in the same save', async () => {
  // The modal's save runs its deletes and then its updates. The updates used
  // to use a _rowIndex captured when the modal opened, which the deletes had
  // just invalidated — so the edit landed on the wrong row. Because each row
  // carries its own id in column A, that also produced a DUPLICATE
  // description_id, which deleteRowById then refuses to touch, leaving the
  // record undeletable through the UI.
  const [gone, edited, bystander] = ids(3);
  for (const [id, text] of [[gone, 'delete me'], [edited, 'edit me'], [bystander, 'leave me']]) {
    addDemoRow(DESCS, descRow(id, text));
  }
  invalidateSheetCache();

  // Exactly the modal's order: deletes, then updates.
  await deleteRowById(DESCS, 'description_id', gone, { missingOk: true });
  await updateRowById(DESCS, 'description_id', edited,
    [edited, 'opp_x', 'Deal', '2026-01-01', 'EDITED', '2026-01-01']);

  const rows = await readSheetAsObjects(DESCS, { forceRefresh: true });
  const mine = rows.filter(r => [gone, edited, bystander].includes(r.description_id));
  assert.equal(mine.length, 2, 'one deleted, two left — no row was duplicated');
  assert.equal(mine.find(r => r.description_id === edited).description_text, 'EDITED',
    'the edit landed on the description it was meant for');
  assert.equal(mine.find(r => r.description_id === bystander).description_text, 'leave me',
    'and the bystander is untouched');
});

test('the same sequence addressed by index corrupts, as it used to', async () => {
  // The counter-example, so the test above is not just asserting that working
  // code works. Same three rows, same order, indices captured up front.
  const [gone, edited, bystander] = ids(3);
  for (const [id, text] of [[gone, 'delete me'], [edited, 'edit me'], [bystander, 'leave me']]) {
    addDemoRow(DESCS, descRow(id, text));
  }
  invalidateSheetCache();

  const before = await readSheetAsObjects(DESCS, { forceRefresh: true });
  const staleIndex = before.find(r => r.description_id === edited)._rowIndex;

  await deleteRowById(DESCS, 'description_id', gone);
  await updateRow(DESCS, staleIndex, [edited, 'opp_x', 'Deal', '2026-01-01', 'EDITED', '2026-01-01']);

  const rows = await readSheetAsObjects(DESCS, { forceRefresh: true });
  assert.equal(rows.filter(r => r.description_id === edited).length, 2,
    'the edit wrote the id over the bystander, so two rows now share it');
  assert.ok(!rows.some(r => r.description_id === bystander),
    'and the bystander is gone');
});

// ── Reversion: the columns the caller did not mean to touch ─────────

test('an update takes untouched columns from the sheet, not from the snapshot', async () => {
  // A drag or an inline field edit rewrites the whole row. Anything read off
  // the card — drawn before Randy appended a note — would revert it.
  const [id] = ids(1);
  addDemoRow(SHEET, oppRow(id, 'Deal', { notes: '[]' }));
  invalidateSheetCache();

  const snapshot = await oppById(id);            // what the page is holding
  assert.equal(snapshot.notes, '[]');

  // Randy appends a note while that page sits open.
  await updateRowById(SHEET, 'opportunity_id', id, (fresh) => {
    const v = oppRow(id, fresh.deal_name, { notes: '["a note"]', stage: fresh.stage });
    return v;
  });

  // Now the stage drag lands, carrying every other column from `fresh`.
  await updateRowById(SHEET, 'opportunity_id', id, (fresh) =>
    oppRow(id, fresh.deal_name, { notes: fresh.notes, stage: 'Negotiation' }));

  const after = await oppById(id);
  assert.equal(after.stage, 'Negotiation', 'the drag applied');
  assert.equal(after.notes, '["a note"]', "and Randy's note survived it");
});

test('writing the snapshot back is what used to lose the note', async () => {
  // The counter-example for the merge, same shape as above.
  const [id] = ids(1);
  addDemoRow(SHEET, oppRow(id, 'Deal', { notes: '[]' }));
  invalidateSheetCache();

  const snapshot = await oppById(id);
  await updateRowById(SHEET, 'opportunity_id', id, (fresh) =>
    oppRow(id, fresh.deal_name, { notes: '["a note"]', stage: fresh.stage }));

  // The old shape: every column from the object the page is holding.
  await updateRowById(SHEET, 'opportunity_id', id,
    oppRow(id, snapshot.deal_name, { notes: snapshot.notes, stage: 'Negotiation' }));

  assert.equal((await oppById(id)).notes, '[]', 'the note was reverted');
});

// ── Randy's updates (utils/ai-actions.js) ───────────────────────────

// Note this one passes under the OLD index-addressed code too: executeAction
// calls loadSheetData(true) before matching, so with a single actor the row it
// merges from and the row in the sheet are the same. It guards against a
// botched conversion, not against the defect. The test below it, and the
// duplicate-id test in the Phase 2 suite, are the ones that fail when reverted.
test('an AI update changes only the named fields', async () => {
  const [id] = ids(1);
  addDemoRow(SHEET, oppRow(id, 'Randy Deal', { notes: '["keep"]' }));
  invalidateSheetCache();

  await executeAction({
    type: 'update', sheet: SHEET,
    row_match: { deal_name: 'Randy Deal' },
    changes: { stage: 'Proposal' },
  });

  const after = await oppById(id);
  assert.equal(after.stage, 'Proposal', 'the named field changed');
  assert.equal(after.notes, '["keep"]', 'and nothing else did');
  assert.equal(after.customer_name, 'Customer');
});

test('an AI update refuses a matched row that carries no identifier', async () => {
  const [keep] = ids(1);
  addDemoRow(SHEET, oppRow('', 'Unidentifiable For Update'));
  addDemoRow(SHEET, oppRow(keep, 'Innocent Deal'));
  invalidateSheetCache();

  await assert.rejects(
    () => executeAction({
      type: 'update', sheet: SHEET,
      row_match: { deal_name: 'Unidentifiable For Update' },
      changes: { stage: 'Proposal' },
    }),
    /no identifier/,
  );

  const rows = await readSheetAsObjects(SHEET, { forceRefresh: true });
  assert.equal(rows.find(r => r.opportunity_id === keep).stage, 'Discovery',
    'and no bystander was written to');
});

// ── expect: the cross-check saveContactAnalysis now uses ────────────

test('expect refuses when the row moved out from under a long-running job', async () => {
  // A contact analysis takes long enough that the contact can be reassigned
  // to a different partner before it lands. saveContactAnalysis passes the
  // partner it started from as an `expect`, so the write is refused rather
  // than filed against the wrong partner.
  const [id] = ids(1);
  addDemoRow(SHEET, oppRow(id, 'Reassigned Deal'));
  invalidateSheetCache();

  await updateRowById(SHEET, 'opportunity_id', id, (fresh) => {
    const v = oppRow(id, fresh.deal_name);
    v[1] = 'p_2';                       // reassigned to another partner
    return v;
  });

  await assert.rejects(
    () => updateRowById(SHEET, 'opportunity_id', id, oppRow(id, 'Too Late'),
      { expect: { partner_id: 'p_1' } }),
    /is now/,
  );
  assert.equal((await oppById(id)).deal_name, 'Reassigned Deal', 'nothing was written');
});

// ── Prompt presets (js/sheets.js) ───────────────────────────────────
// Custom_Prompts is not in the demo store, so these assert the addressing
// rather than the stored result: the point is that a row number can no longer
// reach these calls. The Setup screen's delete removes the card without
// re-rendering, so every preset below it keeps a row number one too high —
// which is how editing one preset used to overwrite another.

test('saveCustomPrompt no longer takes a row number at all', async () => {
  const { saveCustomPrompt } = await import('../js/sheets.js');
  // The signature is the assertion: the old one was
  // (promptId, label, icon, instructions, rowIndex, provider), and the Setup
  // screen passed `preset._rowIndex` into it. There is no longer a parameter
  // for a caller to pass a stale row number through.
  assert.equal(saveCustomPrompt.length, 5,
    'expected (promptId, label, icon, instructions, provider)');

  // And an id that is not stored appends rather than throwing, so a preset
  // deleted in another tab does not lose what the user just typed.
  await saveCustomPrompt('prm_absent', 'Label', '', 'do the thing', 'claude');
});

test('saveReorderedPrompts refuses when the stored set no longer matches', async () => {
  const { saveReorderedPrompts } = await import('../js/sheets.js');
  // Reordering is positional by nature, so it verifies the sheet first: three
  // presets on screen against an empty sheet must not write three rows.
  await assert.rejects(
    () => saveReorderedPrompts([
      { prompt_id: 'a', label: 'A', icon: '', instructions: '', created_at: '', provider: 'claude' },
      { prompt_id: 'b', label: 'B', icon: '', instructions: '', created_at: '', provider: 'claude' },
    ]),
    /changed while you were reordering/,
  );
});

// ── The credential wipe this phase closed ───────────────────────────

test('an AI update to Partners no longer blanks password_hash and is_admin', async () => {
  // executeAction matched against loadSheetData's rows, which STRIP
  // password_hash and is_admin (see ai.js). Building the new row from that
  // match wrote empty strings into both — every AI-driven partner update
  // silently destroyed the password hash and cleared the admin flag.
  // Reading them back from the sheet instead is what fixes it.
  const P = CONFIG.SHEET_PARTNERS;
  const [pid] = ids(1);
  addDemoRow(P, [pid, `${pid}user`, 'Acme', 'MSP', 'Gold', 'NA', '2026-01-01', 'TRUE', 'SECRETHASH', 'Active', 'Denver']);
  invalidateSheetCache();

  await executeAction({
    type: 'update', sheet: P,
    row_match: { display_name: 'Acme' },
    changes: { tier: 'Platinum' },
  });

  const row = (await readSheetAsObjects(P, { forceRefresh: true })).find(r => r.partner_id === pid);
  assert.equal(row.tier, 'Platinum', 'the requested change applied');
  assert.equal(row.password_hash, 'SECRETHASH', 'the password hash survived');
  assert.equal(row.is_admin, 'TRUE', 'and so did the admin flag');
});
