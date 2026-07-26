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

test('a prompt reorder is one request, not one per row', async () => {
  // The last loop of sequential positional PUTs. Reordering is positional by
  // nature — that is what a reorder IS — but doing it row by row meant a
  // failure part-way left the list scrambled, with some prompts at their new
  // positions and some at their old.
  const { saveReorderedPrompts } = await import('../js/sheets.js');
  const presets = ['p1', 'p2', 'p3'].map((id, i) => ({
    prompt_id: id, label: `L${i}`, icon: '', instructions: '', created_at: '', provider: 'claude',
  }));

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ method: init.method || 'GET', url: String(url) });
    if ((init.method || 'GET') === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          values: [
            ['prompt_id', 'label', 'icon', 'instructions', 'created_at', 'provider'],
            ...presets.map(p => [p.prompt_id, p.label, '', '', '', 'claude']),
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  invalidateSheetCache();

  let body = null;
  const recorder = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST') body = JSON.parse(init.body);
    return recorder(url, init);
  };

  await saveReorderedPrompts(presets);

  assert.equal(calls.filter(c => c.method !== 'GET').length, 1,
    'one request rewrites the whole order');
  assert.match(calls.find(c => c.method === 'POST').url, /values:batchUpdate/);

  // Assert WHAT is written, not just how many requests it took. The row
  // arithmetic here is the whole job — `i + 1` would write the first prompt
  // over the header row and destroy the column names every later read depends
  // on, and a reversed list would save the exact opposite order. Both make
  // precisely one request, so the count alone cannot tell them apart.
  assert.deepEqual(body.data.map(d => d.range),
    ['Custom_Prompts!A2:F2', 'Custom_Prompts!A3:F3', 'Custom_Prompts!A4:F4'],
    'rows 2..N+1 — the header row is never inside a range');
  assert.deepEqual(body.data.map(d => d.values[0][0]), ['p1', 'p2', 'p3'],
    'and each prompt lands at its own position, in the order given');
});

// ── What the view writes actually put on the wire ───────────────────
// The demo store replaces a whole row array, so it cannot show the range a
// write covers — and the range is exactly what protects the columns past the
// end of it. These drive the real view functions with a stubbed fetch and
// assert both the range and the column order.

const viewWrite = async (fn, sheet, headers, row) => {
  let sent = null;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ values: [headers, row] }) };
    }
    sent = { url: decodeURIComponent(String(url)), body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  invalidateSheetCache();
  await fn();
  assert.ok(sent, 'a write was issued');
  return sent;
};

test('an event drag writes A:M, leaving lead_count and event_password outside the range', async () => {
  const { __eventWriteInternals } = await import('../js/views/admin-events.js');
  const H = SHEET_HEADERS[CONFIG.SHEET_EVENTS];
  const row = ['evt_1', 'Summit', 'desc', '2026-06-01', '2026-06-02', 'Webinar', 'Denver', '',
               'admin', '2026-01-01', 'Upcoming', 'p_1', '["c"]', '42', 's3cret'];

  const sent = await viewWrite(
    () => __eventWriteInternals.saveEventStatus('evt_1', 'Completed'),
    CONFIG.SHEET_EVENTS, H, row);

  assert.match(sent.url, /Events!A2:M2/, 'the range stops at M');
  const written = sent.body.values[0];
  assert.equal(written.length, 13, 'columns N and O are not in the payload at all');
  assert.equal(written[10], 'Completed', 'status is the column being set');
  assert.deepEqual(written.slice(0, 10), row.slice(0, 10), 'everything before it is unchanged');
  assert.equal(written[12], '["c"]', 'and the checklist came back from the sheet');
});

test('a partner edit writes all 11 columns in schema order', async () => {
  const { __partnerWriteInternals } = await import('../js/views/admin-partners.js');
  const H = SHEET_HEADERS[CONFIG.SHEET_PARTNERS];
  const row = ['p_1', 'olduser', 'Old Name', 'MSP', 'Gold', 'NA', '2020-01-01', 'TRUE', 'HASH', 'Active', 'Denver'];

  const sent = await viewWrite(
    () => __partnerWriteInternals.savePartnerEdit('p_1', {
      username: 'newuser', display_name: 'New Name', partner_type: 'OEM',
      tier: 'Platinum', region: 'EMEA', status: 'Inactive', hq_location: 'Austin',
    }),
    CONFIG.SHEET_PARTNERS, H, row);

  assert.match(sent.url, /Partners!A2:K2/);
  // Pinned against the schema by name, so a transposed pair is caught.
  const written = Object.fromEntries(H.map((h, i) => [h, sent.body.values[0][i]]));
  assert.deepEqual(written, {
    partner_id: 'p_1', username: 'newuser', display_name: 'New Name', partner_type: 'OEM',
    tier: 'Platinum', region: 'EMEA', created_at: '2020-01-01', is_admin: 'TRUE',
    password_hash: 'HASH', status: 'Inactive', hq_location: 'Austin',
  });
});

test('a kanban drag writes all 13 opportunity columns in schema order', async () => {
  const { __oppWriteInternals } = await import('../js/views/admin-opportunities.js');
  const H = SHEET_HEADERS[CONFIG.SHEET_OPPORTUNITIES];
  const row = ['o_1', 'p_1', 'Deal', 'Cust', '1000', 'Open', 'Discovery', '2026-12-01',
               'desc', '2020-01-01', '2020-01-02', '["n"]', 'salesperson'];

  const sent = await viewWrite(
    () => __oppWriteInternals.saveOppStage('o_1', 'Negotiation'),
    CONFIG.SHEET_OPPORTUNITIES, H, row);

  assert.match(sent.url, /Opportunities!A2:M2/);
  const written = Object.fromEntries(H.map((h, i) => [h, sent.body.values[0][i]]));
  assert.equal(written.stage, 'Negotiation', 'the dragged column');
  assert.equal(written.created_at, '2020-01-01', 'created_at is preserved, not restamped');
  assert.notEqual(written.updated_at, '2020-01-02', 'updated_at is refreshed');
  for (const k of ['opportunity_id', 'partner_id', 'deal_name', 'customer_name', 'deal_value',
                   'status', 'expected_close', 'description', 'notes', 'lead_source']) {
    assert.equal(written[k], row[H.indexOf(k)], `${k} came back from the sheet unchanged`);
  }
});
