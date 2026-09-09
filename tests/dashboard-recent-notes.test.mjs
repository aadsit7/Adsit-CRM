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
const { pickRecentNotes, notePreview, noteDateLabel, RECENT_NOTES_LIMIT } = __dashboardInternals;

const note = (partner_id, conversation_date, transcript_text, created_at = '2026-01-01T00:00:00Z', extra = {}) => ({
  transcript_id: `trn_${partner_id}_${conversation_date}_${created_at}`,
  partner_id, partner_name: partner_id, conversation_date, transcript_text, created_at, ...extra,
});

test('the limit is three notes per card', () => {
  assert.equal(RECENT_NOTES_LIMIT, 3);
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
