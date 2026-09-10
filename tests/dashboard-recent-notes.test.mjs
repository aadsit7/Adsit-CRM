// ============================================================
// Dashboard — latest description notes on the Partner Activity cards
// ============================================================
// Each activity card lists the partner's newest description notes
// (Transcripts rows) beneath its Joint Events. These pin the selection:
// partner-scoped, newest first (same key the partner page sorts by),
// empties skipped, capped at three.

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { __dashboardInternals } = await import('../js/views/admin-dashboard.js');
const { pickRecentNotes, notePreview, noteDateLabel, selectTimelineEvents, RECENT_NOTES_LIMIT, UPCOMING_WINDOW_DAYS } = __dashboardInternals;

const note = (partner_id, conversation_date, transcript_text, created_at = '2026-01-01T00:00:00Z', extra = {}) => ({
  transcript_id: `trn_${partner_id}_${conversation_date}_${created_at}`,
  partner_id, partner_name: partner_id, conversation_date, transcript_text, created_at, ...extra,
});

test('the limit is three notes per card', () => {
  assert.equal(RECENT_NOTES_LIMIT, 3);
});

test('the Upcoming Joint Events timeline looks 90 days ahead', () => {
  assert.equal(UPCOMING_WINDOW_DAYS, 90);
});

// ── Timeline selection ──────────────────────────────────────────────

const today = new Date(2026, 8, 10); // Sep 10, 2026, local midnight
const evt = (title, event_date, end_date = '') => ({ event_id: title, title, event_date, end_date, status: 'Upcoming' });

test('events inside the window are listed by start date; past and beyond-window ones are not', () => {
  const picked = selectTimelineEvents([
    evt('day 100', '2026-12-19'),
    evt('day 67', '2026-11-16'),
    evt('yesterday', '2026-09-09'),
    evt('today', '2026-09-10'),
    evt('day 90', '2026-12-09'),
    evt('day 47', '2026-10-27'),
  ], today);
  assert.deepEqual(picked.map(e => e.title), ['today', 'day 47', 'day 67', 'day 90']);
});

test('dates in the Sheets display format count the same as ISO ones', () => {
  const picked = selectTimelineEvents([
    evt('Microsoft Ignite happy hour', '11/16/2026'),
    evt('Elantis webinar', '11/10/2026'),
    evt('SCD webinar', '11/5/2026'),
    evt('Nerdio webinar', '10/27/2026'),
    evt('NerdioCon 2027', '3/15/2027', '3/18/2027'),
    evt('last year', '9/1/2025'),
  ], today);
  assert.deepEqual(picked.map(e => e.title), ['Nerdio webinar', 'SCD webinar', 'Elantis webinar', 'Microsoft Ignite happy hour']);
});

test('a multi-day event already underway stays listed until its last day', () => {
  const picked = selectTimelineEvents([
    evt('running now', '2026-09-01', '2026-09-12'),
    evt('ended yesterday', '2026-09-01', '2026-09-09'),
    evt('ends today', '2026-08-06', '2026-09-10'),
    evt('bad end date is ignored', '2026-09-20', '2026-09-01'),
  ], today);
  assert.deepEqual(picked.map(e => e.title), ['ends today', 'running now', 'bad end date is ignored']);
});

test('events without a readable date are skipped rather than crashing the panel', () => {
  const picked = selectTimelineEvents([evt('TBD', 'TBD'), evt('blank', ''), evt('ok', '2026-09-20')], today);
  assert.deepEqual(picked.map(e => e.title), ['ok']);
});

test('only this partner\'s notes, newest conversation first, capped at the limit', () => {
  const rows = [
    note('p_a', '2026-03-01', '<p>March</p>'),
    note('p_b', '2026-09-01', '<p>Other partner</p>'),
    note('p_a', '2026-05-01', '<p>May</p>'),
    note('p_a', '2026-01-01', '<p>January</p>'),
    note('p_a', '2026-07-01', '<p>July</p>'),
    note(' p_a ', '2026-08-01', '<p>Padded id</p>'),
  ];
  const picked = pickRecentNotes(rows, 'p_a');
  assert.deepEqual(picked.map(n => n.conversation_date), ['2026-08-01', '2026-07-01', '2026-05-01']);
  assert.ok(picked.every(n => String(n.partner_id).trim() === 'p_a'));
});

test('a custom limit is honoured', () => {
  const rows = [
    note('p_a', '2026-03-01', 'a'), note('p_a', '2026-04-01', 'b'), note('p_a', '2026-05-01', 'c'),
  ];
  assert.equal(pickRecentNotes(rows, 'p_a', 1).length, 1);
  assert.equal(pickRecentNotes(rows, 'p_a', 1)[0].conversation_date, '2026-05-01');
  assert.equal(pickRecentNotes(rows, 'p_a', 10).length, 3);
});

test('empty notes are skipped — Quill\'s blank markup included', () => {
  const rows = [
    note('p_a', '2026-09-03', '<p><br></p>'),
    note('p_a', '2026-09-02', '   '),
    note('p_a', '2026-09-01', ''),
    note('p_a', '2026-08-30', '<p>Real note</p>'),
  ];
  const picked = pickRecentNotes(rows, 'p_a');
  assert.equal(picked.length, 1);
  assert.equal(picked[0].conversation_date, '2026-08-30');
});

test('falls back to created_at when the conversation date is missing, and breaks same-day ties by created_at', () => {
  const rows = [
    note('p_a', '', '<p>No date, created late</p>', '2026-09-05T10:00:00Z'),
    note('p_a', '2026-09-04', '<p>Dated earlier</p>', '2026-09-04T09:00:00Z'),
    note('p_a', '2026-09-04', '<p>Same day, written later</p>', '2026-09-04T17:00:00Z'),
    note('p_a', 'not a date', '<p>Garbage date sorts last</p>', 'also garbage'),
  ];
  const picked = pickRecentNotes(rows, 'p_a');
  assert.deepEqual(picked.map(n => notePreview(n)), [
    'No date, created late',
    'Same day, written later',
    'Dated earlier',
  ]);
});

test('degenerate inputs yield nothing rather than throwing', () => {
  assert.deepEqual(pickRecentNotes(undefined, 'p_a'), []);
  assert.deepEqual(pickRecentNotes([], 'p_a'), []);
  assert.deepEqual(pickRecentNotes([note('p_a', '2026-01-01', 'x')], ''), []);
  assert.deepEqual(pickRecentNotes([null, undefined, note('p_a', '2026-01-01', 'x')], 'p_a').length, 1);
});

test('the preview flattens rich text to one line and truncates with an ellipsis', () => {
  const html = '<h2>Objective</h2><p>Discuss   the Q4 co-sell plan.</p><ul><li>Item one</li><li>Item two</li></ul>';
  assert.equal(notePreview(note('p_a', '2026-01-01', html)), 'Objective Discuss the Q4 co-sell plan. Item one Item two');

  const long = 'word '.repeat(60).trim();
  const preview = notePreview(note('p_a', '2026-01-01', long), 40);
  assert.ok(preview.length <= 40, `preview is ${preview.length} chars`);
  assert.ok(preview.endsWith('…'));
  assert.ok(!preview.endsWith(' …'), 'no dangling space before the ellipsis');
});

test('the date label prefers the conversation date and falls back to created_at', () => {
  assert.equal(noteDateLabel(note('p_a', '2026-09-03', 'x')), 'Sep 3, 2026');
  assert.equal(noteDateLabel(note('p_a', '', 'x', '2026-02-10T15:00:00Z')), 'Feb 10, 2026');
});
