// Tests for buildEventAnalyzerPrompt() (js/utils/event-analyzer-prompts.js)
// and the evidence builders (js/utils/event-analyzer-evidence.js).
// Verifies the prompt carries every stage + activity id, sanitizes notes,
// excludes contact PII, includes structured aggregates, carries the
// anti-hallucination contract, and survives an event with zero notes.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEventAnalyzerPrompt, computeEventTiming, __eventPromptInternals } from '../js/utils/event-analyzer-prompts.js';
import { allActivityIds, EVENT_STAGES } from '../js/utils/event-analyzer-stages.js';
import {
  buildContactAggregates,
  buildLinkedOppFacts,
  parseSavedPlaybook,
  assembleStagesFromPlaybookRows,
  buildEventFacts,
} from '../js/utils/event-analyzer-evidence.js';

const EVENT = {
  event_id: 'evt_002',
  title: 'Cloud Security Workshop',
  event_type: 'Workshop',
  status: 'Upcoming',
  location: 'San Francisco, CA',
  event_date: '2026-04-22',
  end_date: '2026-04-23',
  description: 'Hands-on workshop.\n\n⸻ Team Notes ⸻\n[Event] Topic locked with the partner.',
};

const DESCRIPTIONS = [
  {
    description_id: 'edsc_2',
    description_date: '2026-03-20',
    title: 'Follow-up',
    description_text: '<p>Registrations are <strong>tracking well</strong>; 40 signed up.</p>',
  },
  {
    description_id: 'edsc_1',
    description_date: '2026-03-05',
    title: 'Kickoff',
    description_text: '<h4>Kickoff</h4><p>Agreed the workshop covers cloud security best practices.</p>',
  },
];

// Event_Contacts rows carry PII (name/email) that must NOT reach the prompt.
const CONTACTS = [
  { contact_id: 'c1', name: 'Jane Doe', email: 'jane@acme.com', icp_role: 'Decision Maker', seniority_tier: 'VP', owner: 'Randy', status: 'meeting' },
  { contact_id: 'c2', name: 'John Roe', email: 'john@globex.com', icp_role: 'Champion', seniority_tier: 'Director', owner: '', status: 'todo' },
  { contact_id: 'c3', name: 'Sam Poe', email: 'sam@initech.com', icp_role: '', seniority_tier: '', owner: 'Randy', status: 'declined' },
];

const OPPS = [
  { opportunity_id: 'opp_003', lead_source: 'evt_002', status: 'In Progress', stage: 'Negotiation' },
  { opportunity_id: 'opp_004', lead_source: 'evt_002', status: 'Won', stage: 'Closed' },
  { opportunity_id: 'opp_099', lead_source: 'evt_999', status: 'Won', stage: 'Closed' },
];

function factsFor(event = EVENT, contacts = CONTACTS, opps = OPPS, savedRaw = null) {
  return {
    contacts: buildContactAggregates(contacts),
    linkedOpps: buildLinkedOppFacts(opps, event.event_id),
    savedPlaybook: parseSavedPlaybook(savedRaw),
  };
}

// ── Prompt content ───────────────────────────────────────────────────
test('prompt includes every stage id and every activity id', () => {
  const prompt = buildEventAnalyzerPrompt(EVENT, DESCRIPTIONS, factsFor(), { today: '2026-04-01' });
  for (const s of EVENT_STAGES) assert.ok(prompt.includes(`stage_id: ${s.id}`), `missing stage ${s.id}`);
  for (const id of allActivityIds()) assert.ok(prompt.includes(`[${id}]`), `missing activity ${id}`);
});

test('prompt carries the anti-hallucination Golden Rule verbatim', () => {
  const prompt = buildEventAnalyzerPrompt(EVENT, DESCRIPTIONS, factsFor(), { today: '2026-04-01' });
  assert.ok(prompt.includes('GOLDEN RULE — THE MOST IMPORTANT INSTRUCTION:'));
  assert.ok(prompt.includes('Every activity you mark as "met" or "partial" must be supported by a supplied source.'));
  assert.ok(prompt.includes('Use "no_evidence" whenever the sources are silent. Never infer completion merely because'));
  assert.ok(prompt.includes('Assume the event happened just because its date is in the past'));
});

test('prompt is event-flavored: no sales probability or forecast bucket language', () => {
  const prompt = buildEventAnalyzerPrompt(EVENT, DESCRIPTIONS, factsFor(), { today: '2026-04-01' });
  assert.ok(!/probability/i.test(prompt), 'no probability language in event prompt');
  assert.ok(!/forecast bucket/i.test(prompt), 'no forecast bucket language in event prompt');
});

test('prompt includes event metadata + timing (days until)', () => {
  const prompt = buildEventAnalyzerPrompt(EVENT, DESCRIPTIONS, factsFor(), { today: '2026-04-01' });
  assert.ok(prompt.includes('Cloud Security Workshop'));
  assert.ok(prompt.includes('evt_002'));
  assert.ok(prompt.includes('2026-04-22'));
  assert.ok(prompt.includes('21 days until the event.'));
});

test('notes are HTML-stripped and sorted oldest first', () => {
  const prompt = buildEventAnalyzerPrompt(EVENT, DESCRIPTIONS, factsFor(), { today: '2026-04-01' });
  assert.ok(!prompt.includes('<strong>'));
  assert.ok(!prompt.includes('<h4>'));
  assert.ok(prompt.includes('cloud security best practices'));
  // Oldest (edsc_1 / Mar 5) must appear before newer (edsc_2 / Mar 20).
  assert.ok(prompt.indexOf('id: edsc_1') < prompt.indexOf('id: edsc_2'), 'oldest note first');
});

test('the Events row "Team Notes" mirror is stripped from metadata (avoid double-count)', () => {
  const prompt = buildEventAnalyzerPrompt(EVENT, DESCRIPTIONS, factsFor(), { today: '2026-04-01' });
  assert.ok(prompt.includes('Hands-on workshop.'));
  // The mirrored note CONTENT must not appear as metadata (the precedence
  // instructions still legitimately mention the "Team Notes" marker by name).
  assert.ok(!prompt.includes('Topic locked with the partner'), 'mirrored note text removed');
});

test('contact aggregates are included but NO PII (names/emails) leaks', () => {
  const prompt = buildEventAnalyzerPrompt(EVENT, DESCRIPTIONS, factsFor(), { today: '2026-04-01' });
  assert.ok(prompt.includes('Saved contacts: 3 total'));
  assert.ok(prompt.includes('With an owner assigned: 2'));
  assert.ok(prompt.includes('booked-meeting status: 1'));
  // PII must never appear.
  for (const pii of ['Jane Doe', 'jane@acme.com', 'John Roe', 'john@globex.com', 'Sam Poe']) {
    assert.ok(!prompt.includes(pii), `PII leaked: ${pii}`);
  }
  assert.ok(!prompt.includes('@'), 'no email addresses at all');
});

test('linked-opportunity structured facts are included', () => {
  const prompt = buildEventAnalyzerPrompt(EVENT, DESCRIPTIONS, factsFor(), { today: '2026-04-01' });
  assert.ok(prompt.includes('Linked opportunities'));
  assert.ok(prompt.includes('2 total, 1 closed-won'));
});

test('saved playbook checked activities are listed as manual confirmations', () => {
  const saved = [
    { key: 'setup', gate: false, note: 'topic locked', acts: [
      { x: 'Event topic', o: 'both', dt: '2026-03-05', d: true },
      { x: 'Date scheduled', o: 'both', dt: '', d: false },
      { x: 'Why', o: 'both', dt: '', d: false },
    ] },
  ];
  const prompt = buildEventAnalyzerPrompt(EVENT, DESCRIPTIONS, factsFor(EVENT, CONTACTS, OPPS, saved), { today: '2026-04-01' });
  assert.ok(prompt.includes('Manually checked activities in the saved playbook'));
  assert.ok(prompt.includes('[setup_topic]'));
  assert.ok(prompt.includes('never manufacture a quote for a manual check') || prompt.includes('never invent a quote for a checkbox'));
});

test('handles an event with no descriptions without crashing, and says so', () => {
  const prompt = buildEventAnalyzerPrompt(EVENT, [], { contacts: buildContactAggregates([]), linkedOpps: buildLinkedOppFacts([], 'evt_002'), savedPlaybook: parseSavedPlaybook(null) }, { today: '2026-04-01' });
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.includes('No description notes exist'));
  assert.ok(prompt.includes('No saved Event_Contacts'));
  assert.ok(prompt.includes('No opportunities are linked'));
  assert.ok(prompt.includes('No saved playbook state was loaded'));
});

test('handles a null event / undefined args', () => {
  assert.doesNotThrow(() => buildEventAnalyzerPrompt(null, undefined, {}, { today: '2026-04-01' }));
  const prompt = buildEventAnalyzerPrompt(null, undefined, {}, { today: '2026-04-01' });
  assert.ok(prompt.includes('this event'));
});

// ── Evidence builders ────────────────────────────────────────────────
test('buildContactAggregates counts only, with owner coverage', () => {
  const agg = buildContactAggregates(CONTACTS);
  assert.equal(agg.total, 3);
  assert.equal(agg.withRole, 2);
  assert.equal(agg.withOwner, 2);
  assert.equal(agg.meetingCount, 1);
  assert.equal(agg.ownerCoveragePct, 67);
  assert.equal(agg.byStatus.meeting, 1);
});

test('buildLinkedOppFacts filters by event id and detects explicit closed-won', () => {
  const f = buildLinkedOppFacts(OPPS, 'evt_002');
  assert.equal(f.count, 2);            // opp_099 belongs to a different event
  assert.equal(f.closedWonCount, 1);
  assert.deepEqual(f.closedWonIds, ['opp_004']);
  // Open pipeline is never counted as closed-won.
  assert.equal(f.openCount, 1);
});

test('parseSavedPlaybook maps positional acts onto stable activity ids (checked only)', () => {
  const saved = [
    { key: 'setup', note: 'n', acts: [ { x: 'Event topic', d: true, dt: '2026-03-05' }, { x: 'Date scheduled', d: false }, { x: 'Why', d: true, dt: '' } ] },
    { key: 'results', note: '', acts: [ { d: false }, { d: false }, { d: false } ] },
  ];
  const parsed = parseSavedPlaybook(saved);
  assert.equal(parsed.found, true);
  assert.deepEqual(Object.keys(parsed.checked).sort(), ['setup_topic', 'setup_why']);
  assert.equal(parsed.checked.setup_topic.date, '2026-03-05');
});

test('parseSavedPlaybook accepts a JSON string and the keyed loadPlaybook shape', () => {
  const asString = JSON.stringify([{ key: 'setup', acts: [{ x: 'Event topic', d: true, dt: '2026-03-05' }] }]);
  assert.equal(parseSavedPlaybook(asString).checked.setup_topic.date, '2026-03-05');
  const keyed = { setup: { note: 'n', acts: [{ i: 0, d: true, dt: '2026-03-05' }] } };
  assert.equal(parseSavedPlaybook(keyed).checked.setup_topic.date, '2026-03-05');
  assert.equal(parseSavedPlaybook(null).found, false);
  assert.equal(parseSavedPlaybook('not json').found, false);
});

test('buildEventFacts overlays hard facts and gates structured support', () => {
  const facts = buildEventFacts({
    event: EVENT,
    contacts: buildContactAggregates(CONTACTS),
    linkedOpps: buildLinkedOppFacts(OPPS, 'evt_002'),
    savedPlaybook: parseSavedPlaybook(null),
  });
  // Deterministic: scheduled date + linked opps + closed-won.
  assert.equal(facts.deterministic.setup_date.status, 'met');
  assert.equal(facts.deterministic.results_opportunities.status, 'met');
  assert.equal(facts.deterministic.results_closed_won.status, 'met');
  // Structured support gated on the aggregates.
  assert.equal(facts.structuredSupport.audience_upload, true);
  assert.equal(facts.structuredSupport.audience_owners, true);
  assert.equal(facts.structuredSupport.results_meetings, true);
});

test('buildEventFacts adds NO closed-won fact when there is only open pipeline', () => {
  const openOnly = [{ opportunity_id: 'opp_x', lead_source: 'evt_002', status: 'In Progress', stage: 'Proposal' }];
  const facts = buildEventFacts({
    event: EVENT,
    contacts: buildContactAggregates([]),
    linkedOpps: buildLinkedOppFacts(openOnly, 'evt_002'),
    savedPlaybook: parseSavedPlaybook(null),
  });
  assert.equal(facts.deterministic.results_opportunities.status, 'met');
  assert.ok(!('results_closed_won' in facts.deterministic), 'no closed-won overlay from open pipeline');
});

test('computeEventTiming reports days until / since / today', () => {
  assert.equal(computeEventTiming(EVENT, '2026-04-01').daysLabel, '21 days until the event.');
  assert.equal(computeEventTiming(EVENT, '2026-04-22').daysLabel, 'The event is today.');
  assert.equal(computeEventTiming(EVENT, '2026-05-01').daysLabel, '9 days since the event.');
  assert.equal(computeEventTiming({}, '2026-04-01').daysLabel, 'Event date unknown.');
});

test('stripTeamNotes trims the mirror section only', () => {
  const { stripTeamNotes } = __eventPromptInternals;
  assert.equal(stripTeamNotes('Base.\n\n⸻ Team Notes ⸻\n[Event] x'), 'Base.');
  assert.equal(stripTeamNotes('No marker here'), 'No marker here');
  assert.equal(stripTeamNotes(''), '');
});

// ── assembleStagesFromPlaybookRows (multi-row Event_Playbook schema) ──
// The deployed Apps Script writes one row per activity/gate/note; the
// analyzer used to read only a `stages_json` column that sheet never has,
// so every manually-checked activity was silently invisible to it.
test('multi-row playbook rows assemble into the shape parseSavedPlaybook accepts', () => {
  const rows = [
    { event_id: 'evt_002', stage_key: 'setup', row_type: 'activity', act_index: '0', text: 'Book venue', owner: 'AA', due_date: '2026-04-01', done: 'TRUE' },
    { event_id: 'evt_002', stage_key: 'setup', row_type: 'activity', act_index: '1', text: 'Send invites', owner: '', due_date: '', done: 'FALSE' },
    { event_id: 'evt_002', stage_key: 'setup', row_type: 'gate', done: 'TRUE' },
    { event_id: 'evt_002', stage_key: 'setup', row_type: 'note', note_text: 'Venue confirmed by email.' },
    { event_id: 'evt_002', stage_key: 'audience', row_type: 'activity', act_index: '0', text: 'Host event', done: 'FALSE' },
  ];
  const stages = assembleStagesFromPlaybookRows(rows);
  assert.equal(stages.length, 2);
  const plan = stages.find(s => s.key === 'setup');
  assert.equal(plan.gate, true);
  assert.equal(plan.note, 'Venue confirmed by email.');
  assert.equal(plan.acts.length, 2);
  assert.deepEqual(plan.acts[0], { i: 0, x: 'Book venue', o: 'AA', dt: '2026-04-01', d: true });

  const parsed = parseSavedPlaybook(stages);
  assert.equal(parsed.found, true);
  assert.equal(parsed.notes.setup, 'Venue confirmed by email.');
  const checkedIds = Object.keys(parsed.checked);
  assert.equal(checkedIds.length, 1, 'only the done activity counts as an operational confirmation');
});

test('assembleStagesFromPlaybookRows returns null when rows hold no stage data', () => {
  assert.equal(assembleStagesFromPlaybookRows([]), null);
  assert.equal(assembleStagesFromPlaybookRows([{ event_id: 'evt_002', stages_json: '[]' }]), null);
});
