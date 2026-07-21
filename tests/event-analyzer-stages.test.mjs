// Tests for the event lifecycle model (js/utils/event-analyzer-stages.js).
// Pure data + pure functions transcribed from the standalone playbook
// (index (58).html). Verifies the 7×3 = 21 shape, the machine ids, and the
// playbook completion methodology (met-only completion, first-incomplete
// current stage, later progress never hiding an earlier gap).
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_STAGES,
  TOTAL_ACTIVITIES,
  OWNER_BOTH,
  OWNER_RECAST,
  getEventStageById,
  getEventStageIndex,
  allActivityIds,
  ACTIVITY_IDS,
  ACTIVITY_TO_STAGE,
  ACTIVITY_BY_ID,
  activityIdAt,
  ownerLabel,
  stageStatusFromActivities,
  deriveEventBoard,
  resolveEventPosition,
} from '../js/utils/event-analyzer-stages.js';

// Build a parsed-analysis shape where each named stage has its first N
// activities marked `met` (or a given status) and the rest `no_evidence`.
function analysisWith(counts = {}, statusFor = () => 'met') {
  const stages = EVENT_STAGES.map(s => ({
    stage_id: s.id,
    status: 'in_progress',
    activities: s.activities.map((a, i) => ({
      activity_id: a.id,
      status: i < (counts[s.id] || 0) ? statusFor(s.id, i) : 'no_evidence',
      evidence: '', source_type: 'none', source_id: '', source_date: '',
    })),
  }));
  return { stages };
}

// ── Shape ────────────────────────────────────────────────────────────
test('there are exactly seven stages, in playbook order', () => {
  assert.equal(EVENT_STAGES.length, 7);
  assert.deepEqual(EVENT_STAGES.map(s => s.id), [
    'setup', 'audience', 'messaging', 'drive', 'eventday', 'followup', 'results',
  ]);
});

test('each stage has exactly three activities', () => {
  for (const s of EVENT_STAGES) {
    assert.equal(s.activities.length, 3, `${s.id} should have 3 activities`);
  }
});

test('there are exactly 21 globally-unique activity ids', () => {
  const all = allActivityIds();
  assert.equal(all.length, 21);
  assert.equal(TOTAL_ACTIVITIES, 21);
  assert.equal(new Set(all).size, 21, 'duplicate activity id detected');
  assert.equal(ACTIVITY_IDS.size, 21);
});

test('every stage id is unique and every activity has id/label/owner', () => {
  assert.equal(new Set(EVENT_STAGES.map(s => s.id)).size, 7);
  for (const s of EVENT_STAGES) {
    assert.ok(s.name && typeof s.name === 'string', `${s.id} name`);
    assert.ok(typeof s.timing === 'string', `${s.id} timing`);
    for (const a of s.activities) {
      assert.ok(a.id && typeof a.id === 'string', `${s.id} activity id`);
      assert.ok(a.label && typeof a.label === 'string', `${s.id} activity label`);
      assert.ok(a.owner === OWNER_BOTH || a.owner === OWNER_RECAST || a.owner === 'partner', `${a.id} owner`);
    }
  }
});

test('stage → activity mapping matches the standalone template labels', () => {
  // Spot-check the mapping is faithful to index (58).html.
  assert.deepEqual(getEventStageById('setup').activities.map(a => a.label), [
    'Event topic', 'Date scheduled', 'Why Change, Why Now, Why Us — outline the WHY',
  ]);
  assert.deepEqual(getEventStageById('results').activities.map(a => a.label), [
    'Confirm meetings booked', 'Confirm opportunities created', 'Confirm closed-won deals',
  ]);
  // Owner tags: messaging_proof and the results/drive tracking rows are Recast-led.
  assert.equal(ACTIVITY_BY_ID.messaging_proof.owner, OWNER_RECAST);
  assert.equal(ACTIVITY_BY_ID.drive_registrations.owner, OWNER_RECAST);
  assert.equal(ACTIVITY_BY_ID.results_meetings.owner, OWNER_RECAST);
  assert.equal(ACTIVITY_BY_ID.setup_topic.owner, OWNER_BOTH);
});

test('ACTIVITY_TO_STAGE maps every activity back to its owning stage', () => {
  for (const s of EVENT_STAGES) {
    for (const a of s.activities) assert.equal(ACTIVITY_TO_STAGE[a.id], s.id);
  }
});

test('activityIdAt maps positional saved rows onto stable ids', () => {
  assert.equal(activityIdAt('setup', 0), 'setup_topic');
  assert.equal(activityIdAt('setup', 1), 'setup_date');
  assert.equal(activityIdAt('results', 2), 'results_closed_won');
  assert.equal(activityIdAt('setup', 9), '');
  assert.equal(activityIdAt('nope', 0), '');
});

test('getEventStageById / getEventStageIndex behave', () => {
  assert.equal(getEventStageById('messaging').name, 'Messaging');
  assert.equal(getEventStageById('nope'), null);
  assert.equal(getEventStageIndex('setup'), 1);
  assert.equal(getEventStageIndex('results'), 7);
  assert.equal(getEventStageIndex('nope'), -1);
});

test('ownerLabel resolves tags, with a partner-name override', () => {
  assert.equal(ownerLabel(OWNER_RECAST), 'Recast');
  assert.equal(ownerLabel(OWNER_BOTH), 'Both');
  assert.equal(ownerLabel('partner'), 'Partner');
  assert.equal(ownerLabel('partner', 'Nerdio'), 'Nerdio');
});

// ── Completion methodology ───────────────────────────────────────────
test('a stage is complete only when EVERY activity is met', () => {
  assert.equal(stageStatusFromActivities([
    { status: 'met' }, { status: 'met' }, { status: 'met' },
  ]), 'complete');
  // Two met + one partial is NOT complete (partial never counts as done).
  assert.equal(stageStatusFromActivities([
    { status: 'met' }, { status: 'met' }, { status: 'partial' },
  ]), 'in_progress');
  assert.equal(stageStatusFromActivities([
    { status: 'no_evidence' }, { status: 'no_evidence' }, { status: 'no_evidence' },
  ]), 'not_started');
  assert.equal(stageStatusFromActivities([]), 'not_started');
});

test('a stage is in_progress when at least one activity is met or partial', () => {
  assert.equal(stageStatusFromActivities([
    { status: 'partial' }, { status: 'no_evidence' }, { status: 'no_evidence' },
  ]), 'in_progress');
  assert.equal(stageStatusFromActivities([
    { status: 'met' }, { status: 'no_evidence' }, { status: 'not_met' },
  ]), 'in_progress');
});

test('deriveEventBoard: completion percentage counts only met (not partial)', () => {
  // 3 met in setup + 1 met in audience = 4/21. Partials elsewhere ignored.
  const analysis = analysisWith({ setup: 3, audience: 1, messaging: 3 }, (id, i) => {
    if (id === 'messaging') return 'partial';  // partials must NOT count
    return 'met';
  });
  const board = deriveEventBoard(analysis);
  assert.equal(board.metCount, 4);
  assert.equal(board.totalActivities, 21);
  assert.equal(board.completionPct, Math.round((4 / 21) * 100));
});

test('deriveEventBoard: current stage is the FIRST incomplete stage', () => {
  // setup complete (3/3), audience incomplete (1/3) → current = audience.
  const board = deriveEventBoard(analysisWith({ setup: 3, audience: 1 }));
  assert.equal(board.stages[0].status, 'complete');
  assert.equal(board.stages[1].status, 'in_progress');
  assert.equal(board.currentIndex, getEventStageIndex('audience') - 1);
});

test('later-stage progress never hides an earlier incomplete stage', () => {
  // setup complete, audience/messaging empty, but Results is fully complete.
  // The operational current stage MUST still be audience (the first gap),
  // not results — one isolated later win cannot mark the lifecycle ahead.
  const board = deriveEventBoard(analysisWith({ setup: 3, results: 3 }));
  assert.equal(board.currentIndex, getEventStageIndex('audience') - 1, 'current = first incomplete');
  assert.equal(board.lastCompleteIndex, getEventStageIndex('results') - 1, 'furthest complete is results');
  assert.equal(board.workingIndex, getEventStageIndex('results') - 1, 'furthest with progress is results');
  assert.equal(board.complete, false);
  // Later evidence is still exposed on the board even with the earlier gap.
  assert.equal(board.stages[getEventStageIndex('results') - 1].status, 'complete');
});

test('deriveEventBoard: all stages complete → lifecycle complete', () => {
  const board = deriveEventBoard(analysisWith({
    setup: 3, audience: 3, messaging: 3, drive: 3, eventday: 3, followup: 3, results: 3,
  }));
  assert.equal(board.complete, true);
  assert.equal(board.currentIndex, -1);
  assert.equal(board.metCount, 21);
  assert.equal(board.completionPct, 100);
});

test('deriveEventBoard: nothing done → not started, 0%', () => {
  const board = deriveEventBoard(analysisWith({}));
  assert.equal(board.metCount, 0);
  assert.equal(board.completionPct, 0);
  assert.equal(board.currentIndex, 0, 'first stage is current when nothing is complete');
  assert.equal(board.workingIndex, -1);
  assert.equal(board.complete, false);
});

test('deriveEventBoard tolerates a missing/empty analysis', () => {
  const board = deriveEventBoard(null);
  assert.equal(board.stages.length, 7);
  assert.equal(board.metCount, 0);
  assert.equal(board.completionPct, 0);
  for (const s of board.stages) {
    assert.equal(s.activities.length, 3);
    for (const a of s.activities) assert.equal(a.status, 'no_evidence');
  }
});

test('resolveEventPosition: first-incomplete stage, or complete', () => {
  const partial = deriveEventBoard(analysisWith({ setup: 3, audience: 1 }));
  const pos = resolveEventPosition(partial);
  assert.equal(pos.def.id, 'audience');
  assert.equal(pos.complete, false);
  assert.equal(pos.started, true);

  const done = deriveEventBoard(analysisWith({
    setup: 3, audience: 3, messaging: 3, drive: 3, eventday: 3, followup: 3, results: 3,
  }));
  const donePos = resolveEventPosition(done);
  assert.equal(donePos.complete, true);
  assert.equal(donePos.def.id, 'results');

  const empty = resolveEventPosition(deriveEventBoard(analysisWith({})));
  assert.equal(empty.def.id, 'setup');
  assert.equal(empty.started, false);
});
