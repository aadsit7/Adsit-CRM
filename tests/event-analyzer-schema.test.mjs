// Tests for the event-analysis JSON parser (js/utils/event-analyzer-schema.js).
// Mirrors forecast-schema's guards, adapted to the event lifecycle's five
// source types: note grounding for event_description, deterministic
// validation for structured facts, and manual-confirmation validation for
// saved_playbook. Stage status + current position are always recomputed.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEventAnalysisResponse, EVENT_ANALYZER_SCHEMA_EXAMPLE } from '../js/utils/event-analyzer-schema.js';

// A minimal, valid analysis built from real ids. One note-backed met in the
// Event stage; everything else defaults to no_evidence.
function validAnalysis(overrides = {}) {
  return {
    event_id: 'evt_002',
    event_title: 'Cloud Security Workshop',
    current_stage_id: 'audience',
    current_stage_confidence: 'medium',
    summary: 'Setup is underway; audience work has begun.',
    stages: [
      {
        stage_id: 'setup',
        status: 'in_progress',
        notes: 'Topic agreed on the kickoff call.',
        activities: [
          {
            activity_id: 'setup_topic',
            status: 'met',
            evidence: 'Kickoff call agreed the workshop will cover cloud security best practices.',
            source_type: 'event_description',
            source_id: 'edsc_1',
            source_date: '2026-03-05',
          },
        ],
      },
    ],
    next_actions: ['Upload the target account list', ''],
    gaps: ['No target accounts uploaded yet'],
    open_questions: ['Who owns the follow-up?'],
    ...overrides,
  };
}

const NOTE_TEXT = 'Kickoff call on Mar 5: the team agreed the workshop will cover cloud security best practices and target enterprise IT leaders.';

function anchorsFor(id = 'edsc_1', date = '2026-03-05') {
  return {
    validSourceIds: [id], validSourceDates: [date],
    sourceTextById: { [id]: NOTE_TEXT },
  };
}

// ── Basics / parsing ─────────────────────────────────────────────────
test('EVENT_ANALYZER_SCHEMA_EXAMPLE mentions the key fields and no probability', () => {
  assert.equal(typeof EVENT_ANALYZER_SCHEMA_EXAMPLE, 'string');
  assert.ok(EVENT_ANALYZER_SCHEMA_EXAMPLE.includes('activity_id'));
  assert.ok(EVENT_ANALYZER_SCHEMA_EXAMPLE.includes('source_type'));
  assert.ok(EVENT_ANALYZER_SCHEMA_EXAMPLE.includes('saved_playbook'));
  assert.ok(!/probability/i.test(EVENT_ANALYZER_SCHEMA_EXAMPLE), 'no sales probability in event schema');
  assert.ok(!/forecast_bucket/i.test(EVENT_ANALYZER_SCHEMA_EXAMPLE), 'no forecast bucket in event schema');
});

test('parses a plain valid JSON object into a canonical 7×3 board', () => {
  const out = parseEventAnalysisResponse(JSON.stringify(validAnalysis()), anchorsFor());
  assert.equal(out.event_id, 'evt_002');
  assert.equal(out.stages.length, 7);
  for (const s of out.stages) assert.equal(s.activities.length, 3);
  assert.equal(out.stages[0].activities[0].status, 'met');
});

test('parses JSON wrapped in ```json fences and in prose', () => {
  const fenced = '```json\n' + JSON.stringify(validAnalysis()) + '\n```';
  assert.equal(parseEventAnalysisResponse(fenced, anchorsFor()).event_id, 'evt_002');
  const prose = `Here you go:\n\n${JSON.stringify(validAnalysis())}\n\nHope that helps!`;
  assert.equal(parseEventAnalysisResponse(prose, anchorsFor()).event_id, 'evt_002');
});

test('empty / whitespace / null throws EVENT_JSON_EMPTY', () => {
  assert.throws(() => parseEventAnalysisResponse(''), (e) => e.code === 'EVENT_JSON_EMPTY');
  assert.throws(() => parseEventAnalysisResponse('   '), (e) => e.code === 'EVENT_JSON_EMPTY');
  assert.throws(() => parseEventAnalysisResponse(null), (e) => e.code === 'EVENT_JSON_EMPTY');
});

test('malformed JSON throws EVENT_JSON_INVALID; an array throws EVENT_JSON_SCHEMA', () => {
  assert.throws(() => parseEventAnalysisResponse('{ "event_id": "x", '), (e) => e.code === 'EVENT_JSON_INVALID');
  assert.throws(() => parseEventAnalysisResponse('[1,2,3]'), (e) => e.code === 'EVENT_JSON_SCHEMA');
});

test('a nearly-empty object yields a full no_evidence board (no crash)', () => {
  const out = parseEventAnalysisResponse(JSON.stringify({ event_id: 'evt_x' }));
  assert.equal(out.stages.length, 7);
  assert.equal(out.completion.met, 0);
  assert.equal(out.completion.total, 21);
  assert.equal(out.completion.pct, 0);
  assert.equal(out.current_stage_id, 'setup');
  assert.deepEqual(out.gaps, []);
  assert.deepEqual(out.next_actions, []);
});

// ── Dropping invented / mis-filed structure ──────────────────────────
test('invented stage ids are dropped', () => {
  const a = validAnalysis();
  a.stages.push({ stage_id: 'ghost_stage', status: 'complete', notes: 'x', activities: [
    { activity_id: 'setup_topic', status: 'met', evidence: 'y', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' },
  ] });
  const out = parseEventAnalysisResponse(JSON.stringify(a), anchorsFor());
  assert.ok(!out.stages.some(s => s.stage_id === 'ghost_stage'));
  assert.equal(out.stages.length, 7);
});

test('invented activity ids are dropped', () => {
  const a = validAnalysis();
  a.stages[0].activities.push({ activity_id: 'setup_invented', status: 'met', evidence: 'z', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' });
  const out = parseEventAnalysisResponse(JSON.stringify(a), anchorsFor());
  const setup = out.stages.find(s => s.stage_id === 'setup');
  assert.ok(!setup.activities.some(x => x.activity_id === 'setup_invented'));
});

test('an activity filed under the wrong stage is dropped', () => {
  const a = validAnalysis();
  // results_meetings belongs to the "results" stage, not "setup".
  a.stages[0].activities.push({ activity_id: 'results_meetings', status: 'met', evidence: 'Meetings booked', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' });
  const out = parseEventAnalysisResponse(JSON.stringify(a), anchorsFor());
  const results = out.stages.find(s => s.stage_id === 'results');
  // It must NOT have leaked in as met under results via the setup stage entry.
  assert.equal(results.activities.find(x => x.activity_id === 'results_meetings').status, 'no_evidence');
});

test('duplicate stages and activities are de-duplicated (first wins)', () => {
  const a = validAnalysis();
  a.stages.push({ stage_id: 'setup', status: 'not_started', notes: 'dup', activities: [
    { activity_id: 'setup_topic', status: 'not_met', evidence: '', source_type: 'none', source_id: '', source_date: '' },
  ] });
  const out = parseEventAnalysisResponse(JSON.stringify(a), anchorsFor());
  assert.equal(out.stages.filter(s => s.stage_id === 'setup').length, 1);
  // First (met) wins over the later duplicate (not_met).
  assert.equal(out.stages[0].activities[0].status, 'met');
});

test('invalid activity statuses coerce to no_evidence', () => {
  const a = validAnalysis();
  a.stages[0].activities[0] = { activity_id: 'setup_topic', status: 'probably', evidence: 'x', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' };
  const out = parseEventAnalysisResponse(JSON.stringify(a), anchorsFor());
  assert.equal(out.stages[0].activities[0].status, 'no_evidence');
});

// ── event_description: anchors + grounding ───────────────────────────
test('rejects a fabricated source_id, downgrading an otherwise-unanchored met', () => {
  const a = validAnalysis();
  a.stages[0].activities[0] = { activity_id: 'setup_topic', status: 'met', evidence: 'Topic agreed.', source_type: 'event_description', source_id: 'edsc_999', source_date: '' };
  const out = parseEventAnalysisResponse(JSON.stringify(a), { validSourceIds: ['edsc_1'], validSourceDates: ['2026-03-05'] });
  assert.equal(out.stages[0].activities[0].status, 'no_evidence');
  assert.equal(out.stages[0].activities[0].source_id, '');
});

test('rejects a fabricated source_date, downgrading an otherwise-unanchored met', () => {
  const a = validAnalysis();
  a.stages[0].activities[0] = { activity_id: 'setup_topic', status: 'met', evidence: 'Topic agreed on the call.', source_type: 'event_description', source_id: '', source_date: '1999-01-01' };
  const out = parseEventAnalysisResponse(JSON.stringify(a), { validSourceDates: ['2026-03-05'] });
  assert.equal(out.stages[0].activities[0].status, 'no_evidence');
});

test('rejects a fabricated quote pinned to a real note (grounding)', () => {
  const a = validAnalysis();
  a.stages[0].activities[0] = { activity_id: 'setup_topic', status: 'met', evidence: 'Legal review is complete and the contract was signed by counsel.', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' };
  const out = parseEventAnalysisResponse(JSON.stringify(a), anchorsFor());
  assert.equal(out.stages[0].activities[0].status, 'no_evidence');
});

test('accepts a grounded quote and a close paraphrase', () => {
  // Verbatim-ish quote.
  const a1 = validAnalysis();
  const out1 = parseEventAnalysisResponse(JSON.stringify(a1), anchorsFor());
  assert.equal(out1.stages[0].activities[0].status, 'met');

  // Close paraphrase: synonyms dropped, but workshop/cloud/security/best keep overlap.
  const a2 = validAnalysis();
  a2.stages[0].activities[0].evidence = 'The workshop will focus on cloud security best practices.';
  const out2 = parseEventAnalysisResponse(JSON.stringify(a2), anchorsFor());
  assert.equal(out2.stages[0].activities[0].status, 'met');
});

test('grounding is skipped when no source text is supplied (real anchor stays met)', () => {
  const a = validAnalysis();
  a.stages[0].activities[0].evidence = 'Unverifiable without text but well-anchored.';
  const out = parseEventAnalysisResponse(JSON.stringify(a), { validSourceIds: ['edsc_1'], validSourceDates: ['2026-03-05'] });
  assert.equal(out.stages[0].activities[0].status, 'met');
});

test('a met/partial with source_type none is downgraded (no source can back it)', () => {
  const a = validAnalysis();
  a.stages[0].activities[0] = { activity_id: 'setup_topic', status: 'partial', evidence: 'Seems underway', source_type: 'none', source_id: '', source_date: '' };
  const out = parseEventAnalysisResponse(JSON.stringify(a), anchorsFor());
  assert.equal(out.stages[0].activities[0].status, 'no_evidence');
});

// ── Structured deterministic sources ─────────────────────────────────
test('a structured claim is dropped when no supporting fact is supplied', () => {
  const a = validAnalysis({ stages: [{
    stage_id: 'audience', status: 'in_progress', notes: '',
    activities: [{ activity_id: 'audience_upload', status: 'met', evidence: '240 contacts uploaded', source_type: 'event_contacts', source_id: '', source_date: '' }],
  }] });
  // No structuredSupport → cannot trust the model's count claim.
  const out = parseEventAnalysisResponse(JSON.stringify(a), {});
  const audience = out.stages.find(s => s.stage_id === 'audience');
  assert.equal(audience.activities.find(x => x.activity_id === 'audience_upload').status, 'no_evidence');
});

test('a structured claim stands when the supporting fact is present', () => {
  const a = validAnalysis({ stages: [{
    stage_id: 'audience', status: 'in_progress', notes: '',
    activities: [{ activity_id: 'audience_upload', status: 'met', evidence: '240 contacts uploaded', source_type: 'event_contacts', source_id: '', source_date: '' }],
  }] });
  const out = parseEventAnalysisResponse(JSON.stringify(a), { facts: { structuredSupport: { audience_upload: true } } });
  const audience = out.stages.find(s => s.stage_id === 'audience');
  assert.equal(audience.activities.find(x => x.activity_id === 'audience_upload').status, 'met');
});

test('deterministic facts are overlaid AFTER parsing and override the model', () => {
  // Model says nothing about the Results stage, but the CRM has linked opps
  // and a closed-won deal — these deterministic facts must appear as met.
  const out = parseEventAnalysisResponse(JSON.stringify(validAnalysis()), {
    ...anchorsFor(),
    facts: {
      deterministic: {
        setup_date: { status: 'met', source_type: 'event_metadata', evidence: 'Event date scheduled for 2026-04-22.', source_id: 'evt_002', source_date: '2026-04-22' },
        results_opportunities: { status: 'met', source_type: 'linked_opportunities', evidence: '1 opportunity is linked to this event.', source_id: 'opp_003' },
        results_closed_won: { status: 'met', source_type: 'linked_opportunities', evidence: '1 linked opportunity is marked closed-won.', source_id: 'opp_004' },
      },
    },
  });
  const setup = out.stages.find(s => s.stage_id === 'setup');
  const results = out.stages.find(s => s.stage_id === 'results');
  assert.equal(setup.activities.find(a => a.activity_id === 'setup_date').status, 'met');
  assert.equal(setup.activities.find(a => a.activity_id === 'setup_date').source_type, 'event_metadata');
  assert.equal(results.activities.find(a => a.activity_id === 'results_opportunities').status, 'met');
  assert.equal(results.activities.find(a => a.activity_id === 'results_closed_won').status, 'met');
});

test('deterministic overlay overrides even a conflicting model claim', () => {
  const a = validAnalysis({ stages: [{
    stage_id: 'setup', status: 'in_progress', notes: '',
    activities: [{ activity_id: 'setup_date', status: 'not_met', evidence: 'No date set', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' }],
  }] });
  const out = parseEventAnalysisResponse(JSON.stringify(a), {
    ...anchorsFor(),
    facts: { deterministic: { setup_date: { status: 'met', source_type: 'event_metadata', evidence: 'Event date scheduled for 2026-04-22.', source_date: '2026-04-22' } } },
  });
  assert.equal(out.stages[0].activities.find(x => x.activity_id === 'setup_date').status, 'met');
});

// ── saved_playbook (manual confirmation) ─────────────────────────────
test('a saved_playbook claim is dropped without a matching checked activity', () => {
  const a = validAnalysis({ stages: [{
    stage_id: 'messaging', status: 'in_progress', notes: '',
    activities: [{ activity_id: 'messaging_cta', status: 'met', evidence: 'Checked in the playbook', source_type: 'saved_playbook', source_id: '', source_date: '' }],
  }] });
  const out = parseEventAnalysisResponse(JSON.stringify(a), {});
  const messaging = out.stages.find(s => s.stage_id === 'messaging');
  assert.equal(messaging.activities.find(x => x.activity_id === 'messaging_cta').status, 'no_evidence');
});

test('a saved_playbook check is honored, labelled manual, and never carries a quote', () => {
  const out = parseEventAnalysisResponse(JSON.stringify(validAnalysis()), {
    ...anchorsFor(),
    facts: { savedChecked: { messaging_cta: { date: '2026-04-01' }, audience_owners: { date: '2026-03-28' } } },
  });
  const messaging = out.stages.find(s => s.stage_id === 'messaging');
  const cta = messaging.activities.find(x => x.activity_id === 'messaging_cta');
  assert.equal(cta.status, 'met');
  assert.equal(cta.manual, true);
  assert.equal(cta.source_type, 'saved_playbook');
  assert.equal(cta.evidence, '', 'no manufactured quote for a manual check');
  assert.equal(cta.source_date, '2026-04-01');
});

test('a note-backed met is NOT overwritten by a saved-playbook manual check', () => {
  // setup_topic is note-backed met; a saved check for it must not strip the quote.
  const out = parseEventAnalysisResponse(JSON.stringify(validAnalysis()), {
    ...anchorsFor(),
    facts: { savedChecked: { setup_topic: { date: '2026-04-01' } } },
  });
  const topic = out.stages[0].activities.find(x => x.activity_id === 'setup_topic');
  assert.equal(topic.status, 'met');
  assert.equal(topic.manual, false);
  assert.ok(topic.evidence.length > 0, 'note-backed evidence preserved');
});

// ── not_met / recompute ──────────────────────────────────────────────
test('not_met preserves its negative citation (event_description)', () => {
  const a = validAnalysis();
  a.stages[0].activities[0] = { activity_id: 'setup_topic', status: 'not_met', evidence: 'The note says the topic is still undecided.', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' };
  const out = parseEventAnalysisResponse(JSON.stringify(a), anchorsFor());
  assert.equal(out.stages[0].activities[0].status, 'not_met');
  assert.equal(out.stages[0].activities[0].evidence, 'The note says the topic is still undecided.');
});

test('stage status and current position are recomputed from validated activities', () => {
  // Complete the whole Event stage deterministically + note, leave the rest empty.
  const a = validAnalysis({ stages: [{
    stage_id: 'setup', status: 'not_started', notes: '',   // model lies: says not_started
    activities: [
      { activity_id: 'setup_topic', status: 'met', evidence: 'Kickoff call agreed the workshop will cover cloud security best practices.', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' },
      { activity_id: 'setup_why', status: 'met', evidence: 'The team agreed the workshop will target enterprise IT leaders.', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' },
    ],
  }] });
  const out = parseEventAnalysisResponse(JSON.stringify(a), {
    ...anchorsFor(),
    facts: { deterministic: { setup_date: { status: 'met', source_type: 'event_metadata', evidence: 'Event date scheduled for 2026-04-22.', source_date: '2026-04-22' } } },
  });
  const setup = out.stages.find(s => s.stage_id === 'setup');
  assert.equal(setup.status, 'complete', 'recomputed to complete despite the model saying not_started');
  // Current stage becomes the first incomplete one (audience).
  assert.equal(out.current_stage_id, 'audience');
  assert.equal(out.lifecycle_complete, false);
  assert.equal(out.completion.met, 3);
});

test('current_stage_id is "" and lifecycle_complete true when all 21 are met', () => {
  // Overlay every activity deterministically.
  const deterministic = {};
  for (const id of ['setup_topic','setup_date','setup_why','audience_upload','audience_roles','audience_owners','messaging_why','messaging_proof','messaging_cta','drive_outreach','drive_registrations','drive_booking','eventday_dryrun','eventday_deliver','eventday_capture','followup_segment','followup_owners','followup_outreach','results_meetings','results_opportunities','results_closed_won']) {
    deterministic[id] = { status: 'met', source_type: 'event_metadata', evidence: 'done', source_date: '2026-04-22' };
  }
  const out = parseEventAnalysisResponse(JSON.stringify(validAnalysis()), { facts: { deterministic } });
  assert.equal(out.lifecycle_complete, true);
  assert.equal(out.current_stage_id, '');
  assert.equal(out.completion.pct, 100);
});

test('lists are string arrays with empties filtered', () => {
  const out = parseEventAnalysisResponse(JSON.stringify(validAnalysis()), anchorsFor());
  assert.deepEqual(out.next_actions, ['Upload the target account list']);
  assert.deepEqual(out.gaps, ['No target accounts uploaded yet']);
  assert.deepEqual(out.open_questions, ['Who owns the follow-up?']);
});

test('event_id / event_title fall back to the supplied options when omitted', () => {
  const a = validAnalysis({ event_id: '', event_title: '' });
  const out = parseEventAnalysisResponse(JSON.stringify(a), { ...anchorsFor(), eventId: 'evt_002', eventTitle: 'Cloud Security Workshop' });
  assert.equal(out.event_id, 'evt_002');
  assert.equal(out.event_title, 'Cloud Security Workshop');
});
