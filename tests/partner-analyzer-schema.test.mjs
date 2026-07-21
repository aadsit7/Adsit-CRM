// Tests for the strict Partner analysis parser (js/utils/partner-analyzer-schema.js).
// The parser — NOT the model — enforces correctness: fabricated ids/dates and
// ungrounded quotes are rejected, wrong-stage/unknown criteria are dropped,
// structured claims need supporting facts, deterministic facts override the
// model, and every derived value (stage status, operational + furthest stage,
// completion %) is recomputed.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePartnerAnalysisResponse, PARTNER_ANALYZER_SCHEMA_EXAMPLE } from '../js/utils/partner-analyzer-schema.js';
import { PARTNER_STAGES } from '../js/utils/partner-analyzer-stages.js';

// Real evidence package the model is allowed to cite.
const ANCHORS = {
  narrativeIds: new Set(['t1', 'od1']),
  narrativeDates: new Set(['2026-06-10', '2026-06-25']),
  textById: new Map([
    ['t1', 'We aligned on shared goals and priorities for the AVD rollout this year.'],
    ['od1', 'Proposal submitted and we are negotiating the final scope with procurement.'],
  ]),
  textByDate: new Map([
    ['2026-06-10', 'We aligned on shared goals and priorities for the AVD rollout this year.'],
    ['2026-06-25', 'Proposal submitted and we are negotiating the final scope with procurement.'],
  ]),
  structuredIds: new Set(['o1', 'e1', 'p1']),
  relatedById: new Map([['t1', 'p1'], ['od1', 'o1']]),
  partnerId: 'p1',
};

function crit(id, extra = {}) {
  return { criterion_id: id, status: 'met', evidence: '', source_type: 'none', source_id: '', source_date: '', related_entity_id: '', ...extra };
}
function stage(id, criteria, status = 'in_progress') {
  return { stage_id: id, status, notes: '', criteria };
}
function baseResponse(stages) {
  return JSON.stringify({
    partner_id: 'p1', partner_name: 'Nerdio',
    operational_stage_id: 'revenue_growth', furthest_demonstrated_stage_id: 'revenue_growth',
    confidence: 'high', summary: 'Doing well.', stages,
    next_actions: ['x'], gaps: ['y'], open_questions: ['z'], risks: ['r'], momentum: ['m'],
  });
}
function parse(stages, opts = {}) {
  return parsePartnerAnalysisResponse(baseResponse(stages), { anchors: ANCHORS, ...opts });
}
function critOf(out, stageId, criterionId) {
  return out.stages.find(s => s.stage_id === stageId).criteria.find(c => c.criterion_id === criterionId);
}

// ── Grounded narrative survives ──────────────────────────────────────
test('a grounded narrative met survives with its source + link target', () => {
  const out = parse([
    stage('relationship_alignment', [crit('goals_priorities_aligned', {
      evidence: 'Aligned on shared goals and priorities for the rollout.',
      source_type: 'transcript', source_id: 't1', source_date: '2026-06-10',
    })]),
  ]);
  const c = critOf(out, 'relationship_alignment', 'goals_priorities_aligned');
  assert.equal(c.status, 'met');
  assert.equal(c.source_id, 't1');
  assert.equal(c.related_entity_id, 'p1', 'transcript links to the partner');
});

// ── Fabrications rejected ────────────────────────────────────────────
test('a fabricated source_id (not in the evidence) is rejected → no_evidence', () => {
  const out = parse([
    stage('relationship_alignment', [crit('goals_priorities_aligned', {
      evidence: 'Aligned on shared goals.', source_type: 'transcript', source_id: 'FAKE', source_date: '',
    })]),
  ]);
  assert.equal(critOf(out, 'relationship_alignment', 'goals_priorities_aligned').status, 'no_evidence');
});

test('a fabricated source_date is cleared; with no other anchor the claim is downgraded', () => {
  const out = parse([
    stage('relationship_alignment', [crit('goals_priorities_aligned', {
      evidence: 'Aligned on shared goals.', source_type: 'transcript', source_id: '', source_date: '1999-01-01',
    })]),
  ]);
  assert.equal(critOf(out, 'relationship_alignment', 'goals_priorities_aligned').status, 'no_evidence');
});

test('a fabricated quote pinned to a REAL id is rejected by grounding', () => {
  const out = parse([
    stage('relationship_alignment', [crit('goals_priorities_aligned', {
      evidence: 'Legal review complete and the signed contract was returned by the customer.',
      source_type: 'transcript', source_id: 't1', source_date: '2026-06-10',
    })]),
  ]);
  assert.equal(critOf(out, 'relationship_alignment', 'goals_priorities_aligned').status, 'no_evidence', 'ungrounded quote downgraded');
});

// ── Structure guards ─────────────────────────────────────────────────
test('a criterion filed under the WRONG stage is dropped', () => {
  // revenue_won belongs to revenue_growth, not profile_fit.
  const out = parse([
    stage('profile_fit', [crit('revenue_won', { source_type: 'opportunity', source_id: 'o1' })]),
  ], { facts: { structuredSupport: { revenue_won: true } } });
  assert.equal(critOf(out, 'revenue_growth', 'revenue_won').status, 'no_evidence', 'wrong-stage placement ignored');
});

test('unknown criterion ids and unknown stage ids are dropped', () => {
  const out = parse([
    stage('profile_fit', [crit('made_up_criterion', { source_type: 'partner_profile' }), crit('partner_profile_complete', { source_type: 'partner_profile' })]),
    stage('not_a_stage', [crit('revenue_won')]),
  ], { facts: { structuredSupport: { partner_profile_complete: true } } });
  // The made-up criterion never appears; partner_profile_complete stands (supported).
  const pf = out.stages.find(s => s.stage_id === 'profile_fit');
  assert.ok(!pf.criteria.some(c => c.criterion_id === 'made_up_criterion'));
  assert.equal(pf.criteria.find(c => c.criterion_id === 'partner_profile_complete').status, 'met');
});

// ── Structured claims ────────────────────────────────────────────────
test('a structured claim is downgraded without support and survives with it', () => {
  const stages = [stage('pipeline_execution', [crit('active_pipeline', { source_type: 'opportunity', source_id: 'o1' })])];
  const without = parse(stages);
  assert.equal(critOf(without, 'pipeline_execution', 'active_pipeline').status, 'no_evidence', 'unsupported structured claim downgraded');
  const withSupport = parse(stages, { facts: { structuredSupport: { active_pipeline: true } } });
  assert.equal(critOf(withSupport, 'pipeline_execution', 'active_pipeline').status, 'met', 'supported structured claim stands');
});

test('a fabricated structured source_id is cleared but an aggregate-backed claim still stands', () => {
  const out = parse([
    stage('pipeline_execution', [crit('active_pipeline', { source_type: 'opportunity', source_id: 'FAKEOPP' })]),
  ], { facts: { structuredSupport: { active_pipeline: true } } });
  const c = critOf(out, 'pipeline_execution', 'active_pipeline');
  assert.equal(c.status, 'met');
  assert.equal(c.source_id, '', 'fabricated structured id cleared');
});

// ── Deterministic facts override the model ───────────────────────────
test('deterministic facts override the model (win overrides a "no wins" claim)', () => {
  const out = parse([
    stage('revenue_growth', [crit('revenue_won', { status: 'not_met', evidence: 'No wins yet', source_type: 'none' })]),
  ], {
    facts: {
      deterministic: {
        revenue_won: { status: 'met', source_type: 'opportunity', evidence: '1 closed-won deal', source_id: 'o1', related_entity_id: 'o1' },
      },
    },
  });
  const c = critOf(out, 'revenue_growth', 'revenue_won');
  assert.equal(c.status, 'met', 'deterministic won overrides the model');
  assert.equal(c.related_entity_id, 'o1');
});

test('deterministic facts are applied even when the model omits the criterion', () => {
  const out = parse([], {
    facts: { deterministic: { opportunities_created: { status: 'met', source_type: 'opportunity', evidence: 'linked opps', source_id: 'o1', related_entity_id: 'o1' } } },
  });
  assert.equal(critOf(out, 'pipeline_execution', 'opportunities_created').status, 'met');
});

// ── Recomputation ────────────────────────────────────────────────────
test('the model cannot self-award its stage — operational + furthest are recomputed', () => {
  // Model claims everything complete, but only profile_fit is actually met.
  const stages = PARTNER_STAGES.map(s => stage(s.id, s.criteria.map(c => crit(c.id, { source_type: 'partner_profile' })), 'complete'));
  const out = parse(stages, { facts: { structuredSupport: { partner_profile_complete: true, strategic_fit_defined: false } } });
  // Only partner_profile_complete had support → profile_fit is NOT complete →
  // operational is the FIRST stage.
  assert.equal(out.operational_stage_id, 'profile_fit');
  assert.equal(out.maturity_complete, false);
});

test('completion percentage counts only validated met criteria', () => {
  const out = parse([
    stage('profile_fit', [
      crit('partner_profile_complete', { source_type: 'partner_profile' }),
      crit('strategic_fit_defined', { status: 'partial', source_type: 'transcript', source_id: 't1', source_date: '2026-06-10', evidence: 'aligned on shared goals' }),
    ]),
  ], { facts: { structuredSupport: { partner_profile_complete: true } } });
  // 1 met (profile_complete) + 1 partial (not counted) = 1/21.
  assert.equal(out.completion.met, 1);
  assert.equal(out.completion.total, 21);
  assert.equal(out.completion.pct, Math.round((1 / 21) * 100));
});

test('furthest_demonstrated_stage_id is the furthest stage with a met criterion', () => {
  const out = parse([
    stage('profile_fit', [crit('partner_profile_complete', { source_type: 'partner_profile' })]),
    stage('revenue_growth', [crit('revenue_won', { source_type: 'opportunity', source_id: 'o1' })]),
  ], { facts: { structuredSupport: { partner_profile_complete: true, revenue_won: true } } });
  assert.equal(out.furthest_demonstrated_stage_id, 'revenue_growth');
  // profile_fit has only 1 of 3 criteria met → it is itself the first incomplete stage.
  assert.equal(out.operational_stage_id, 'profile_fit', 'operational is still the first incomplete stage');
});

// ── Canonical shape + safety ─────────────────────────────────────────
test('output is always the canonical 7×3 board even from a sparse response', () => {
  const out = parse([stage('profile_fit', [])]);
  assert.equal(out.stages.length, 7);
  for (const s of out.stages) assert.equal(s.criteria.length, 3);
});

test('duplicate stages and criteria are de-duplicated (first wins)', () => {
  const out = parse([
    stage('profile_fit', [crit('partner_profile_complete', { source_type: 'partner_profile' }), crit('partner_profile_complete', { status: 'not_met' })]),
    stage('profile_fit', [crit('strategic_fit_defined', { status: 'not_met' })]),
  ], { facts: { structuredSupport: { partner_profile_complete: true } } });
  const pf = out.stages.find(s => s.stage_id === 'profile_fit');
  assert.equal(pf.criteria.find(c => c.criterion_id === 'partner_profile_complete').status, 'met', 'first claim wins');
});

test('malformed / empty / non-object responses throw coded errors', () => {
  assert.throws(() => parsePartnerAnalysisResponse('   '), e => e.code === 'PARTNER_JSON_EMPTY');
  assert.throws(() => parsePartnerAnalysisResponse('not json at all {'), e => e.code === 'PARTNER_JSON_INVALID');
  assert.throws(() => parsePartnerAnalysisResponse('[1,2,3]'), e => e.code === 'PARTNER_JSON_SCHEMA');
});

test('a fenced / prose-wrapped JSON object is still parsed', () => {
  const wrapped = 'Here you go:\n```json\n' + baseResponse([stage('profile_fit', [])]) + '\n```';
  const out = parsePartnerAnalysisResponse(wrapped, { anchors: ANCHORS });
  assert.equal(out.partner_id, 'p1');
  assert.equal(out.stages.length, 7);
});

test('the schema example advertises every source type and the criteria shape', () => {
  assert.ok(PARTNER_ANALYZER_SCHEMA_EXAMPLE.includes('saved_event_playbook'));
  assert.ok(PARTNER_ANALYZER_SCHEMA_EXAMPLE.includes('related_entity_id'));
  assert.ok(PARTNER_ANALYZER_SCHEMA_EXAMPLE.includes('operational_stage_id'));
});
