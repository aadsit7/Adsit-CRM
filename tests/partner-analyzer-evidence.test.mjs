// Tests for the Partner evidence builders (js/utils/partner-analyzer-evidence.js).
// Verifies STRICT partner scoping (a partner never sees another's rows, and
// UNASSIGNED events are never counted as this partner's activity), deterministic
// KPIs, privacy (no PII / passwords), meeting↔transcript dedup, the
// deterministic/structured criteria facts, and bounded evidence + coverage.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectAnalyzablePartners, buildPartnerSelectorOptions,
  selectPartnerTranscripts, selectPartnerMeetings, selectPartnerDocuments,
  selectPartnerOpportunities, collectOpportunityIds, selectOpportunityDescriptions,
  selectPartnerEvents, collectEventIds, selectEventDescriptionsForPartner, selectEventContactsForPartner,
  dedupeMeetingsAgainstTranscripts,
  isWonOpp, isActiveOpp, isLostOpp,
  buildPartnerKpis, buildContactAggregates, buildPartnerCriteriaFacts,
  assemblePartnerEvidence, collectPartnerAnchors, withCoverageFailures,
} from '../js/utils/partner-analyzer-evidence.js';

const TODAY = '2026-07-21';

// ── Fixtures ─────────────────────────────────────────────────────────
const PARTNERS = [
  { partner_id: 'p_admin', display_name: 'Portal Admin', is_admin: 'TRUE', password_hash: 'HASHADMIN', username: 'admin' },
  { partner_id: 'p1', display_name: 'Nerdio', partner_type: 'Technology', tier: 'Premier/Strategic', region: 'North America', hq_location: 'Chicago', status: 'active', created_at: '2026-01-15', password_hash: 'SECRETHASH1', username: 'nerdio' },
  { partner_id: 'p2', display_name: 'Elantis', partner_type: 'MSP/SI', tier: 'Value/Preferred', region: 'North America', hq_location: 'Edmonton', status: 'active', created_at: '2026-02-01', password_hash: 'SECRETHASH2', username: 'elantis' },
  { partner_id: '', display_name: 'No ID Partner' }, // must be excluded (no valid id)
];

const TRANSCRIPTS = [
  { transcript_id: 't1', partner_id: 'p1', conversation_date: '2026-06-10', transcript_text: '<p>Great alignment on goals for AVD.</p>' },
  { transcript_id: 't2', partner_id: 'p1', conversation_date: '2026-05-01', transcript_text: '<p>Kickoff call.</p>' },
  { transcript_id: 't9', partner_id: 'p2', conversation_date: '2026-06-01', transcript_text: '<p>Other partner talk.</p>' },
];

const MEETINGS = [
  // m1 shares t1 → same conversation (must NOT double-count).
  { meeting_id: 'm1', transcript_id: 't1', partner_id: 'p1', meeting_date: '2026-06-10', meeting_title: 'AVD sync', summary: 'Aligned on goals', key_decisions: 'Proceed to enablement' },
  // m2 is a standalone indexed meeting (no transcript).
  { meeting_id: 'm2', transcript_id: '', partner_id: 'p1', meeting_date: '2026-06-20', meeting_title: 'QBR', summary: 'Reviewed pipeline' },
  { meeting_id: 'm9', transcript_id: '', partner_id: 'p2', meeting_date: '2026-06-01', summary: 'Other partner' },
];

const DOCUMENTS = [
  { document_id: 'd1', partner_id: 'p1', title: 'Joint GTM Plan', doc_type: 'plan', html_content: '<h1>Target market</h1><p>Mid-market MSPs.</p>', status: 'active', created_at: '2026-06-05' },
  { document_id: 'd9', partner_id: 'p2', title: 'Other', html_content: '<p>nope</p>' },
];

const OPPS = [
  { opportunity_id: 'o1', partner_id: 'p1', deal_value: '150000', status: 'In Progress', stage: 'Proposal', expected_close: '2026-09-15', updated_at: '2026-06-25' },
  { opportunity_id: 'o2', partner_id: 'p1', deal_value: '75000', status: 'Won', stage: 'Closed', updated_at: '2026-05-10' },
  { opportunity_id: 'o3', partner_id: 'p1', deal_value: '40000', status: 'Lost', stage: 'Closed', updated_at: '2026-04-01' },
  { opportunity_id: 'o9', partner_id: 'p2', deal_value: '999999', status: 'Won', stage: 'Closed' },
];

const OPP_DESCRIPTIONS = [
  { description_id: 'od1', opportunity_id: 'o1', description_date: '2026-06-25', description_text: '<p>Proposal submitted, negotiating scope.</p>' },
  { description_id: 'od9', opportunity_id: 'o9', description_date: '2026-06-01', description_text: '<p>Other partner opp note.</p>' },
];

const EVENTS = [
  { event_id: 'e1', partner_id: 'p1', title: 'Nerdio Webinar', event_type: 'Webinar', event_date: '2026-05-20', status: 'Completed' },
  { event_id: 'e2', partner_id: 'p1', title: 'Nerdio Workshop', event_type: 'Workshop', event_date: '2026-08-10', status: 'Upcoming' },
  { event_id: 'e_unassigned', partner_id: '', title: 'Open House', event_type: 'Webinar', event_date: '2026-05-01', status: 'Completed' },
  { event_id: 'e9', partner_id: 'p2', title: 'Elantis event', event_type: 'Webinar', event_date: '2026-05-05', status: 'Completed' },
];

const EVENT_DESCRIPTIONS = [
  { description_id: 'ed1', event_id: 'e1', description_date: '2026-05-21', description_text: '<p>40 attendees, strong engagement.</p>' },
  { description_id: 'ed_un', event_id: 'e_unassigned', description_date: '2026-05-02', description_text: '<p>unassigned note</p>' },
  { description_id: 'ed9', event_id: 'e9', description_date: '2026-05-06', description_text: '<p>other</p>' },
];

const EVENT_CONTACTS = [
  { event_id: 'e1', contact_id: 'c1', name: 'Jane Doe', email: 'jane@acme.com', owner: 'Randy', status: 'meeting', icp_role: 'Decision Maker' },
  { event_id: 'e1', contact_id: 'c2', name: 'John Roe', email: 'john@globex.com', owner: '', status: 'todo', icp_role: 'Champion' },
  { event_id: 'e9', contact_id: 'c9', name: 'Other Person', email: 'x@y.com', owner: 'X', status: 'meeting' },
];

const P1 = PARTNERS[1];

// ── Selector population ──────────────────────────────────────────────
test('selectAnalyzablePartners excludes admins and rows without a valid id, sorts by name', () => {
  const list = selectAnalyzablePartners(PARTNERS);
  assert.deepEqual(list.map(p => p.partner_id), ['p2', 'p1']); // Elantis before Nerdio (case-insensitive)
  assert.ok(!list.some(p => String(p.is_admin).toUpperCase() === 'TRUE'), 'no admin');
  assert.ok(!list.some(p => !p.partner_id), 'no missing-id row');
});

test('buildPartnerSelectorOptions labels "Name — Type · Tier" and disambiguates duplicates', () => {
  const opts = buildPartnerSelectorOptions(PARTNERS);
  const nerdio = opts.find(o => o.id === 'p1');
  assert.equal(nerdio.label, 'Nerdio — Technology · Premier/Strategic');

  const dupes = buildPartnerSelectorOptions([
    { partner_id: 'a', display_name: 'Acme', partner_type: 'MSP/SI', tier: 'Registered', region: 'NA' },
    { partner_id: 'b', display_name: 'Acme', partner_type: 'MSP/SI', tier: 'Registered', region: 'EMEA' },
  ]);
  assert.ok(dupes[0].label.includes('(') && dupes[1].label.includes('('), 'duplicate names disambiguated');
  assert.notEqual(dupes[0].label, dupes[1].label);
});

// ── Strict scoping ───────────────────────────────────────────────────
test('transcripts / meetings / documents / opportunities are strictly partner-scoped', () => {
  assert.deepEqual(selectPartnerTranscripts(TRANSCRIPTS, 'p1').map(t => t.transcript_id), ['t1', 't2']); // newest first
  assert.ok(!selectPartnerMeetings(MEETINGS, 'p1').some(m => m.partner_id !== 'p1'));
  assert.ok(!selectPartnerDocuments(DOCUMENTS, 'p1').some(d => d.partner_id !== 'p1'));
  assert.equal(selectPartnerOpportunities(OPPS, 'p1').length, 3);
  assert.ok(!selectPartnerOpportunities(OPPS, 'p1').some(o => o.opportunity_id === 'o9'));
});

test('selectPartnerEvents is STRICT: excludes unassigned events AND other partners’ events', () => {
  const evs = selectPartnerEvents(EVENTS, 'p1');
  assert.deepEqual(evs.map(e => e.event_id).sort(), ['e1', 'e2']);
  assert.ok(!evs.some(e => e.event_id === 'e_unassigned'), 'unassigned event excluded');
  assert.ok(!evs.some(e => e.event_id === 'e9'), 'other partner event excluded');
});

test('opportunity descriptions are restricted to the selected partner opportunity ids', () => {
  const oppIds = collectOpportunityIds(selectPartnerOpportunities(OPPS, 'p1'));
  const desc = selectOpportunityDescriptions(OPP_DESCRIPTIONS, oppIds);
  assert.deepEqual(desc.map(d => d.description_id), ['od1']);
  assert.ok(!desc.some(d => d.opportunity_id === 'o9'), 'other partner opp note excluded');
});

test('event descriptions + contacts are restricted to the selected partner event ids', () => {
  const eventIds = collectEventIds(selectPartnerEvents(EVENTS, 'p1'));
  const desc = selectEventDescriptionsForPartner(EVENT_DESCRIPTIONS, eventIds);
  assert.deepEqual(desc.map(d => d.description_id), ['ed1']);
  assert.ok(!desc.some(d => d.event_id === 'e_unassigned'), 'unassigned event note excluded');
  const contacts = selectEventContactsForPartner(EVENT_CONTACTS, eventIds);
  assert.equal(contacts.length, 2);
  assert.ok(contacts.every(c => c.event_id === 'e1'));
});

// ── Meeting / transcript dedup ───────────────────────────────────────
test('a Meeting_Index row sharing a transcript_id is not counted twice', () => {
  const standalone = dedupeMeetingsAgainstTranscripts(MEETINGS.filter(m => m.partner_id === 'p1'), selectPartnerTranscripts(TRANSCRIPTS, 'p1'));
  assert.deepEqual(standalone.map(m => m.meeting_id), ['m2'], 'm1 (shares t1) is deduped away');
});

// ── Opportunity status semantics ─────────────────────────────────────
test('opportunity status helpers follow the app semantics', () => {
  assert.ok(isWonOpp({ status: 'Won' }));
  assert.ok(!isWonOpp({ status: 'In Progress' }));
  assert.ok(isLostOpp({ status: 'Lost' }));
  assert.ok(isActiveOpp({ status: 'In Progress' }));
  assert.ok(isActiveOpp({ status: 'Registered' }), 'a non-Won, non-Lost value is active');
  assert.ok(!isActiveOpp({ status: 'Won' }));
  assert.ok(!isActiveOpp({ status: 'Lost' }));
});

// ── Deterministic KPIs ───────────────────────────────────────────────
test('buildPartnerKpis computes won/active/pipeline/revenue deterministically', () => {
  const k = buildPartnerKpis({
    partner: P1,
    transcripts: selectPartnerTranscripts(TRANSCRIPTS, 'p1'),
    meetings: selectPartnerMeetings(MEETINGS, 'p1'),
    documents: selectPartnerDocuments(DOCUMENTS, 'p1'),
    events: selectPartnerEvents(EVENTS, 'p1'),
    opportunities: selectPartnerOpportunities(OPPS, 'p1'),
    opportunityDescriptions: selectOpportunityDescriptions(OPP_DESCRIPTIONS, collectOpportunityIds(selectPartnerOpportunities(OPPS, 'p1'))),
    today: TODAY,
  });
  assert.equal(k.totalOpps, 3);
  assert.equal(k.wonOppCount, 1);
  assert.equal(k.wonRevenue, 75000);
  assert.equal(k.activeOppCount, 1, 'only o1 is active (o2 Won, o3 Lost)');
  assert.equal(k.activePipelineValue, 150000);
  assert.equal(k.eventCount, 2);
  assert.equal(k.upcomingEventCount, 1);
  assert.equal(k.completedEventCount, 1);
  assert.equal(k.transcriptCount, 2);
  assert.equal(k.meetingCount, 2);
  assert.equal(k.standaloneMeetingCount, 1, 'm1 deduped against t1');
  assert.equal(k.nearestExpectedClose, '2026-09-15');
  // Most recent PAST activity (<= today): opp o1 updated 2026-06-25.
  assert.equal(k.mostRecentActivityDate, '2026-06-25');
  // Earliest PAST activity (<= today): opp o3 updated 2026-04-01 — the fallback
  // for partnership age when the Partners row has no created_at.
  assert.equal(k.firstActivityDate, '2026-04-01');
});

test('KPIs never leak passwords / usernames / admin flags', () => {
  const k = buildPartnerKpis({ partner: P1, transcripts: [], meetings: [], documents: [], events: [], opportunities: [] });
  assert.ok(!('password_hash' in k) && !('username' in k) && !('is_admin' in k));
  assert.ok(!JSON.stringify(k).includes('SECRETHASH1'), 'no password hash value anywhere in KPIs');
});

// ── Contact aggregates (no PII) ──────────────────────────────────────
test('buildContactAggregates yields counts only (no names / emails)', () => {
  const eventIds = collectEventIds(selectPartnerEvents(EVENTS, 'p1'));
  const agg = buildContactAggregates(selectEventContactsForPartner(EVENT_CONTACTS, eventIds));
  assert.equal(agg.total, 2);
  assert.equal(agg.meetingCount, 1);
  assert.ok(!JSON.stringify(agg).includes('Jane Doe'));
  assert.ok(!JSON.stringify(agg).includes('@'));
});

// ── Deterministic + structured criteria facts ────────────────────────
test('buildPartnerCriteriaFacts overlays hard facts and gates structured support', () => {
  const oppIds = collectOpportunityIds(selectPartnerOpportunities(OPPS, 'p1'));
  const kpis = buildPartnerKpis({
    partner: P1,
    transcripts: selectPartnerTranscripts(TRANSCRIPTS, 'p1'),
    meetings: selectPartnerMeetings(MEETINGS, 'p1'),
    documents: selectPartnerDocuments(DOCUMENTS, 'p1'),
    events: selectPartnerEvents(EVENTS, 'p1'),
    opportunities: selectPartnerOpportunities(OPPS, 'p1'),
    opportunityDescriptions: selectOpportunityDescriptions(OPP_DESCRIPTIONS, oppIds),
    today: TODAY,
  });
  const facts = buildPartnerCriteriaFacts({ partner: P1, kpis, contactsAgg: buildContactAggregates(selectEventContactsForPartner(EVENT_CONTACTS, collectEventIds(selectPartnerEvents(EVENTS, 'p1')))) });
  // Deterministic met: profile complete, relationship established, opps, active pipeline, won.
  assert.equal(facts.deterministic.partner_profile_complete.status, 'met');
  assert.equal(facts.deterministic.relationship_established.status, 'met');
  assert.equal(facts.deterministic.opportunities_created.status, 'met');
  assert.equal(facts.deterministic.active_pipeline.status, 'met');
  assert.equal(facts.deterministic.revenue_won.status, 'met');
  // A completed event → joint_activity_launched deterministic MET.
  assert.equal(facts.deterministic.joint_activity_launched.status, 'met');
  // Structured support (repeatable motion allowed: 3 opps ≥ 2).
  assert.equal(facts.structuredSupport.repeatable_motion, true);
  assert.equal(facts.structuredSupport.audience_engaged, true);
});

test('a merely UPCOMING event yields joint_activity_launched = PARTIAL, not met', () => {
  const upcomingOnly = [{ event_id: 'eu', partner_id: 'p1', event_date: '2026-09-01', status: 'Upcoming' }];
  const kpis = buildPartnerKpis({ partner: P1, transcripts: [], meetings: [], documents: [], events: upcomingOnly, opportunities: [], today: TODAY });
  const facts = buildPartnerCriteriaFacts({ partner: P1, kpis, contactsAgg: { total: 0 } });
  assert.equal(facts.deterministic.joint_activity_launched.status, 'partial');
});

test('repeatable_motion is NOT supported from a single opportunity alone', () => {
  const kpis = buildPartnerKpis({ partner: P1, transcripts: [], meetings: [], documents: [], events: [], opportunities: [{ opportunity_id: 'x', partner_id: 'p1', status: 'In Progress', deal_value: '100' }], today: TODAY });
  const facts = buildPartnerCriteriaFacts({ partner: P1, kpis, contactsAgg: { total: 0 } });
  assert.ok(!facts.structuredSupport.repeatable_motion, 'one deal is not a repeatable motion');
});

// ── Bounded evidence + coverage ──────────────────────────────────────
test('assemblePartnerEvidence strips HTML and reports coverage', () => {
  const ev = assemblePartnerEvidence({
    transcripts: selectPartnerTranscripts(TRANSCRIPTS, 'p1'),
    meetings: selectPartnerMeetings(MEETINGS, 'p1'),
    documents: selectPartnerDocuments(DOCUMENTS, 'p1'),
    opportunityDescriptions: selectOpportunityDescriptions(OPP_DESCRIPTIONS, collectOpportunityIds(selectPartnerOpportunities(OPPS, 'p1'))),
    eventDescriptions: selectEventDescriptionsForPartner(EVENT_DESCRIPTIONS, collectEventIds(selectPartnerEvents(EVENTS, 'p1'))),
  });
  assert.ok(!JSON.stringify(ev).includes('<p>'), 'HTML stripped');
  assert.ok(ev.transcripts.some(t => t.text.includes('alignment on goals')));
  assert.equal(ev.coverage.found.transcripts, 2);
  assert.equal(ev.coverage.included.transcripts, 2);
  assert.equal(ev.coverage.omitted.transcripts, 0);
});

test('assemblePartnerEvidence enforces per-source limits and warns on omissions', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ transcript_id: `t${i}`, partner_id: 'p1', conversation_date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, transcript_text: `<p>note ${i} content words here</p>` }));
  const ev = assemblePartnerEvidence({ transcripts: many }, { transcripts: 5 });
  assert.equal(ev.coverage.found.transcripts, 30);
  assert.equal(ev.coverage.included.transcripts, 5);
  assert.equal(ev.coverage.omitted.transcripts, 25);
  assert.equal(ev.coverage.hasOmissions, true);
  assert.ok(ev.coverage.warnings.some(w => /not sent to Randy/i.test(w)));
});

test('assemblePartnerEvidence labels a mid-source truncation', () => {
  const long = 'word '.repeat(2000);
  const ev = assemblePartnerEvidence({ documents: [{ document_id: 'd', partner_id: 'p1', title: 'Big', html_content: `<p>${long}</p>` }] }, { charsPerItem: 200 });
  assert.ok(ev.documents[0].text.includes('[truncated]'));
  assert.equal(ev.coverage.truncatedItems, 1);
});

test('withCoverageFailures folds read failures into the warnings', () => {
  const ev = assemblePartnerEvidence({ transcripts: [] });
  const merged = withCoverageFailures(ev.coverage, ['Meeting_Index could not be loaded.']);
  assert.ok(merged.warnings.some(w => /Meeting_Index could not be loaded/.test(w)));
  assert.equal(merged.hasOmissions, true);
});

// ── Anchors ──────────────────────────────────────────────────────────
test('collectPartnerAnchors ties narrative ids to the right link target', () => {
  const oppIds = collectOpportunityIds(selectPartnerOpportunities(OPPS, 'p1'));
  const eventIds = collectEventIds(selectPartnerEvents(EVENTS, 'p1'));
  const ev = assemblePartnerEvidence({
    transcripts: selectPartnerTranscripts(TRANSCRIPTS, 'p1'),
    opportunityDescriptions: selectOpportunityDescriptions(OPP_DESCRIPTIONS, oppIds),
    eventDescriptions: selectEventDescriptionsForPartner(EVENT_DESCRIPTIONS, eventIds),
  });
  const anchors = collectPartnerAnchors(ev, { opportunityIds: oppIds, eventIds, partnerId: 'p1' });
  assert.ok(anchors.narrativeIds.has('t1'));
  assert.ok(anchors.narrativeIds.has('od1'));
  assert.equal(anchors.relatedById.get('od1'), 'o1', 'opp note links to its opportunity');
  assert.equal(anchors.relatedById.get('ed1'), 'e1', 'event note links to its event');
  assert.equal(anchors.relatedById.get('t1'), 'p1', 'transcript links to the partner');
  assert.ok(anchors.structuredIds.has('o1') && anchors.structuredIds.has('e1') && anchors.structuredIds.has('p1'));
});
