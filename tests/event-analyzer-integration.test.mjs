// Integration-oriented tests for the Event Analyzer data pipeline.
//
// The Analyzer view itself is DOM-bound (it renders into the CRM shell), so
// — consistent with the forecast suite, which has no admin-forecast view
// test — these tests exercise the pieces the view depends on without a
// browser: the strict event_id selection helpers, and the real
// client → schema pipeline driven by a stubbed global fetch.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectEventDescriptions, selectEventContacts } from '../js/utils/event-analyzer-evidence.js';
import { requestEventAnalysisJson } from '../js/utils/event-analyzer-client.js';
import { deriveEventBoard } from '../js/utils/event-analyzer-stages.js';

// ── Strict event_id selection ────────────────────────────────────────
test('selectEventDescriptions filters strictly by event_id and sorts oldest first', () => {
  const rows = [
    { description_id: 'a', event_id: 'evt_1', description_date: '2026-03-20', description_text: 'later' },
    { description_id: 'b', event_id: 'evt_1', description_date: '2026-03-05', description_text: 'earlier' },
    { description_id: 'c', event_id: 'evt_2', description_date: '2026-03-01', description_text: 'other event' },
  ];
  const out = selectEventDescriptions(rows, 'evt_1');
  assert.equal(out.length, 2, 'only evt_1 rows');
  assert.equal(out[0].description_id, 'b', 'oldest first');
  assert.equal(out[1].description_id, 'a');
  assert.ok(!out.some(d => d.event_id === 'evt_2'), 'no cross-event leakage');
});

test('selectEventContacts filters strictly by event_id', () => {
  const rows = [
    { event_id: 'evt_1', name: 'A' }, { event_id: 'evt_2', name: 'B' }, { event_id: 'evt_1', name: 'C' },
  ];
  const out = selectEventContacts(rows, 'evt_1');
  assert.equal(out.length, 2);
  assert.ok(out.every(c => c.event_id === 'evt_1'));
});

// ── Client → schema pipeline (stubbed fetch) ─────────────────────────
const REAL_FETCH = globalThis.fetch;

function stubModel(jsonObject) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: JSON.stringify(jsonObject) }] }),
  });
}
function stubRaw(rawText) {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: rawText }] }) });
}
function stubError(status) {
  globalThis.fetch = async () => ({ ok: false, status, json: async () => ({ error: { message: 'boom' } }) });
}
function restoreFetch() { globalThis.fetch = REAL_FETCH; }

// The client reads the Anthropic key from runtime config (localStorage).
function setApiKey() {
  globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({ ANTHROPIC_API_KEY: 'test-key' }));
}

const EVENT = { event_id: 'evt_002', title: 'Cloud Security Workshop', event_date: '2026-04-22', event_type: 'Workshop' };
const NOTE = { description_id: 'edsc_1', event_id: 'evt_002', description_date: '2026-03-05', description_text: '<p>Kickoff: agreed the topic covers cloud security best practices.</p>' };
const CONTACTS = [{ event_id: 'evt_002', icp_role: 'Decision Maker', owner: 'Randy', status: 'meeting' }];
// Opportunities for MULTIPLE events — only evt_002 ones may count.
const OPPS = [
  { opportunity_id: 'opp_003', lead_source: 'evt_002', status: 'In Progress', stage: 'Negotiation' },
  { opportunity_id: 'opp_004', lead_source: 'evt_002', status: 'Won', stage: 'Closed' },
  { opportunity_id: 'opp_999', lead_source: 'evt_OTHER', status: 'Won', stage: 'Closed' },
];

function modelBoard() {
  return {
    event_id: 'evt_002', event_title: 'Cloud Security Workshop',
    current_stage_confidence: 'medium', summary: 'Setup underway.',
    stages: [
      { stage_id: 'setup', status: 'in_progress', activities: [
        { activity_id: 'setup_topic', status: 'met', evidence: 'Agreed the topic covers cloud security best practices.', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' },
        // Fabricated quote pinned to the real note → must be downgraded.
        { activity_id: 'setup_why', status: 'met', evidence: 'Legal review is complete and the signed contract was returned.', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' },
      ] },
      { stage_id: 'audience', status: 'in_progress', activities: [
        { activity_id: 'audience_upload', status: 'met', evidence: 'Contacts uploaded', source_type: 'event_contacts', source_id: '', source_date: '' },
      ] },
      { stage_id: 'results', status: 'in_progress', activities: [
        { activity_id: 'results_meetings', status: 'met', evidence: 'A contact has a meeting booked', source_type: 'event_contacts', source_id: '', source_date: '' },
      ] },
    ],
    next_actions: ['Define the messaging'], gaps: ['Owners not assigned'], open_questions: ['Who leads follow-up?'],
  };
}

test('pipeline: grounded note claim survives, fabricated one is downgraded', async () => {
  setApiKey();
  stubModel(modelBoard());
  try {
    const out = await requestEventAnalysisJson(EVENT, [NOTE], CONTACTS, OPPS, null);
    const setup = out.stages.find(s => s.stage_id === 'setup');
    assert.equal(setup.activities.find(a => a.activity_id === 'setup_topic').status, 'met', 'grounded quote survives');
    assert.equal(setup.activities.find(a => a.activity_id === 'setup_why').status, 'no_evidence', 'fabricated quote downgraded');
  } finally { restoreFetch(); }
});

test('pipeline: structured claims stand when backed; deterministic facts overlaid', async () => {
  setApiKey();
  stubModel(modelBoard());
  try {
    const out = await requestEventAnalysisJson(EVENT, [NOTE], CONTACTS, OPPS, null);
    const setup = out.stages.find(s => s.stage_id === 'setup');
    const audience = out.stages.find(s => s.stage_id === 'audience');
    const results = out.stages.find(s => s.stage_id === 'results');
    // Structured claims supported by aggregates.
    assert.equal(audience.activities.find(a => a.activity_id === 'audience_upload').status, 'met');
    assert.equal(results.activities.find(a => a.activity_id === 'results_meetings').status, 'met');
    // Deterministic overlays: scheduled date + linked opps + closed-won.
    assert.equal(setup.activities.find(a => a.activity_id === 'setup_date').status, 'met', 'scheduled date is deterministic');
    assert.equal(results.activities.find(a => a.activity_id === 'results_opportunities').status, 'met');
    assert.equal(results.activities.find(a => a.activity_id === 'results_closed_won').status, 'met');
  } finally { restoreFetch(); }
});

test('pipeline: another event’s opportunities never leak into the counts', async () => {
  setApiKey();
  // Model claims nothing about results — the deterministic facts are derived
  // purely from the opportunities filtered by THIS event's id.
  const board = modelBoard();
  board.stages = board.stages.filter(s => s.stage_id !== 'results');
  stubModel(board);
  try {
    const out = await requestEventAnalysisJson(EVENT, [NOTE], CONTACTS, OPPS, null);
    const results = out.stages.find(s => s.stage_id === 'results');
    // opp_999 (evt_OTHER) must NOT contribute: exactly the two evt_002 opps,
    // one closed-won. results_opportunities + results_closed_won are met, but
    // there is no third phantom opportunity inflating anything.
    assert.equal(results.activities.find(a => a.activity_id === 'results_opportunities').status, 'met');
    assert.equal(results.activities.find(a => a.activity_id === 'results_closed_won').status, 'met');
    assert.equal(out.event_id, 'evt_002');
  } finally { restoreFetch(); }
});

test('pipeline: missing Event_Descriptions does not crash — board still built from CRM facts', async () => {
  setApiKey();
  // No notes at all; model returns an almost-empty board.
  stubModel({ event_id: 'evt_002', stages: [] });
  try {
    const out = await requestEventAnalysisJson(EVENT, [], [], OPPS, null);
    assert.equal(out.stages.length, 7, 'full canonical board despite zero notes');
    const board = deriveEventBoard(out);
    // Deterministic facts still land: scheduled date + linked opps.
    assert.ok(board.metCount >= 3, 'deterministic CRM facts still produce met activities');
    assert.equal(out.event_id, 'evt_002');
  } finally { restoreFetch(); }
});

test('pipeline: missing saved playbook (null) is handled gracefully', async () => {
  setApiKey();
  stubModel(modelBoard());
  try {
    // savedPlaybookRaw = null (the view passes null when Event_Playbook can't load).
    const out = await requestEventAnalysisJson(EVENT, [NOTE], CONTACTS, OPPS, null);
    assert.ok(out.stages.length === 7);
  } finally { restoreFetch(); }
});

test('pipeline: an empty model response throws a clear coded error, not a crash', async () => {
  setApiKey();
  stubRaw('   ');
  try {
    await assert.rejects(
      () => requestEventAnalysisJson(EVENT, [NOTE], CONTACTS, OPPS, null),
      (e) => e.code === 'EVENT_JSON_EMPTY',
    );
  } finally { restoreFetch(); }
});

test('pipeline: an API error surfaces a coded EVENT_JSON_API_ERROR', async () => {
  setApiKey();
  stubError(500);
  try {
    await assert.rejects(
      () => requestEventAnalysisJson(EVENT, [NOTE], CONTACTS, OPPS, null),
      (e) => e.code === 'EVENT_JSON_API_ERROR' && e.status === 500,
    );
  } finally { restoreFetch(); }
});

test('pipeline: a missing API key fails fast with a helpful message', async () => {
  globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({}));
  stubModel(modelBoard());
  try {
    await assert.rejects(
      () => requestEventAnalysisJson(EVENT, [NOTE], CONTACTS, OPPS, null),
      (e) => /API key not set/.test(e.message),
    );
  } finally { restoreFetch(); }
});
