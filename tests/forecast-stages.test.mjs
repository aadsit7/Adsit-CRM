// Sanity tests for the forecast stage model (js/utils/forecast-stages.js).
// This is pure data + pure functions — no browser shims needed, but we
// import _setup.mjs to stay consistent with the rest of the suite.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FORECAST_STAGES,
  BUYING_PROCESS_BANDS,
  LEGACY_STAGES,
  mapLegacyStage,
  getStageById,
  getStageIndex,
  allCriterionIds,
  CRITERION_IDS,
  CRITERION_TO_STAGE,
  getBucketForStageId,
  getProbabilityForStageId,
  deriveForecastBoard,
  isStageSubstantial,
  resolveForecastPosition,
  compareToCrmStage,
  SUBSTANTIAL_STAGE_RATIO,
} from '../js/utils/forecast-stages.js';

// Build a parsed-forecast shape where each named stage has its first N
// criteria marked "met" and the rest "no_evidence". Lets the tests describe a
// board by "how many criteria are met per stage" without hand-writing ids.
function forecastWith(metCounts = {}) {
  const stages = FORECAST_STAGES.map(s => ({
    stage_id: s.id,
    status: 'in_progress',
    criteria: s.criteria.map((c, i) => ({
      criterion_id: c.id,
      status: i < (metCounts[s.id] || 0) ? 'met' : 'no_evidence',
      evidence: '',
      source_date: '',
      source_id: '',
    })),
  }));
  return { stages };
}

test('there are exactly seven stages, in order', () => {
  assert.equal(FORECAST_STAGES.length, 7);
  const ids = FORECAST_STAGES.map(s => s.id);
  assert.deepEqual(ids, [
    'inside_sales_working', 'sal', 'identification', 'qualification',
    'development', 'proposal', 'closing',
  ]);
});

test('every criterion id is unique across all stages', () => {
  const all = allCriterionIds();
  const unique = new Set(all);
  assert.equal(unique.size, all.length, 'duplicate criterion id detected');
  // And CRITERION_IDS agrees with the flattened list.
  assert.equal(CRITERION_IDS.size, all.length);
});

test('every stage id is unique', () => {
  const ids = FORECAST_STAGES.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every stage has a non-empty name, bucket, numeric probability, and criteria', () => {
  for (const stage of FORECAST_STAGES) {
    assert.ok(stage.name && typeof stage.name === 'string', `${stage.id} name`);
    assert.ok(stage.bucket && typeof stage.bucket === 'string', `${stage.id} bucket`);
    assert.equal(typeof stage.probability, 'number', `${stage.id} probability`);
    assert.ok(stage.probability >= 0 && stage.probability <= 100, `${stage.id} probability range`);
    assert.ok(Array.isArray(stage.criteria) && stage.criteria.length > 0, `${stage.id} criteria`);
    for (const c of stage.criteria) {
      assert.ok(c.id && typeof c.id === 'string', `${stage.id} criterion id`);
      assert.ok(c.label && typeof c.label === 'string', `${stage.id} criterion label`);
    }
  }
});

test('probabilities follow the whiteboard (0/0/10/25/50/75/90)', () => {
  assert.deepEqual(FORECAST_STAGES.map(s => s.probability), [0, 0, 10, 25, 50, 75, 90]);
});

test('buckets follow the whiteboard', () => {
  assert.deepEqual(FORECAST_STAGES.map(s => s.bucket), [
    'Demand Gen', 'Demand Gen', 'Pipeline', 'Pipeline',
    'Best Case', 'Best Case', 'Commit',
  ]);
});

test('mapLegacyStage() covers all six legacy stages with valid forecast ids', () => {
  assert.equal(LEGACY_STAGES.length, 6);
  for (const legacy of LEGACY_STAGES) {
    const mapped = mapLegacyStage(legacy);
    assert.ok(mapped, `${legacy} should map to something`);
    assert.ok(getStageById(mapped), `${legacy} → ${mapped} must be a real forecast stage`);
  }
});

test('mapLegacyStage() is case-insensitive and returns "" for unknowns', () => {
  assert.equal(mapLegacyStage('prospect'), mapLegacyStage('Prospect'));
  assert.equal(mapLegacyStage('PROSPECT'), 'identification');
  assert.equal(mapLegacyStage('Nonexistent'), '');
  assert.equal(mapLegacyStage(''), '');
  assert.equal(mapLegacyStage(null), '');
  assert.equal(mapLegacyStage(undefined), '');
});

test('getStageById / getStageIndex behave', () => {
  assert.equal(getStageById('identification').name, 'Identification');
  assert.equal(getStageById('nope'), null);
  assert.equal(getStageIndex('inside_sales_working'), 1);
  assert.equal(getStageIndex('closing'), 7);
  assert.equal(getStageIndex('nope'), -1);
});

test('CRITERION_TO_STAGE maps every criterion back to its owning stage', () => {
  for (const stage of FORECAST_STAGES) {
    for (const c of stage.criteria) {
      assert.equal(CRITERION_TO_STAGE[c.id], stage.id);
    }
  }
});

test('getBucketForStageId / getProbabilityForStageId', () => {
  assert.equal(getBucketForStageId('identification'), 'Pipeline');
  assert.equal(getProbabilityForStageId('identification'), 10);
  assert.equal(getProbabilityForStageId('inside_sales_working'), 0);
  assert.equal(getBucketForStageId('nope'), '');
  assert.equal(getProbabilityForStageId('nope'), null);
});

// ── Forecast position: substantially-reached derivation ──────────────

test('SUBSTANTIAL_STAGE_RATIO is the documented half threshold', () => {
  assert.equal(SUBSTANTIAL_STAGE_RATIO, 0.5);
});

test('isStageSubstantial: complete, majority-met, minority, and empty', () => {
  // qualification has 4 criteria: 2/4 = 0.5 → substantial; 1/4 → not.
  const board = deriveForecastBoard(forecastWith({ qualification: 2, development: 1 }));
  const qual = board.stages[getStageIndex('qualification') - 1];
  const dev  = board.stages[getStageIndex('development') - 1];
  assert.equal(isStageSubstantial(qual), true, '2 of 4 met is substantial');
  assert.equal(isStageSubstantial(dev), false, '1 of 3 met is not substantial');

  // A fully-complete stage is always substantial.
  const full = deriveForecastBoard(forecastWith({ identification: 4 }));
  assert.equal(isStageSubstantial(full.stages[getStageIndex('identification') - 1]), true);

  assert.equal(isStageSubstantial(null), false);
  assert.equal(isStageSubstantial({ criteria: [], metCount: 0 }), false);
});

test('deriveForecastBoard exposes forecastIndex = furthest substantial stage', () => {
  // The GreenShield case: Identification fully done, Qualification 3/4,
  // Development 2/3, Proposal 1/3. currentIndex lags at Identification but the
  // deal has substantially reached Development.
  const board = deriveForecastBoard(forecastWith({
    inside_sales_working: 3, sal: 3, identification: 4, qualification: 3, development: 2, proposal: 1,
  }));
  assert.equal(board.currentIndex, getStageIndex('identification') - 1, 'furthest fully-complete');
  assert.equal(board.forecastIndex, getStageIndex('development') - 1, 'furthest substantial');
  assert.equal(board.workingIndex, getStageIndex('proposal') - 1, 'furthest with any progress');
});

test('resolveForecastPosition: analyzed position always reports a probability', () => {
  const board = deriveForecastBoard(forecastWith({
    identification: 4, qualification: 3, development: 2,
  }));
  const pos = resolveForecastPosition(board);
  assert.equal(pos.source, 'analyzed');
  assert.equal(pos.def.id, 'development');
  assert.equal(pos.bucket, 'Best Case');
  assert.equal(pos.probability, 50);           // never collapses to "—"
  assert.equal(pos.complete, false);           // development not fully met
  assert.equal(pos.inProgress, true);
});

test('resolveForecastPosition: a manual override wins over the analysis', () => {
  const board = deriveForecastBoard(forecastWith({ identification: 4, qualification: 3 }));
  const pos = resolveForecastPosition(board, 'proposal');
  assert.equal(pos.source, 'override');
  assert.equal(pos.def.id, 'proposal');
  assert.equal(pos.probability, 75);
});

test('resolveForecastPosition: an unknown override id falls back to the analysis', () => {
  const board = deriveForecastBoard(forecastWith({ identification: 4 }));
  const pos = resolveForecastPosition(board, 'not_a_stage');
  assert.equal(pos.source, 'analyzed');
  assert.equal(pos.def.id, 'identification');
});

test('resolveForecastPosition: nothing cleared → none / 0%', () => {
  const board = deriveForecastBoard(forecastWith({}));
  const pos = resolveForecastPosition(board);
  assert.equal(pos.source, 'none');
  assert.equal(pos.def, null);
  assert.equal(pos.probability, 0);
});

test('compareToCrmStage: flags ahead / behind / same / unknown', () => {
  const dev = getStageIndex('development') - 1;
  // CRM has it in "Qualified" (→ qualification), analysis says Development.
  const ahead = compareToCrmStage(dev, 'Qualified');
  assert.equal(ahead.differs, true);
  assert.equal(ahead.direction, 'ahead');
  assert.equal(ahead.crmStageId, 'qualification');

  // CRM in "Proposal", analysis only at Identification → behind.
  const behind = compareToCrmStage(getStageIndex('identification') - 1, 'Proposal');
  assert.equal(behind.differs, true);
  assert.equal(behind.direction, 'behind');

  // Same stage → no difference flagged.
  const same = compareToCrmStage(getStageIndex('qualification') - 1, 'Qualified');
  assert.equal(same.differs, false);
  assert.equal(same.direction, 'same');

  // Blank CRM stage or no analyzed position → unknown, never flagged.
  assert.equal(compareToCrmStage(dev, '').direction, 'unknown');
  assert.equal(compareToCrmStage(-1, 'Qualified').direction, 'unknown');
});

test('buying-process bands reference valid, ordered stage spans', () => {
  assert.equal(BUYING_PROCESS_BANDS.length, 3);
  for (const band of BUYING_PROCESS_BANDS) {
    assert.ok(band.id && band.label, 'band id + label');
    assert.ok(band.startStage >= 1 && band.startStage <= 7, `${band.id} start`);
    assert.ok(band.endStage >= band.startStage && band.endStage <= 7, `${band.id} end`);
    assert.ok(Array.isArray(band.points) && band.points.length > 0, `${band.id} points`);
  }
  assert.deepEqual(BUYING_PROCESS_BANDS.map(b => b.label), ['Why Change', 'Why Now', 'Why Recast']);
});
