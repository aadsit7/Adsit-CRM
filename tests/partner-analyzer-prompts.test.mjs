// Tests for buildPartnerAnalyzerPrompt() (js/utils/partner-analyzer-prompts.js).
// Verifies the prompt carries every stage + criterion id, the deterministic
// KPIs, the anti-hallucination contract (verbatim Golden Rule), that HTML /
// PII / secrets never leak, that tier/status are framed as context (not
// evidence), and that no forecast-probability or event-countdown language
// appears. Empty-evidence behavior is checked too.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPartnerAnalyzerPrompt, __partnerPromptInternals } from '../js/utils/partner-analyzer-prompts.js';
import { PARTNER_STAGES, allCriterionIds } from '../js/utils/partner-analyzer-stages.js';
import {
  buildPartnerKpis, assemblePartnerEvidence, buildContactAggregates,
  selectPartnerTranscripts, selectPartnerMeetings, selectPartnerDocuments,
  selectPartnerOpportunities, collectOpportunityIds, selectOpportunityDescriptions,
  selectPartnerEvents, collectEventIds, selectEventDescriptionsForPartner, selectEventContactsForPartner,
} from '../js/utils/partner-analyzer-evidence.js';

const TODAY = '2026-07-21';
const PARTNER = { partner_id: 'p1', display_name: 'Nerdio', partner_type: 'Technology', tier: 'Premier/Strategic', region: 'North America', hq_location: 'Chicago', status: 'active', created_at: '2026-01-15', password_hash: 'SECRETHASH1', username: 'nerdio' };

const TRANSCRIPTS = [{ transcript_id: 't1', partner_id: 'p1', conversation_date: '2026-06-10', transcript_text: '<p>Aligned on <strong>shared goals</strong> for AVD.</p>' }];
const MEETINGS = [{ meeting_id: 'm1', transcript_id: '', partner_id: 'p1', meeting_date: '2026-06-20', meeting_title: 'QBR', summary: 'Pipeline review' }];
const DOCUMENTS = [{ document_id: 'd1', partner_id: 'p1', title: 'GTM Plan', doc_type: 'plan', html_content: '<h1>Target market</h1><p>Mid-market MSPs.</p>' }];
const OPPS = [
  { opportunity_id: 'o1', partner_id: 'p1', deal_value: '150000', status: 'In Progress', stage: 'Proposal', expected_close: '2026-09-15', updated_at: '2026-06-25' },
  { opportunity_id: 'o2', partner_id: 'p1', deal_value: '75000', status: 'Won', stage: 'Closed' },
];
const OPP_DESC = [{ description_id: 'od1', opportunity_id: 'o1', description_date: '2026-06-25', description_text: '<p>Proposal submitted.</p>' }];
const EVENTS = [{ event_id: 'e1', partner_id: 'p1', title: 'Webinar', event_type: 'Webinar', event_date: '2026-05-20', status: 'Completed' }];
const EVENT_DESC = [{ description_id: 'ed1', event_id: 'e1', description_date: '2026-05-21', description_text: '<p>40 attendees.</p>' }];
const EVENT_CONTACTS = [
  { event_id: 'e1', contact_id: 'c1', name: 'Jane Doe', email: 'jane@acme.com', owner: 'Randy', status: 'meeting', icp_role: 'Decision Maker' },
  { event_id: 'e1', contact_id: 'c2', name: 'John Roe', email: 'john@globex.com', owner: '', status: 'todo' },
];

function buildAll({ transcripts = TRANSCRIPTS, meetings = MEETINGS, documents = DOCUMENTS, opps = OPPS, events = EVENTS } = {}) {
  const pOpps = selectPartnerOpportunities(opps, 'p1');
  const oppIds = collectOpportunityIds(pOpps);
  const pEvents = selectPartnerEvents(events, 'p1');
  const eventIds = collectEventIds(pEvents);
  const pTranscripts = selectPartnerTranscripts(transcripts, 'p1');
  const pMeetings = selectPartnerMeetings(meetings, 'p1');
  const pDocs = selectPartnerDocuments(documents, 'p1');
  const pOppDesc = selectOpportunityDescriptions(OPP_DESC, oppIds);
  const pEventDesc = selectEventDescriptionsForPartner(EVENT_DESC, eventIds);
  const contactsAgg = buildContactAggregates(selectEventContactsForPartner(EVENT_CONTACTS, eventIds));
  const kpis = buildPartnerKpis({ partner: PARTNER, transcripts: pTranscripts, meetings: pMeetings, documents: pDocs, events: pEvents, opportunities: pOpps, opportunityDescriptions: pOppDesc, eventDescriptions: pEventDesc, today: TODAY });
  const evidence = assemblePartnerEvidence({ transcripts: pTranscripts, meetings: pMeetings, documents: pDocs, opportunityDescriptions: pOppDesc, eventDescriptions: pEventDesc });
  return buildPartnerAnalyzerPrompt({ partner: PARTNER, kpis, evidence, contactsAgg, today: TODAY });
}

// ── Definitions ──────────────────────────────────────────────────────
test('prompt includes every stage id and every criterion id', () => {
  const prompt = buildAll();
  for (const s of PARTNER_STAGES) assert.ok(prompt.includes(`stage_id: ${s.id}`), `missing stage ${s.id}`);
  for (const id of allCriterionIds()) assert.ok(prompt.includes(`[${id}]`), `missing criterion ${id}`);
});

// ── Golden Rule + anti-hallucination ─────────────────────────────────
test('prompt carries the Golden Rule verbatim (incl. the tier/status principle)', () => {
  const prompt = buildAll();
  assert.ok(prompt.includes('GOLDEN RULE — THE MOST IMPORTANT INSTRUCTION:'));
  assert.ok(prompt.includes('Every met or partial criterion must be supported by a supplied source.'));
  assert.ok(prompt.includes('Partner tier,\nstatus, longevity, reputation, or typical channel behavior are not evidence.')
    || prompt.includes('Partner tier, status, longevity, reputation, or typical channel behavior are not evidence.'));
});

test('prompt tells the model NOT to browse, guess, or confuse pipeline/wins/events', () => {
  const prompt = buildAll();
  assert.ok(/Browse the web/i.test(prompt));
  assert.ok(prompt.includes('ACTIVE PIPELINE with WON REVENUE'));
  assert.ok(prompt.includes('SCHEDULED (upcoming) event with a COMPLETED activity'));
  assert.ok(/isolated deal or one isolated event as proof of a repeatable motion/.test(prompt));
  assert.ok(/open question over a guess/i.test(prompt));
});

// ── Deterministic metrics + context framing ──────────────────────────
test('prompt includes the deterministic KPI facts', () => {
  const prompt = buildAll();
  assert.ok(prompt.includes('Total linked opportunities: 2'));
  assert.ok(prompt.includes('$150,000'), 'active pipeline value');
  assert.ok(prompt.includes('$75,000'), 'won revenue value');
  assert.ok(prompt.includes('WON opportunities: 1'));
});

test('tier and status are framed as CONTEXT, not maturity evidence', () => {
  const prompt = buildAll();
  assert.ok(prompt.includes('CRM tier: Premier/Strategic'));
  assert.ok(/NOT maturity evidence/i.test(prompt));
  assert.ok(/If the CRM tier looks more advanced than the evidence supports/i.test(prompt));
});

test('prompt states today’s date', () => {
  assert.ok(buildAll().includes(`Today is ${TODAY}.`));
});

// ── Sanitization ─────────────────────────────────────────────────────
test('HTML is stripped from every evidence block', () => {
  const prompt = buildAll();
  assert.ok(!prompt.includes('<p>') && !prompt.includes('<strong>') && !prompt.includes('<h1>'));
  assert.ok(prompt.includes('shared goals'));
  assert.ok(prompt.includes('Mid-market MSPs.'));
});

test('no PII (contact names / emails) and no secrets (passwords / usernames) leak', () => {
  const prompt = buildAll();
  for (const pii of ['Jane Doe', 'jane@acme.com', 'John Roe', 'john@globex.com']) {
    assert.ok(!prompt.includes(pii), `PII leaked: ${pii}`);
  }
  assert.ok(!prompt.includes('@'), 'no email addresses at all');
  assert.ok(!prompt.includes('SECRETHASH1'), 'no password hash');
  assert.ok(!/\busername\b/i.test(prompt) || !prompt.includes('nerdio'), 'no raw username');
});

test('another partner’s evidence never appears', () => {
  const prompt = buildAll({
    transcripts: [...TRANSCRIPTS, { transcript_id: 't9', partner_id: 'p2', conversation_date: '2026-06-01', transcript_text: '<p>OTHER PARTNER SECRET</p>' }],
    events: [...EVENTS, { event_id: 'e9', partner_id: 'p2', title: 'Other', event_date: '2026-05-05', status: 'Completed' }],
  });
  assert.ok(!prompt.includes('OTHER PARTNER SECRET'));
});

// ── Event / forecast vocabulary must NOT appear ──────────────────────
test('no forecast-probability or event-countdown language in the partner prompt', () => {
  const prompt = buildAll();
  assert.ok(!/win probability|forecast bucket|probability to close/i.test(prompt));
  assert.ok(!/days until the event/i.test(prompt));
});

// ── Empty evidence ───────────────────────────────────────────────────
test('empty evidence is handled and stated explicitly', () => {
  const kpis = buildPartnerKpis({ partner: PARTNER, transcripts: [], meetings: [], documents: [], events: [], opportunities: [], today: TODAY });
  const evidence = assemblePartnerEvidence({});
  const prompt = buildPartnerAnalyzerPrompt({ partner: PARTNER, kpis, evidence, contactsAgg: buildContactAggregates([]), today: TODAY });
  assert.ok(prompt.includes('No transcripts exist for this partner'));
  assert.ok(prompt.includes('No partner documents'));
  assert.ok(prompt.includes('No saved event contacts'));
  assert.ok(prompt.includes('Total linked opportunities: 0'));
});

test('handles a null partner / missing args without throwing', () => {
  assert.doesNotThrow(() => buildPartnerAnalyzerPrompt({ today: TODAY }));
  const prompt = buildPartnerAnalyzerPrompt({ today: TODAY });
  assert.ok(prompt.includes('this partner'));
});

// ── Internal helpers ─────────────────────────────────────────────────
test('chronological() sorts evidence oldest-first for display', () => {
  const { chronological } = __partnerPromptInternals;
  const out = chronological([{ date: '2026-06-20' }, { date: '2026-05-01' }, { date: '2026-06-01' }]);
  assert.deepEqual(out.map(x => x.date), ['2026-05-01', '2026-06-01', '2026-06-20']);
});
