// Tests for the forecast JSON parser (js/utils/forecast-schema.js).
// Exercises the same happy/sad paths as timeline-pdf-schema, plus the
// anti-hallucination guards that make the Forecast tab trustworthy:
// unknown ids dropped, invalid statuses coerced, and "met" without
// traceable evidence downgraded to "no_evidence".
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseForecastJsonResponse, FORECAST_SCHEMA_EXAMPLE } from '../js/utils/forecast-schema.js';

// A minimal, valid forecast object built from real ids.
function validForecast(overrides = {}) {
  return {
    opportunity_id: 'opp_001',
    customer_name: 'TechCorp Industries',
    current_stage_id: 'identification',
    current_stage_confidence: 'medium',
    forecast_bucket: 'WRONG — should be overwritten',
    probability: 999,
    summary: 'Deal is in early discovery.',
    stages: [
      {
        stage_id: 'inside_sales_working',
        status: 'complete',
        notes: 'Initial outreach happened.',
        criteria: [
          {
            criterion_id: 'icp_match',
            status: 'met',
            evidence: 'Confirmed 500-seat enterprise, IT director is the buyer.',
            source_date: '2026-03-01',
            source_id: 'dsc_1',
          },
        ],
      },
    ],
    gaps: ['Need decision criteria', ''],
    open_questions: ['Who signs off on budget?'],
    ...overrides,
  };
}

test('FORECAST_SCHEMA_EXAMPLE is a non-empty string mentioning the key fields', () => {
  assert.equal(typeof FORECAST_SCHEMA_EXAMPLE, 'string');
  assert.ok(FORECAST_SCHEMA_EXAMPLE.includes('current_stage_id'));
  assert.ok(FORECAST_SCHEMA_EXAMPLE.includes('criterion_id'));
  assert.ok(FORECAST_SCHEMA_EXAMPLE.includes('no_evidence'));
});

test('parses a plain valid JSON object', () => {
  const out = parseForecastJsonResponse(JSON.stringify(validForecast()));
  assert.equal(out.opportunity_id, 'opp_001');
  assert.equal(out.customer_name, 'TechCorp Industries');
  assert.equal(out.current_stage_id, 'identification');
  assert.equal(out.stages.length, 1);
  assert.equal(out.stages[0].criteria[0].status, 'met');
});

test('parses JSON wrapped in ```json fences', () => {
  const fenced = '```json\n' + JSON.stringify(validForecast()) + '\n```';
  const out = parseForecastJsonResponse(fenced);
  assert.equal(out.current_stage_id, 'identification');
});

test('parses JSON surrounded by prose', () => {
  const prose = `Sure! Here is the forecast:\n\n${JSON.stringify(validForecast())}\n\nLet me know if you need changes.`;
  const out = parseForecastJsonResponse(prose);
  assert.equal(out.opportunity_id, 'opp_001');
});

test('empty / whitespace response throws FORECAST_JSON_EMPTY', () => {
  assert.throws(() => parseForecastJsonResponse(''), (e) => e.code === 'FORECAST_JSON_EMPTY');
  assert.throws(() => parseForecastJsonResponse('   '), (e) => e.code === 'FORECAST_JSON_EMPTY');
  assert.throws(() => parseForecastJsonResponse(null), (e) => e.code === 'FORECAST_JSON_EMPTY');
});

test('malformed JSON throws FORECAST_JSON_INVALID', () => {
  assert.throws(
    () => parseForecastJsonResponse('{ "current_stage_id": "identification", '),
    (e) => e.code === 'FORECAST_JSON_INVALID',
  );
});

test('a JSON array (not an object) throws FORECAST_JSON_SCHEMA', () => {
  assert.throws(() => parseForecastJsonResponse('[1, 2, 3]'), (e) => e.code === 'FORECAST_JSON_SCHEMA');
});

test('forecast_bucket and probability are derived from current_stage_id, not the model', () => {
  const out = parseForecastJsonResponse(JSON.stringify(validForecast()));
  // Model sent bucket "WRONG" and probability 999; parser overwrites both.
  assert.equal(out.forecast_bucket, 'Pipeline');
  assert.equal(out.probability, 10);
});

test('unknown current_stage_id collapses to "" with empty bucket / null probability', () => {
  const out = parseForecastJsonResponse(JSON.stringify(validForecast({ current_stage_id: 'made_up_stage' })));
  assert.equal(out.current_stage_id, '');
  assert.equal(out.forecast_bucket, '');
  assert.equal(out.probability, null);
});

test('invalid confidence coerces to "low"', () => {
  const out = parseForecastJsonResponse(JSON.stringify(validForecast({ current_stage_confidence: 'certain' })));
  assert.equal(out.current_stage_confidence, 'low');
});

test('unknown criterion ids are dropped', () => {
  const f = validForecast();
  f.stages[0].criteria.push({ criterion_id: 'totally_invented', status: 'met', evidence: 'x', source_date: '2026-01-01' });
  const out = parseForecastJsonResponse(JSON.stringify(f));
  const ids = out.stages[0].criteria.map(c => c.criterion_id);
  assert.ok(!ids.includes('totally_invented'));
  assert.ok(ids.includes('icp_match'));
});

test('a criterion filed under the wrong stage is dropped', () => {
  const f = validForecast();
  // legal_complete belongs to the "proposal" stage, not inside_sales_working.
  f.stages[0].criteria.push({ criterion_id: 'legal_complete', status: 'met', evidence: 'Legal done', source_date: '2026-02-01' });
  const out = parseForecastJsonResponse(JSON.stringify(f));
  const ids = out.stages[0].criteria.map(c => c.criterion_id);
  assert.ok(!ids.includes('legal_complete'));
});

test('unknown stage ids are dropped', () => {
  const f = validForecast();
  f.stages.push({ stage_id: 'ghost_stage', status: 'complete', notes: '', criteria: [] });
  const out = parseForecastJsonResponse(JSON.stringify(f));
  assert.ok(!out.stages.some(s => s.stage_id === 'ghost_stage'));
});

test('invalid stage/criterion statuses coerce to safe defaults', () => {
  const f = validForecast();
  f.stages[0].status = 'halfway';
  f.stages[0].criteria[0].status = 'probably';
  const out = parseForecastJsonResponse(JSON.stringify(f));
  assert.equal(out.stages[0].status, 'not_started');
  assert.equal(out.stages[0].criteria[0].status, 'no_evidence');
});

test('"met" with an empty evidence string is downgraded to "no_evidence"', () => {
  const f = validForecast();
  f.stages[0].criteria[0] = { criterion_id: 'icp_match', status: 'met', evidence: '', source_date: '2026-03-01', source_id: 'dsc_1' };
  const out = parseForecastJsonResponse(JSON.stringify(f));
  assert.equal(out.stages[0].criteria[0].status, 'no_evidence');
  assert.equal(out.stages[0].criteria[0].evidence, '');
  assert.equal(out.stages[0].criteria[0].source_id, '');
});

test('"met" with evidence but no anchor (no id, no date) is downgraded', () => {
  const f = validForecast();
  f.stages[0].criteria[0] = { criterion_id: 'icp_match', status: 'met', evidence: 'They looked ready.', source_date: '', source_id: '' };
  const out = parseForecastJsonResponse(JSON.stringify(f));
  assert.equal(out.stages[0].criteria[0].status, 'no_evidence');
});

test('"met" with evidence + a source date survives as "met"', () => {
  const f = validForecast();
  f.stages[0].criteria[0] = { criterion_id: 'icp_match', status: 'met', evidence: 'Confirmed ICP fit.', source_date: '2026-03-01', source_id: '' };
  const out = parseForecastJsonResponse(JSON.stringify(f));
  assert.equal(out.stages[0].criteria[0].status, 'met');
  assert.equal(out.stages[0].criteria[0].evidence, 'Confirmed ICP fit.');
});

test('"partial" is held to the same evidence bar as "met"', () => {
  const f = validForecast();
  f.stages[0].criteria[0] = { criterion_id: 'icp_match', status: 'partial', evidence: '', source_date: '2026-03-01' };
  const out = parseForecastJsonResponse(JSON.stringify(f));
  assert.equal(out.stages[0].criteria[0].status, 'no_evidence');
});

test('a bogus source_id is cleared when validSourceIds is supplied, and downgrades an otherwise-unanchored claim', () => {
  const f = validForecast();
  // Evidence cites dsc_999 which is not a real note, and there is no date.
  f.stages[0].criteria[0] = { criterion_id: 'icp_match', status: 'met', evidence: 'Buyer confirmed.', source_date: '', source_id: 'dsc_999' };
  const out = parseForecastJsonResponse(JSON.stringify(f), { validSourceIds: ['dsc_1', 'dsc_2'] });
  assert.equal(out.stages[0].criteria[0].source_id, '');
  assert.equal(out.stages[0].criteria[0].status, 'no_evidence');
});

test('a real source_id passes validSourceIds and stays "met"', () => {
  const f = validForecast();
  f.stages[0].criteria[0] = { criterion_id: 'icp_match', status: 'met', evidence: 'Buyer confirmed.', source_date: '', source_id: 'dsc_1' };
  const out = parseForecastJsonResponse(JSON.stringify(f), { validSourceIds: ['dsc_1', 'dsc_2'] });
  assert.equal(out.stages[0].criteria[0].source_id, 'dsc_1');
  assert.equal(out.stages[0].criteria[0].status, 'met');
});

test('"not_met" and "no_evidence" carry no evidence payload', () => {
  const f = validForecast();
  f.stages[0].criteria = [
    { criterion_id: 'icp_match', status: 'not_met', evidence: 'should be cleared', source_date: '2026-01-01', source_id: 'dsc_1' },
    { criterion_id: 'pain_validated', status: 'no_evidence', evidence: 'should be cleared', source_date: '2026-01-01', source_id: 'dsc_1' },
  ];
  const out = parseForecastJsonResponse(JSON.stringify(f));
  for (const c of out.stages[0].criteria) {
    assert.equal(c.evidence, '');
    assert.equal(c.source_date, '');
    assert.equal(c.source_id, '');
  }
});

test('duplicate stage and criterion entries are de-duplicated (first wins)', () => {
  const f = validForecast();
  f.stages.push({ stage_id: 'inside_sales_working', status: 'not_started', notes: 'dup', criteria: [] });
  f.stages[0].criteria.push({ criterion_id: 'icp_match', status: 'not_met', evidence: '', source_date: '' });
  const out = parseForecastJsonResponse(JSON.stringify(f));
  assert.equal(out.stages.filter(s => s.stage_id === 'inside_sales_working').length, 1);
  assert.equal(out.stages[0].criteria.filter(c => c.criterion_id === 'icp_match').length, 1);
  // First one wins → still "met".
  assert.equal(out.stages[0].criteria[0].status, 'met');
});

test('gaps and open_questions are string arrays with empties filtered out', () => {
  const out = parseForecastJsonResponse(JSON.stringify(validForecast()));
  assert.deepEqual(out.gaps, ['Need decision criteria']);
  assert.deepEqual(out.open_questions, ['Who signs off on budget?']);
});

test('missing arrays default to empty, not undefined', () => {
  const out = parseForecastJsonResponse(JSON.stringify({ current_stage_id: 'sal' }));
  assert.deepEqual(out.stages, []);
  assert.deepEqual(out.gaps, []);
  assert.deepEqual(out.open_questions, []);
  assert.equal(out.current_stage_id, 'sal');
  assert.equal(out.probability, 0);
});
