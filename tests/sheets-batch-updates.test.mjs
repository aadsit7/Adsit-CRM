// ============================================================
// Phase 4: batched id-addressed updates
// ============================================================
// Phases 0-3 made every write address its row by id, which cost one forced
// full-sheet read per write. Four of those writes sit inside loops — a
// description modal save, a contact scan — so a 40-contact scan meant 40 reads
// of the whole tab.
//
// updateRowsById resolves the whole batch from ONE read and writes it in ONE
// request. That is safe because an update never moves a row; only deletes and
// inserts renumber the sheet, so a caller that deletes must finish its deletes
// first — which is the order the modal already used.
// ============================================================

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID_HERE',
  API_KEY: '',
}));

const sheets = await import('../js/sheets.js');
const {
  updateRowsById, updateRowById, deleteRowById, readSheetAsObjects,
  addDemoRow, invalidateSheetCache,
} = sheets;
const { CONFIG } = await import('../js/config.js');

const DESCS = CONFIG.SHEET_OPP_DESCRIPTIONS;

let seq = 0;
const ids = (n) => {
  const tag = `b${++seq}`;
  return Array.from({ length: n }, (_, i) => `${tag}_${i}`);
};

const descRow = (id, text) => [id, 'opp_x', 'Deal', '2026-01-01', text, '2026-01-01', 'general'];
const descValues = (id, text) => [id, 'opp_x', 'Deal', '2026-01-01', text, '2026-01-01'];

const textOf = async (id) =>
  (await readSheetAsObjects(DESCS, { forceRefresh: true }))
    .find(r => r.description_id === id)?.description_text ?? null;

// ── It writes what it says ──────────────────────────────────────────

test('a batch updates every row it names and nothing else', async () => {
  const [a, b, c] = ids(3);
  for (const [id, t] of [[a, 'one'], [b, 'two'], [c, 'three']]) addDemoRow(DESCS, descRow(id, t));
  invalidateSheetCache();

  await updateRowsById(DESCS, 'description_id', [
    { id: a, values: descValues(a, 'ONE EDITED') },
    { id: c, values: descValues(c, 'THREE EDITED') },
  ]);

  assert.equal(await textOf(a), 'ONE EDITED');
  assert.equal(await textOf(b), 'two', 'the row not in the batch is untouched');
  assert.equal(await textOf(c), 'THREE EDITED');
});

test('the callback form sees the stored row, per entry', async () => {
  const [a, b] = ids(2);
  for (const [id, t] of [[a, 'keep-a'], [b, 'keep-b']]) addDemoRow(DESCS, descRow(id, t));
  invalidateSheetCache();

  await updateRowsById(DESCS, 'description_id', [
    { id: a, values: (fresh) => descValues(a, `${fresh.description_text}+a`) },
    { id: b, values: (fresh) => descValues(b, `${fresh.description_text}+b`) },
  ]);

  assert.equal(await textOf(a), 'keep-a+a');
  assert.equal(await textOf(b), 'keep-b+b', 'each callback got its own row, not the first one');
});

test('an empty batch does nothing rather than reading the sheet', async () => {
  assert.deepEqual(await updateRowsById(DESCS, 'description_id', []), {});
  assert.deepEqual(await updateRowsById(DESCS, 'description_id', undefined), {});
});

// (The request count that justifies batching is measured against a stubbed
// fetch in tests/sheets-batch-request-count.test.mjs — it needs a configured
// spreadsheet, which would take this file off the demo path.)

// ── Refusals apply to the whole batch, before anything is written ───

test('a duplicate id refuses the batch without writing any of it', async () => {
  const [dup, other] = ids(2);
  addDemoRow(DESCS, descRow(dup, 'first copy'));
  addDemoRow(DESCS, descRow(dup, 'second copy'));
  addDemoRow(DESCS, descRow(other, 'untouched'));
  invalidateSheetCache();

  await assert.rejects(
    () => updateRowsById(DESCS, 'description_id', [
      { id: other, values: descValues(other, 'SHOULD NOT LAND') },
      { id: dup, values: descValues(dup, 'nor this') },
    ]),
    /share description_id/,
  );

  assert.equal(await textOf(other), 'untouched',
    'the valid entry was rolled back with the invalid one — the batch is all or nothing');
});

test('a missing id refuses the batch without writing any of it', async () => {
  const [present] = ids(1);
  addDemoRow(DESCS, descRow(present, 'untouched'));
  invalidateSheetCache();

  await assert.rejects(
    () => updateRowsById(DESCS, 'description_id', [
      { id: present, values: descValues(present, 'SHOULD NOT LAND') },
      { id: 'dsc_never_existed', values: descValues('dsc_never_existed', 'nor this') },
    ]),
    /no longer in/,
  );

  assert.equal(await textOf(present), 'untouched');
});

test('a blank id refuses the batch', async () => {
  await assert.rejects(
    () => updateRowsById(DESCS, 'description_id', [{ id: '', values: descValues('', 'x') }]),
    /no description_id was given/,
  );
});

test('expect is honoured per entry', async () => {
  const [a] = ids(1);
  addDemoRow(DESCS, descRow(a, 'untouched'));
  invalidateSheetCache();

  await assert.rejects(
    () => updateRowsById(DESCS, 'description_id', [
      { id: a, values: descValues(a, 'x'), expect: { opportunity_id: 'opp_somewhere_else' } },
    ]),
    /is now/,
  );
  assert.equal(await textOf(a), 'untouched');
});

// ── The modal's real sequence: deletes, then a batched update ───────

test('deletes then a batched update still lands on the right rows', async () => {
  // The order matters and the batch depends on it: deletes renumber the sheet,
  // so they must finish before the batch resolves its rows. This is the
  // sequence openOppModal's save actually runs.
  const [gone, edited, bystander] = ids(3);
  for (const [id, t] of [[gone, 'delete me'], [edited, 'edit me'], [bystander, 'leave me']]) {
    addDemoRow(DESCS, descRow(id, t));
  }
  invalidateSheetCache();

  await deleteRowById(DESCS, 'description_id', gone, { missingOk: true });
  await updateRowsById(DESCS, 'description_id', [{ id: edited, values: descValues(edited, 'EDITED') }]);

  assert.equal(await textOf(gone), null, 'deleted');
  assert.equal(await textOf(edited), 'EDITED', 'the edit found its row after the shift');
  assert.equal(await textOf(bystander), 'leave me', 'and the bystander is intact');
});

// ── Sheet header table is no longer duplicated ─────────────────────

test('the AI header table is derived from the sheets.js one', async () => {
  // These were two hand-maintained copies and had already drifted: the
  // ai-actions copy was missing Events.event_password, so an AI write built
  // from it was a column short of the row it was replacing.
  const { SHEET_HEADERS: AI_HEADERS, AI_WRITABLE_SHEETS } = await import('../js/utils/ai-actions.js');
  const { SHEET_HEADERS: ALL } = sheets;

  for (const name of AI_WRITABLE_SHEETS) {
    assert.deepEqual(AI_HEADERS[name], ALL[name], `${name} headers must come from sheets.js`);
  }
});

test('deriving the headers did not make a credential column writable', async () => {
  // The old hand-written table stopped one column short of Events'
  // `event_password`, so an AI update wrote the range A:N and could not reach
  // it. Deriving the headers removed that accidental protection: the write
  // range is now A:O. `event_password` is the Event Workspace access gate and
  // the confirmation card never shows `action.changes`, so an approved-looking
  // edit could clear it. It has to be blocked explicitly.
  const { SHEET_HEADERS: AI_HEADERS, BLOCKED_FIELDS } = await import('../js/utils/ai-actions.js');
  assert.ok(AI_HEADERS.Events.includes('event_password'), 'the column is in range now');
  assert.ok(BLOCKED_FIELDS.includes('event_password'), 'so it must be blocked');
  for (const field of ['password_hash', 'is_admin']) {
    assert.ok(BLOCKED_FIELDS.includes(field), `${field} stays blocked`);
  }
});

test('an AI action naming a blocked field is refused', async () => {
  const { executeAction } = await import('../js/utils/ai-actions.js');
  for (const field of ['event_password', 'password_hash', 'is_admin']) {
    await assert.rejects(
      () => executeAction({
        type: 'update', sheet: CONFIG.SHEET_EVENTS,
        row_match: { title: 'anything' }, changes: { [field]: 'x' },
      }),
      new RegExp(`Cannot modify field: ${field}`),
      `${field} must be refused before any row is touched`,
    );
  }
});

test('the event password is not handed to the model', async () => {
  // The whole Events row is serialized into every prompt, so this column was
  // being sent to the provider on each turn and could be read back out of any
  // chat — the partner credentials were already stripped, this one was not.
  const { loadSheetData } = await import('../js/utils/ai.js');
  const data = await loadSheetData(true);
  assert.ok(data.events.length > 0, 'demo events are present to check');
  for (const e of data.events) {
    assert.equal('event_password' in e, false, 'event_password must be stripped');
  }
  for (const p of data.partners) {
    assert.equal('password_hash' in p, false);
    assert.equal('is_admin' in p, false);
  }
});

test('a batch refuses the same id twice rather than dropping the first merge', async () => {
  // Both entries would be built from the same pre-write row, so the second
  // would silently discard whatever the first merged in.
  const [a] = ids(1);
  addDemoRow(DESCS, descRow(a, 'base'));
  invalidateSheetCache();

  await assert.rejects(
    () => updateRowsById(DESCS, 'description_id', [
      { id: a, values: (fresh) => descValues(a, `${fresh.description_text}+one`) },
      { id: a, values: (fresh) => descValues(a, `${fresh.description_text}+two`) },
    ]),
    /appears twice in one batch/,
  );
  assert.equal(await textOf(a), 'base', 'and nothing was written');
});

test('the duplicate-row message reports the real count', async () => {
  const [dup] = ids(1);
  for (const t of ['one', 'two', 'three']) addDemoRow(DESCS, descRow(dup, t));
  invalidateSheetCache();

  await assert.rejects(
    () => updateRowsById(DESCS, 'description_id', [{ id: dup, values: descValues(dup, 'x') }]),
    /3 rows in .* share description_id/,
  );
});

test('the AI may still only write to its allowlisted sheets', async () => {
  // Deriving the headers must not have widened what the model can reach.
  const { SHEET_HEADERS: AI_HEADERS } = await import('../js/utils/ai-actions.js');
  for (const name of ['Custom_Prompts', 'Partner_Contacts', 'Partner_Documents', 'Opportunity_Descriptions']) {
    assert.equal(AI_HEADERS[name], undefined, `${name} must stay unreachable from an AI action`);
  }
});
