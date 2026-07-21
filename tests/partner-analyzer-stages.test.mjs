// Tests for the Partner Maturity model (js/utils/partner-analyzer-stages.js).
// Pure data + pure functions. Verifies the 7×3 = 21 shape, the machine ids,
// and the maturity methodology (met-only completion, first-incomplete
// operational stage, an independent furthest-demonstrated stage, and later
// evidence never hiding an earlier gap).
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PARTNER_STAGES,
  TOTAL_CRITERIA,
  getPartnerStageById,
  getPartnerStageIndex,
  allCriterionIds,
  CRITERION_IDS,
  CRITERION_TO_STAGE,
  CRITERION_BY_ID,
  stageStatusFromCriteria,
  derivePartnerBoard,
  resolvePartnerPosition,
  resolveFurthestDemonstrated,
} from '../js/utils/partner-analyzer-stages.js';

// Build a parsed-analysis shape where each named stage has its first N
// criteria marked with a status and the rest `no_evidence`.
function analysisWith(counts = {}, statusFor = () => 'met') {
  const stages = PARTNER_STAGES.map(s => ({
    stage_id: s.id,
    status: 'in_progress',
    criteria: s.criteria.map((c, i) => ({
      criterion_id: c.id,
      status: i < (counts[s.id] || 0) ? statusFor(s.id, i) : 'no_evidence',
      evidence: '', source_type: 'none', source_id: '', source_date: '', related_entity_id: '',
    })),
  }));
  return { stages };
}

// ── Shape ────────────────────────────────────────────────────────────
test('there are exactly seven stages, in framework order', () => {
  assert.equal(PARTNER_STAGES.length, 7);
  assert.deepEqual(PARTNER_STAGES.map(s => s.id), [
    'profile_fit', 'relationship_alignment', 'enablement_readiness',
    'joint_gtm', 'market_engagement', 'pipeline_execution', 'revenue_growth',
  ]);
});

test('each stage has exactly three criteria', () => {
  for (const s of PARTNER_STAGES) {
    assert.equal(s.criteria.length, 3, `${s.id} should have 3 criteria`);
  }
});

test('there are exactly 21 globally-unique criterion ids', () => {
  const all = allCriterionIds();
  assert.equal(all.length, 21);
  assert.equal(TOTAL_CRITERIA, 21);
  assert.equal(new Set(all).size, 21, 'duplicate criterion id detected');
  assert.equal(CRITERION_IDS.size, 21);
});

test('criterion ids match the framework spec exactly', () => {
  assert.deepEqual(getPartnerStageById('profile_fit').criteria.map(c => c.id), [
    'partner_profile_complete', 'strategic_fit_defined', 'key_stakeholders_identified',
  ]);
  assert.deepEqual(getPartnerStageById('revenue_growth').criteria.map(c => c.id), [
    'revenue_won', 'repeatable_motion', 'growth_plan',
  ]);
  assert.deepEqual(getPartnerStageById('pipeline_execution').criteria.map(c => c.id), [
    'opportunities_created', 'active_pipeline', 'deal_progression',
  ]);
});

test('every stage id is unique and each criterion has id + label', () => {
  assert.equal(new Set(PARTNER_STAGES.map(s => s.id)).size, 7);
  for (const s of PARTNER_STAGES) {
    assert.ok(s.name && typeof s.name === 'string');
    for (const c of s.criteria) {
      assert.ok(c.id && typeof c.id === 'string');
      assert.ok(c.label && typeof c.label === 'string');
    }
  }
});

test('CRITERION_TO_STAGE maps every criterion back to its owning stage', () => {
  for (const s of PARTNER_STAGES) {
    for (const c of s.criteria) assert.equal(CRITERION_TO_STAGE[c.id], s.id);
  }
  assert.equal(CRITERION_BY_ID.revenue_won.label.length > 0, true);
});

test('lookup helpers behave', () => {
  assert.equal(getPartnerStageById('joint_gtm').name, 'Joint Go-to-Market Planning');
  assert.equal(getPartnerStageById('nope'), null);
  assert.equal(getPartnerStageIndex('profile_fit'), 1);
  assert.equal(getPartnerStageIndex('revenue_growth'), 7);
  assert.equal(getPartnerStageIndex('nope'), -1);
});

// ── Completion methodology ───────────────────────────────────────────
test('a stage is complete only when EVERY criterion is met', () => {
  assert.equal(stageStatusFromCriteria([{ status: 'met' }, { status: 'met' }, { status: 'met' }]), 'complete');
  // Two met + one partial is NOT complete (partial never counts as done).
  assert.equal(stageStatusFromCriteria([{ status: 'met' }, { status: 'met' }, { status: 'partial' }]), 'in_progress');
  assert.equal(stageStatusFromCriteria([{ status: 'no_evidence' }, { status: 'no_evidence' }, { status: 'no_evidence' }]), 'not_started');
  assert.equal(stageStatusFromCriteria([]), 'not_started');
});

test('a stage is in_progress when at least one criterion is met or partial', () => {
  assert.equal(stageStatusFromCriteria([{ status: 'partial' }, { status: 'no_evidence' }, { status: 'no_evidence' }]), 'in_progress');
  assert.equal(stageStatusFromCriteria([{ status: 'met' }, { status: 'no_evidence' }, { status: 'not_met' }]), 'in_progress');
});

test('completion percentage counts only met criteria (never partial)', () => {
  // 3 met in profile_fit + 1 met in relationship = 4/21. Partials ignored.
  const analysis = analysisWith({ profile_fit: 3, relationship_alignment: 1, enablement_readiness: 3 }, (id) => {
    return id === 'enablement_readiness' ? 'partial' : 'met';
  });
  const board = derivePartnerBoard(analysis);
  assert.equal(board.metCount, 4);
  assert.equal(board.totalCriteria, 21);
  assert.equal(board.completionPct, Math.round((4 / 21) * 100));
});

test('operational stage is the FIRST incomplete stage', () => {
  const board = derivePartnerBoard(analysisWith({ profile_fit: 3, relationship_alignment: 1 }));
  assert.equal(board.stages[0].status, 'complete');
  assert.equal(board.stages[1].status, 'in_progress');
  assert.equal(board.operationalIndex, getPartnerStageIndex('relationship_alignment') - 1);
});

test('later evidence never hides an earlier gap; furthest-demonstrated is independent', () => {
  // profile_fit complete, relationship/enablement empty, but revenue_growth fully met.
  const board = derivePartnerBoard(analysisWith({ profile_fit: 3, revenue_growth: 3 }));
  // Operational stage MUST still be relationship_alignment (the first gap).
  assert.equal(board.operationalIndex, getPartnerStageIndex('relationship_alignment') - 1, 'operational = first incomplete');
  // Furthest demonstrated is revenue_growth (has met criteria).
  assert.equal(board.furthestDemonstratedIndex, getPartnerStageIndex('revenue_growth') - 1, 'furthest with a met is revenue_growth');
  assert.equal(board.lastCompleteIndex, getPartnerStageIndex('revenue_growth') - 1);
  assert.equal(board.complete, false);
  // Later evidence is still exposed on the board.
  assert.equal(board.stages[getPartnerStageIndex('revenue_growth') - 1].status, 'complete');
});

test('furthest-demonstrated ignores partial-only stages (needs a met)', () => {
  const board = derivePartnerBoard(analysisWith({ profile_fit: 1, market_engagement: 2 }, (id) => {
    return id === 'market_engagement' ? 'partial' : 'met';
  }));
  // market_engagement has only partials → not "demonstrated".
  assert.equal(board.furthestDemonstratedIndex, getPartnerStageIndex('profile_fit') - 1);
  // ...but it IS working (has progress).
  assert.equal(board.workingIndex, getPartnerStageIndex('market_engagement') - 1);
});

test('all stages complete → maturity complete (Revenue & Growth — Mature)', () => {
  const full = {};
  for (const s of PARTNER_STAGES) full[s.id] = 3;
  const board = derivePartnerBoard(analysisWith(full));
  assert.equal(board.complete, true);
  assert.equal(board.operationalIndex, -1);
  assert.equal(board.metCount, 21);
  assert.equal(board.completionPct, 100);
  const pos = resolvePartnerPosition(board);
  assert.equal(pos.mature, true);
  assert.equal(pos.def.id, 'revenue_growth');
});

test('nothing done → not started, 0%, operational = first stage', () => {
  const board = derivePartnerBoard(analysisWith({}));
  assert.equal(board.metCount, 0);
  assert.equal(board.completionPct, 0);
  assert.equal(board.operationalIndex, 0);
  assert.equal(board.workingIndex, -1);
  assert.equal(board.furthestDemonstratedIndex, -1);
  const pos = resolvePartnerPosition(board);
  assert.equal(pos.def.id, 'profile_fit');
  assert.equal(pos.started, false);
});

test('derivePartnerBoard tolerates a missing/empty analysis', () => {
  const board = derivePartnerBoard(null);
  assert.equal(board.stages.length, 7);
  assert.equal(board.metCount, 0);
  for (const s of board.stages) {
    assert.equal(s.criteria.length, 3);
    for (const c of s.criteria) assert.equal(c.status, 'no_evidence');
  }
});

test('resolvePartnerPosition + resolveFurthestDemonstrated on a mixed board', () => {
  const board = derivePartnerBoard(analysisWith({ profile_fit: 3, relationship_alignment: 3, enablement_readiness: 1, pipeline_execution: 2 }));
  const op = resolvePartnerPosition(board);
  assert.equal(op.def.id, 'enablement_readiness', 'operational = first incomplete');
  assert.equal(op.mature, false);
  const fd = resolveFurthestDemonstrated(board);
  assert.equal(fd.def.id, 'pipeline_execution', 'furthest demonstrated = pipeline_execution');
  assert.equal(resolveFurthestDemonstrated(derivePartnerBoard(analysisWith({}))).def, null);
});
