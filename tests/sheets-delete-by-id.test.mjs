// ============================================================
// Phase 2: every delete addresses its row by id
// ============================================================
// Phase 1 added findRowById/updateRowById/deleteRowById; this covers the
// conversion of the delete call sites onto them, plus the two pieces the
// conversion needed: keyFieldFor (for the one caller whose sheet is only known
// at runtime) and deleteCustomPrompt taking an id instead of a row number.
//
// Runs against demo mode, like the Phase 1 suite — same code path minus the
// network. The demo store is shared, so every test uses its own ids.
// ============================================================

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID_HERE',
  API_KEY: '',
}));

const {
  keyFieldFor, deleteRowById, deleteCustomPrompt,
  readSheetAsObjects, addDemoRow, invalidateSheetCache,
} = await import('../js/sheets.js');

const { CONFIG } = await import('../js/config.js');

let seq = 0;
const ids = (n) => {
  const tag = `d${++seq}`;
  return Array.from({ length: n }, (_, i) => `${tag}_${i}`);
};

// ── keyFieldFor ─────────────────────────────────────────────────────

test('keyFieldFor names the identifying column of each sheet', () => {
  assert.equal(keyFieldFor(CONFIG.SHEET_PARTNERS), 'partner_id');
  assert.equal(keyFieldFor(CONFIG.SHEET_OPPORTUNITIES), 'opportunity_id');
  assert.equal(keyFieldFor(CONFIG.SHEET_EVENTS), 'event_id');
  assert.equal(keyFieldFor(CONFIG.SHEET_OPP_DESCRIPTIONS), 'description_id');
  assert.equal(keyFieldFor(CONFIG.SHEET_PARTNER_CONTACTS), 'contact_id');
  assert.equal(keyFieldFor(CONFIG.SHEET_AI_CONVERSATIONS), 'conversation_id');
});

test('keyFieldFor returns null rather than guessing at an unknown sheet', () => {
  assert.equal(keyFieldFor('Not_A_Sheet'), null);
  assert.equal(keyFieldFor(undefined), null);
});

// ── deleteCustomPrompt ──────────────────────────────────────────────

// Custom_Prompts is one of the sheets the demo store does not carry (see
// getDemoData), so it always reads empty here and cannot be exercised
// end-to-end. That is also why the behaviour change is unobservable in the
// app: the Setup screen only calls deleteCustomPrompt for a preset that came
// from the sheet (`if (!preset._rowIndex) { card.remove(); return; }`), and in
// demo mode no preset ever does. What is worth pinning is that the call is
// addressed by prompt_id at all — it used to take a row number.
test('deleteCustomPrompt addresses the prompt by prompt_id, not by row number', async () => {
  await assert.rejects(
    () => deleteCustomPrompt('prompt_that_never_existed'),
    (err) => {
      assert.equal(err.code, 'ROW_ID_NOT_RESOLVED');
      assert.match(err.message, /prompt_id/, 'resolved through the id column');
      assert.match(err.message, /Custom_Prompts/);
      return true;
    },
  );
});

test('a number is not accepted as a stand-in for an id', async () => {
  // Guards the migration itself: a call site left passing `_rowIndex` would
  // now be looking up a prompt whose id is "7", and must fail rather than
  // delete row 7.
  await assert.rejects(() => deleteCustomPrompt(7), /no longer in/);
});

// ── the converted view deletes ──────────────────────────────────────

const descRow = (id, text) => [id, 'opp_x', 'Deal', '2026-01-01', text, '2026-01-01', 'general'];

test('missingOk lets a batch of deletes be retried after a partial failure', async () => {
  // The description modal stays open when a save fails, so the user hits Save
  // again and the delete loop re-runs. Without missingOk the second attempt
  // fails on the row the first attempt already removed, and the modal can
  // never be saved — the user's edits are stuck behind a delete that already
  // succeeded.
  const SHEET = CONFIG.SHEET_OPP_DESCRIPTIONS;
  const [d1, d2, keep] = ids(3);
  for (const [id, text] of [[d1, 'first'], [d2, 'second'], [keep, 'keep me']]) {
    addDemoRow(SHEET, descRow(id, text));
  }
  invalidateSheetCache();

  // Attempt 1 removes d1, then "fails" before finishing.
  await deleteRowById(SHEET, 'description_id', d1, { missingOk: true });

  // Attempt 2 replays the whole loop, d1 included.
  await deleteRowById(SHEET, 'description_id', d1, { missingOk: true });
  await deleteRowById(SHEET, 'description_id', d2, { missingOk: true });

  const rows = await readSheetAsObjects(SHEET, { forceRefresh: true });
  const mine = rows.filter(r => [d1, d2, keep].includes(r.description_id));
  assert.deepEqual(mine.map(r => r.description_id), [keep], 'the retry completed instead of wedging');
  assert.equal(mine[0].description_text, 'keep me');
});

test('missingOk still refuses when two rows share the id', async () => {
  // Tolerating "already gone" must not become tolerating "cannot tell which".
  // A duplicate id is a sheet that needs a human, not a delete that already
  // happened, so this stays loud however the caller asks.
  const SHEET = CONFIG.SHEET_OPP_DESCRIPTIONS;
  const [dup] = ids(1);
  addDemoRow(SHEET, descRow(dup, 'first copy'));
  addDemoRow(SHEET, descRow(dup, 'second copy'));
  invalidateSheetCache();

  await assert.rejects(
    () => deleteRowById(SHEET, 'description_id', dup, { missingOk: true }),
    /2 rows .* share/,
  );

  const rows = await readSheetAsObjects(SHEET, { forceRefresh: true });
  assert.equal(rows.filter(r => r.description_id === dup).length, 2, 'and neither copy was removed');
});

test('missingOk does not swallow a blank id', async () => {
  // "No id was given" is a broken record, not an absent one.
  await assert.rejects(
    () => deleteRowById(CONFIG.SHEET_OPP_DESCRIPTIONS, 'description_id', '', { missingOk: true }),
    /no description_id was given/,
  );
});

test('without missingOk, deleting an absent row still refuses', async () => {
  await assert.rejects(
    () => deleteRowById(CONFIG.SHEET_OPP_DESCRIPTIONS, 'description_id', 'dsc_never_existed'),
    /no longer in/,
  );
});

// ── Randy's deletes (utils/ai-actions.js) ───────────────────────────
// The riskiest converted site: the sheet is whatever the model named, and
// row_match may key off any columns, so the matched row has to be identified
// by its own key before anything is removed.

const { executeAction } = await import('../js/utils/ai-actions.js');

const oppRow = (id, deal) => [
  id, 'p_1', deal, 'Customer', '1000', 'Open', 'Discovery',
  '2026-12-01', 'desc', '2026-01-01', '2026-01-01', '', 'salesperson',
];

test('an AI delete removes the matched deal and leaves its neighbours alone', async () => {
  // The happy path. Note this one passes under the OLD index-addressed code
  // too — executeAction re-reads before matching, so single-actor deletes were
  // already correct. It is here to catch a botched conversion, not to
  // demonstrate the fix; the two tests below do that.
  const SHEET = CONFIG.SHEET_OPPORTUNITIES;
  const [o1, o2, o3] = ids(3);
  for (const [id, deal] of [[o1, 'Deal One'], [o2, 'Deal Two'], [o3, 'Deal Three']]) {
    addDemoRow(SHEET, oppRow(id, deal));
  }
  invalidateSheetCache();

  await executeAction({ type: 'delete', sheet: SHEET, row_match: { deal_name: 'Deal Two' } });

  const rows = await readSheetAsObjects(SHEET, { forceRefresh: true });
  const mine = rows.filter(r => [o1, o2, o3].includes(r.opportunity_id));
  assert.deepEqual(mine.map(r => r.deal_name), ['Deal One', 'Deal Three'],
    'exactly the matched deal is gone');
});

test('an AI delete refuses when two deals share an opportunity_id', async () => {
  // The old code deleted whatever sat at the matched index, so a duplicated id
  // was invisible. Now it stops: the sheet is inconsistent and picking one
  // would compound it. This is the behaviour the conversion buys.
  const SHEET = CONFIG.SHEET_OPPORTUNITIES;
  const [dup] = ids(1);
  addDemoRow(SHEET, oppRow(dup, 'Ambiguous Deal'));
  addDemoRow(SHEET, oppRow(dup, 'Ambiguous Deal Copy'));
  invalidateSheetCache();

  await assert.rejects(
    () => executeAction({ type: 'delete', sheet: SHEET, row_match: { deal_name: 'Ambiguous Deal' } }),
    /2 rows .* share/,
  );

  const rows = await readSheetAsObjects(SHEET, { forceRefresh: true });
  assert.equal(rows.filter(r => r.opportunity_id === dup).length, 2, 'nothing was deleted');
});

test('an AI delete refuses a matched row that carries no identifier', async () => {
  // Rather than fall back to the row number it was matched at.
  const SHEET = CONFIG.SHEET_OPPORTUNITIES;
  const [keep] = ids(1);
  addDemoRow(SHEET, oppRow('', 'Unidentifiable Deal'));
  addDemoRow(SHEET, oppRow(keep, 'Innocent Deal'));
  invalidateSheetCache();

  await assert.rejects(
    () => executeAction({ type: 'delete', sheet: SHEET, row_match: { deal_name: 'Unidentifiable Deal' } }),
    /no identifier/,
  );

  const rows = await readSheetAsObjects(SHEET, { forceRefresh: true });
  assert.ok(rows.some(r => r.deal_name === 'Innocent Deal'), 'and nothing was deleted in its place');
});
