// ============================================================
// What batching actually saves, counted
// ============================================================
// The rest of the id-addressing suite runs against demo mode, where there is
// no network and so nothing to count. This file configures a spreadsheet and
// stubs fetch, so the claim "one read and one write instead of N and N" is
// measured rather than asserted.
// ============================================================

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({
  SPREADSHEET_ID: 'sheet_under_test',
  API_KEY: 'key_under_test',
}));

const { updateRowsById, updateRowById, invalidateSheetCache, isConfigured, SHEET_HEADERS } =
  await import('../js/sheets.js');
const { CONFIG } = await import('../js/config.js');

const DESCS = CONFIG.SHEET_OPP_DESCRIPTIONS;
assert.equal(isConfigured(), true, 'this file must run against the configured path');

const HEADERS = SHEET_HEADERS[DESCS];
const row = (id) => [id, 'opp_x', 'Deal', '2026-01-01', 'text', '2026-01-01', 'general'];
const values = (id, text) => [id, 'opp_x', 'Deal', '2026-01-01', text, '2026-01-01'];

// Record every request the sheets layer makes, then answer it plausibly.
function installFetchRecorder(ids) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ method: init.method || 'GET', url: String(url) });
    if ((init.method || 'GET') === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ values: [HEADERS, ...ids.map(row)] }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return calls;
}

const reads = (calls) => calls.filter(c => c.method === 'GET').length;
const writes = (calls) => calls.filter(c => c.method !== 'GET').length;

test('a batch of 4 costs one read and one write', async () => {
  const ids = ['r_a', 'r_b', 'r_c', 'r_d'];
  const calls = installFetchRecorder(ids);
  invalidateSheetCache();

  await updateRowsById(DESCS, 'description_id', ids.map(id => ({ id, values: values(id, 'edited') })));

  assert.equal(reads(calls), 1, 'one read resolves the whole batch');
  assert.equal(writes(calls), 1, 'and one request writes it');
  assert.match(calls.find(c => c.method === 'POST').url, /values:batchUpdate/);
});

test('the same 4 one at a time cost four reads and four writes', async () => {
  // The behaviour being replaced. Same correctness, four times the round trips
  // — and each read pulls the whole tab, which for a descriptions sheet can
  // hold 50k-character analysis HTML per row.
  const ids = ['r_a', 'r_b', 'r_c', 'r_d'];
  const calls = installFetchRecorder(ids);
  invalidateSheetCache();

  for (const id of ids) {
    await updateRowById(DESCS, 'description_id', id, values(id, 'edited'));
  }

  assert.equal(reads(calls), 4, 'one forced read per row');
  assert.equal(writes(calls), 4);
});

test('the batch write targets each row individually, not a blanket range', async () => {
  // A single range spanning the batch would rewrite the rows in between.
  const ids = ['r_a', 'r_b', 'r_c'];
  const calls = installFetchRecorder(ids);
  invalidateSheetCache();

  let body = null;
  const recordingFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST') body = JSON.parse(init.body);
    return recordingFetch(url, init);
  };

  // Rows 2 and 4 of the sheet; row 3 is deliberately left out.
  await updateRowsById(DESCS, 'description_id', [
    { id: 'r_a', values: values('r_a', 'edited') },
    { id: 'r_c', values: values('r_c', 'edited') },
  ]);

  assert.ok(body, 'the batch issued a write');
  assert.equal(body.data.length, 2, 'one range per row');
  const ranges = body.data.map(d => d.range);
  assert.deepEqual(ranges, [`${DESCS}!A2:F2`, `${DESCS}!A4:F4`],
    'the untouched row between them is not inside any range');
  assert.equal(body.valueInputOption, 'USER_ENTERED', 'same interpretation as the write it replaces');
});

test('a refused batch issues no write at all', async () => {
  const calls = installFetchRecorder(['r_a', 'r_a']);   // duplicate id in the sheet
  invalidateSheetCache();

  await assert.rejects(
    () => updateRowsById(DESCS, 'description_id', [{ id: 'r_a', values: values('r_a', 'x') }]),
    /share description_id/,
  );

  assert.equal(writes(calls), 0, 'it read, refused, and wrote nothing');
});
