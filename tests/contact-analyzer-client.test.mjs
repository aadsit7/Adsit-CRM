// Tests for prepareContactBrief (js/utils/contact-analyzer-client.js) — the
// PURE evidence-assembly half of the client. It must: build the identity
// snapshot from the selected contact, strictly scope partner/deal context to
// the contact's partner_id (never another partner's rows), and fold a prior
// LeadCheck verification in as evidence when present.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepareContactBrief } from '../js/utils/contact-analyzer-client.js';

const CONTACT = {
  contact_id: 'c1', partner_id: 'p1', partner_name: 'Insight',
  name: 'Anna Donnelly', role: 'Product Manager, Services', company: 'Insight',
  email: 'anna.donnelly@insight.com',
  sources: [{ type: 'description', id: 't1', label: '', date: '2026-06-30' }],
  analysis_json: '',
};

const TRANSCRIPTS = [
  { transcript_id: 't1', partner_id: 'p1', transcript_text: '<p>Anna raised Legal / VMO concerns.</p>', conversation_date: '2026-06-30' },
  { transcript_id: 't2', partner_id: 'p2', transcript_text: '<p>Different partner note about Bob.</p>', conversation_date: '2026-06-25' },
];
const OPPORTUNITIES = [
  { opportunity_id: 'o1', partner_id: 'p1', deal_name: 'Managed Endpoint 2.0', stage: 'Negotiation', amount: '600000' },
  { opportunity_id: 'o2', partner_id: 'p2', deal_name: 'Someone Elses Deal', stage: 'Prospect' },
];
const OPP_DESCRIPTIONS = [
  { description_id: 'd1', opportunity_id: 'o1', deal_name: 'Managed Endpoint 2.0', description_text: '<p>$600K Y1 minimum on the table.</p>', description_date: '2026-06-30' },
  { description_id: 'd2', opportunity_id: 'o2', deal_name: 'Someone Elses Deal', description_text: '<p>Unrelated.</p>', description_date: '2026-06-20' },
];

test('builds the identity snapshot from the selected contact', () => {
  const prep = prepareContactBrief({ contact: CONTACT, transcripts: TRANSCRIPTS });
  assert.equal(prep.snapshot.name, 'Anna Donnelly');
  assert.equal(prep.snapshot.email, 'anna.donnelly@insight.com');
  // The contact's linked description source text is pulled in.
  assert.ok(prep.sourceMaterial.some(s => /VMO concerns/.test(s.text)));
});

test('scopes partner & deal context strictly to the contact’s partner', () => {
  const prep = prepareContactBrief({
    contact: CONTACT,
    partner: { partner_id: 'p1', display_name: 'Insight', tier: 'Premier', status: 'active' },
    transcripts: TRANSCRIPTS,
    opportunities: OPPORTUNITIES,
    opportunityDescriptions: OPP_DESCRIPTIONS,
  });
  assert.ok(prep.partnerContext.includes('Managed Endpoint 2.0'));
  assert.ok(prep.partnerContext.includes('$600K Y1 minimum'));
  // Another partner's deal / notes must never leak in.
  assert.ok(!prep.partnerContext.includes('Someone Elses Deal'));
  assert.ok(!prep.partnerContext.includes('Unrelated.'));
  assert.ok(prep.partnerContext.includes('Premier'));
});

test('no prior LeadCheck → hasLeadCheck is false, summary empty', () => {
  const prep = prepareContactBrief({ contact: CONTACT, transcripts: TRANSCRIPTS });
  assert.equal(prep.hasLeadCheck, false);
  assert.equal(prep.leadCheckSummary, '');
});

test('folds a prior LeadCheck verification in as evidence', () => {
  const record = {
    version: 1,
    state: 'COMPLETE',
    report: {
      state: 'COMPLETE',
      profile: { full_name: 'Anna Donnelly', current_employer: 'Insight', current_title: 'Product Manager, Services', title_status: 'CORROBORATED' },
      identity: { match: 'CONFIRMED' },
      confidence: { coverage_pct: 34, overall_score: 6.4, label: 'MEDIUM' },
      email_evaluation: {}, reporting: { reports_to: {}, functional_owner: {}, one_level_up: {} },
      peers: [], direct_reports: { people: [], note: '' }, content_footprint: [], timing_signals: [],
      buying_role: {}, checklist: [], loop_check: {}, compliance_note: 'note',
    },
  };
  const contact = { ...CONTACT, analysis_json: JSON.stringify(record) };
  const prep = prepareContactBrief({ contact, transcripts: TRANSCRIPTS });
  assert.equal(prep.hasLeadCheck, true);
  assert.ok(/LEADCHECK — Anna Donnelly/.test(prep.leadCheckSummary));
  assert.ok(/CONFIRMED/.test(prep.leadCheckSummary));
});
