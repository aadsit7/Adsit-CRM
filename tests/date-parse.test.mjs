// ============================================================
// Date parsing — every form a date reaches the portal in
// ============================================================
// The portal writes YYYY-MM-DD, but Google Sheets (USER_ENTERED writes,
// FORMATTED_VALUE reads) turns that into a date cell and hands back the
// spreadsheet's display form — "11/16/2026" in a US-locale workbook. The
// old parser only understood YYYY-MM-DD and returned an Invalid Date for
// anything else, which silently failed every "is this upcoming?" check.

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseDate, formatDate } = await import('../js/utils/date.js');

const ymd = (d) => d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('ISO date, with or without a time part, is the calendar day at local midnight', () => {
  for (const input of ['2026-11-16', '2026-11-16T05:00:00.000Z', '2026-11-16T23:59:59Z', '2026-11-16 10:30', ' 2026-11-16 ']) {
    const d = parseDate(input);
    assert.equal(ymd(d), '2026-11-16', input);
    assert.equal(d.getHours(), 0, input);
  }
  assert.equal(ymd(parseDate('2026-1-5')), '2026-01-05');
});

test('the Sheets US display format M/D/YYYY parses to the same day', () => {
  assert.equal(ymd(parseDate('11/16/2026')), '2026-11-16');
  assert.equal(ymd(parseDate('3/4/2026')), '2026-03-04');
  assert.equal(ymd(parseDate('03/04/2026')), '2026-03-04');
});

test('a Sheets serial day number and a Date object are accepted too', () => {
  assert.equal(ymd(parseDate('46342')), '2026-11-16');
  assert.equal(ymd(parseDate(46342)), '2026-11-16');
  assert.equal(ymd(parseDate(new Date(2026, 10, 16, 15, 45))), '2026-11-16');
});

test('free-form dates the engine can read still work', () => {
  assert.equal(ymd(parseDate('Nov 16, 2026')), '2026-11-16');
  assert.equal(ymd(parseDate('November 16, 2026')), '2026-11-16');
});

test('unreadable or impossible values are null, never an Invalid Date', () => {
  for (const input of ['', null, undefined, '   ', 'TBD', 'not a date', '2026-02-30', '13/45/2026', '2026', '99']) {
    assert.equal(parseDate(input), null, String(input));
  }
});

test('formatDate renders every accepted form identically and dashes the rest', () => {
  for (const input of ['2026-11-16', '2026-11-16T05:00:00.000Z', '11/16/2026', 46342, 'Nov 16, 2026']) {
    assert.equal(formatDate(input), 'Nov 16, 2026', String(input));
  }
  assert.equal(formatDate(''), '—');
  assert.equal(formatDate('TBD'), '—');
  assert.equal(formatDate('2026-02-30'), '—');
});
