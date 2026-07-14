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
} from '../js/utils/forecast-stages.js';

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
