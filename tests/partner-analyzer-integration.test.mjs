// Integration-oriented tests for the Partner Analyzer data pipeline.
//
// The Analyzer view itself is DOM-bound (it renders into the CRM shell), so —
// consistent with the forecast/event suites — these tests exercise the pieces
// the view depends on without a browser: the real client → schema pipeline
// driven by a stubbed global fetch (strict partner scoping, grounding,
// deterministic overlays, cross-partner isolation, error handling), plus the
// typed background-job key that keeps a stale Partner-A result from landing on
// Partner B.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requestPartnerAnalysisJson, preparePartnerAnalysis } from '../js/utils/partner-analyzer-client.js';
import { derivePartnerBoard } from '../js/utils/partner-analyzer-stages.js';
import { makeJobKey, sameJobKey } from '../js/utils/analyzer-job-key.js';

const TODAY = '2026-07-21';

const PARTNER_A = { partner_id: 'p1', display_name: 'Nerdio', partner_type: 'Technology', tier: 'Premier/Strategic', region: 'North America', hq_location: 'Chicago', status: 'active', created_at: '2026-01-15' };
const PARTNER_B = { partner_id: 'p2', display_name: 'Elantis', partner_type: 'MSP/SI', tier: 'Value/Preferred', region: 'North America', hq_location: 'Edmonton', status: 'active', created_at: '2026-02-01' };

const TRANSCRIPTS = [
  { transcript_id: 't1', partner_id: 'p1', conversation_date: '2026-06-10', transcript_text: '<p>We aligned on shared goals and priorities for the AVD rollout this year.</p>' },
  { transcript_id: 't9', partner_id: 'p2', conversation_date: '2026-06-01', transcript_text: '<p>Elantis private note.</p>' },
];
const OPPS = [
  { opportunity_id: 'o1', partner_id: 'p1', deal_value: '150000', status: 'In Progress', stage: 'Proposal', expected_close: '2026-09-15', updated_at: '2026-06-25' },
  { opportunity_id: 'o2', partner_id: 'p1', deal_value: '75000', status: 'Won', stage: 'Closed' },
  { opportunity_id: 'o9', partner_id: 'p2', deal_value: '999999', status: 'Won', stage: 'Closed' },
];
const EVENTS = [
  { event_id: 'e1', partner_id: 'p1', title: 'Webinar', event_type: 'Webinar', event_date: '2026-05-20', status: 'Completed' },
  { event_id: 'e_un', partner_id: '', title: 'Open House', event_date: '2026-05-01', status: 'Completed' },
];

function commonArgs(partner) {
  return {
    partner,
    transcripts: TRANSCRIPTS, meetings: [], documents: [],
    opportunities: OPPS, opportunityDescriptions: [],
    events: EVENTS, eventDescriptions: [], eventContacts: [],
    savedPlaybookRows: [], today: TODAY,
  };
}

// The model board Claude "returns".
function modelBoard() {
  return {
    partner_id: 'p1', partner_name: 'Nerdio', confidence: 'medium', summary: 'Progressing.',
    operational_stage_id: 'revenue_growth', furthest_demonstrated_stage_id: 'revenue_growth',
    stages: [
      { stage_id: 'relationship_alignment', status: 'in_progress', criteria: [
        // Grounded quote → survives.
        { criterion_id: 'goals_priorities_aligned', status: 'met', evidence: 'Aligned on shared goals and priorities for the rollout.', source_type: 'transcript', source_id: 't1', source_date: '2026-06-10', related_entity_id: 'p1' },
      ] },
      { stage_id: 'revenue_growth', status: 'in_progress', criteria: [
        // Fabricated quote pinned to a real transcript → downgraded.
        { criterion_id: 'growth_plan', status: 'met', evidence: 'A signed three-year expansion contract worth ten million dollars was executed.', source_type: 'transcript', source_id: 't1', source_date: '2026-06-10', related_entity_id: 'p1' },
      ] },
    ],
    next_actions: ['Book enablement'], gaps: ['No GTM plan'], open_questions: ['Who owns GTM?'], risks: [], momentum: ['Won a deal'],
  };
}

// ── fetch stubs ──────────────────────────────────────────────────────
const REAL_FETCH = globalThis.fetch;
function stubModel(obj) { globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }) }); }
function stubRaw(raw) { globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: raw }] }) }); }
function stubError(status) { globalThis.fetch = async () => ({ ok: false, status, json: async () => ({ error: { message: 'boom' } }) }); }
function restoreFetch() { globalThis.fetch = REAL_FETCH; }
function setApiKey() { globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({ ANTHROPIC_API_KEY: 'test-key' })); }

// ── preparePartnerAnalysis (pure scoping — no network) ───────────────
test('preparePartnerAnalysis scopes strictly and computes KPIs + health', () => {
  const prep = preparePartnerAnalysis(commonArgs(PARTNER_A));
  assert.equal(prep.kpis.totalOpps, 2, 'only p1 opps (o9 excluded)');
  assert.equal(prep.kpis.wonRevenue, 75000, 'p2 999999 win never leaks');
  assert.equal(prep.scoped.events.length, 1, 'unassigned event excluded');
  assert.equal(prep.scoped.events[0].event_id, 'e1');
  assert.ok(prep.health && prep.health.label, 'health derived deterministically');
  // Anchors only carry p1's transcript.
  assert.ok(prep.anchors.narrativeIds.has('t1') && !prep.anchors.narrativeIds.has('t9'));
});

// ── Full client pipeline ─────────────────────────────────────────────
test('pipeline: grounded claim survives, fabricated one is downgraded, facts overlaid', async () => {
  setApiKey(); stubModel(modelBoard());
  try {
    const { analysis, kpis, health, coverage } = await requestPartnerAnalysisJson(commonArgs(PARTNER_A));
    const rel = analysis.stages.find(s => s.stage_id === 'relationship_alignment');
    const rev = analysis.stages.find(s => s.stage_id === 'revenue_growth');
    assert.equal(rel.criteria.find(c => c.criterion_id === 'goals_priorities_aligned').status, 'met', 'grounded quote survives');
    assert.equal(rev.criteria.find(c => c.criterion_id === 'growth_plan').status, 'no_evidence', 'fabricated quote downgraded');
    // Deterministic overlays: opps created, active pipeline, revenue won.
    const pipe = analysis.stages.find(s => s.stage_id === 'pipeline_execution');
    assert.equal(pipe.criteria.find(c => c.criterion_id === 'opportunities_created').status, 'met');
    assert.equal(pipe.criteria.find(c => c.criterion_id === 'active_pipeline').status, 'met');
    assert.equal(rev.criteria.find(c => c.criterion_id === 'revenue_won').status, 'met');
    // KPIs + health returned for the view; board is derivable.
    assert.equal(kpis.wonRevenue, 75000);
    assert.ok(health.label);
    assert.ok(!coverage.hasOmissions);
    assert.equal(analysis.partner_id, 'p1');
    assert.equal(derivePartnerBoard(analysis).stages.length, 7);
  } finally { restoreFetch(); }
});

test('pipeline: another partner’s won revenue never inflates the counts', async () => {
  setApiKey(); stubModel(modelBoard());
  try {
    const { kpis } = await requestPartnerAnalysisJson(commonArgs(PARTNER_A));
    assert.equal(kpis.wonRevenue, 75000, 'o9 (p2, $999,999) excluded');
    assert.equal(kpis.totalOpps, 2);
  } finally { restoreFetch(); }
});

test('pipeline: partner with no evidence still yields a full 7×3 board from CRM facts', async () => {
  setApiKey(); stubModel({ partner_id: 'p2', stages: [] });
  try {
    const { analysis } = await requestPartnerAnalysisJson({ ...commonArgs(PARTNER_B), transcripts: TRANSCRIPTS });
    assert.equal(analysis.stages.length, 7);
    // p2 has one Won opp → revenue_won + opportunities_created land deterministically.
    const rev = analysis.stages.find(s => s.stage_id === 'revenue_growth');
    assert.equal(rev.criteria.find(c => c.criterion_id === 'revenue_won').status, 'met');
    assert.equal(analysis.partner_id, 'p2');
  } finally { restoreFetch(); }
});

test('pipeline: empty / API-error / missing-key are handled with coded errors', async () => {
  setApiKey(); stubRaw('   ');
  try {
    await assert.rejects(() => requestPartnerAnalysisJson(commonArgs(PARTNER_A)), e => e.code === 'PARTNER_JSON_EMPTY');
  } finally { restoreFetch(); }

  setApiKey(); stubError(500);
  try {
    await assert.rejects(() => requestPartnerAnalysisJson(commonArgs(PARTNER_A)), e => e.code === 'PARTNER_JSON_API_ERROR' && e.status === 500);
  } finally { restoreFetch(); }

  globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({}));
  stubModel(modelBoard());
  try {
    await assert.rejects(() => requestPartnerAnalysisJson(commonArgs(PARTNER_A)), e => /API key not set/.test(e.message));
  } finally { restoreFetch(); }
});

// ── Background-job key: stale Partner A cannot land on Partner B ──────
test('job key: a stale Partner A response cannot apply under Partner B', () => {
  const runId = 'run-123';
  const active = makeJobKey('partner', 'p2', 'run-999'); // user now looking at Partner B
  const staleA = makeJobKey('partner', 'p1', runId);      // A's in-flight response
  assert.equal(sameJobKey(staleA, active), false, 'different partner → not applied');
});

test('job key: a superseding run of the SAME partner supersedes the older one', () => {
  const older = makeJobKey('partner', 'p1', 'run-1');
  const newer = makeJobKey('partner', 'p1', 'run-2');
  assert.equal(sameJobKey(older, newer), false, 'different runId → older is stale');
  assert.equal(sameJobKey(newer, makeJobKey('partner', 'p1', 'run-2')), true, 'exact match applies');
});

test('job key: one mode’s result never matches another mode’s job', () => {
  assert.equal(sameJobKey(makeJobKey('partner', 'x', 'r'), makeJobKey('event', 'x', 'r')), false);
  assert.equal(sameJobKey(makeJobKey('opportunity', 'x', 'r'), makeJobKey('partner', 'x', 'r')), false);
});
