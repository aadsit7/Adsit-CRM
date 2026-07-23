// Tests for LeadCheck (js/utils/partner-contact-leadcheck.js) — the
// row-level individual contact analysis. Most tests are adversarial: named
// managers without evidence, invented emails, fabricated direct reports,
// unsupported decision-maker claims, and unresolved identities must all be
// removed or downgraded by the validator, never displayed as verified.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LEADCHECK_CHECKLIST,
  LEADCHECK_COMPLIANCE_NOTE,
  NO_DIRECT_REPORTS_NOTE,
  sanitizeUrl,
  isCorporateEmail,
  assessLeadCheckInput,
  buildLeadCheckSnapshot,
  contactFingerprint,
  analysisIsStale,
  parseAnalysisRecord,
  buildAnalysisRecord,
  shrinkAnalysisRecordToFit,
  verifiedRoleFromAnalysis,
  fingerprintWithRole,
  fingerprintMatchesIgnoringRole,
  applyAnalysisRoleToContact,
  applyAnalysisRoleBackfill,
  leadCheckButtonState,
  buildLeadCheckPrompt,
  parseLeadCheckResponse,
  computeVerificationCoverage,
  confidenceLabelForScore,
  leadCheckReportToPlainText,
} from '../js/utils/partner-contact-leadcheck.js';
import { isHeaderPrefixOf, PARTNER_CONTACT_HEADERS } from '../js/utils/partner-contacts.js';

const NOW = '2026-07-23T10:00:00Z';

const CONTACT = {
  contact_id: 'pct_1',
  partner_id: 'p1',
  partner_name: 'Nerdio',
  name: 'Jane Doe',
  role: 'Director of IT',
  company: 'Acme Corp',
  email: 'jane.doe@acme.com',
  phone: '(555) 123-4567',
  evidence: 'Call with Jane Doe re AVD',
  sources: [{ type: 'description', id: 't1', label: 'Description', date: '2026-06-10' }],
  analysis_state: '', analysis_last_verified: '', analysis_json: '',
};

// A fully valid model response the adversarial tests mutate.
function fullResponse() {
  return {
    state: 'COMPLETE',
    identity: {
      match: 'CONFIRMED', confidence: 'HIGH', notes: 'Matched via employer bio + LinkedIn.',
      sources: [
        { title: 'Acme leadership page', url: 'https://acme.com/leadership', date: '2026-06-01' },
        { title: 'LinkedIn', url: 'https://linkedin.com/in/janedoe', date: '' },
      ],
    },
    profile: {
      full_name: 'Jane Doe', current_employer: 'Acme Corp', current_title: 'Senior Director, Enterprise Technology',
      title_status: 'CONFIRMED', linkedin_url: 'https://linkedin.com/in/janedoe',
      official_bio_url: 'https://acme.com/leadership', location: 'Austin, TX',
      role_start_date: '2024-03', tenure: '~2 years (approximate)', prior_role: 'Director of IT, Acme Corp',
      useful_info: 'Leads enterprise technology programs.',
    },
    education: { education: ['BS, University of Texas'], certifications: [], limitations: 'LinkedIn-only.' },
    presence: [{ platform: 'LinkedIn', url: 'https://linkedin.com/in/janedoe', match_notes: 'Employer + title match' }],
    email_evaluation: {
      email: 'jane.doe@acme.com', source: 'supplied row', status: 'PATTERN_CONSISTENT',
      dominant_format: 'first.last@acme.com', format_evidence: 'https://acme.com/contact',
      confidence: 'MEDIUM', rationale: 'Format matches employer pattern.', limitation: '',
    },
    content_footprint: [
      { title: 'Endpoint modernization talk', type: 'talk', publication: 'TechConf', date: '2026-05-01', recency: 'CURRENT', role: 'Speaker', relevance: 'Owns endpoint strategy.', url: 'https://techconf.com/talk' },
    ],
    themes: [
      { name: 'Endpoint modernization', supporting: ['Endpoint modernization talk'], urls: ['https://techconf.com/talk', 'https://blog.acme.com/post'], explanation: 'Recurs across talks.', confidence: 'SUPPORTED' },
    ],
    post_insights: {
      posts_reviewed: 6, date_range: 'Feb-Jul 2026', topics: ['Intune'],
      colleagues: [{ name: 'Sam Reyes', title: 'IT Manager, Acme Corp', relationship: 'LIKELY_COLLABORATOR', evidence_url: 'https://linkedin.com/posts/x' }],
      engagement_clues: 'Frequent co-commenting.', limitation: '',
    },
    function_profile: {
      primary_function: 'Information Technology',
      verified_responsibilities: ['Leads enterprise technology programs'],
      interpreted_responsibilities: ['Appears to oversee endpoint tooling decisions'],
      exclusions: 'No budget-authority claims — no public source.',
    },
    buying_role: {
      classification: 'DECISION_MAKER', confidence: 'MEDIUM',
      rationale: 'Bio states she owns technology vendor selection.',
      purchase_relevance: ['Endpoint management'], likely_involvement: 'Executive sponsor',
      evidence_urls: ['https://acme.com/leadership'], limitation: '',
    },
    reporting: {
      reports_to: { name: 'Chris Founder', title: 'CIO', linkedin_url: 'https://linkedin.com/in/chrisfounder', label: 'CONFIRMED', evidence_url: 'https://acme.com/press/jane-appointed', confidence: 'HIGH' },
      functional_owner: { name: '', title: '', linkedin_url: '', label: 'UNKNOWN', evidence_url: '', confidence: 'LOW' },
      one_level_up: { generic_role: 'Likely a CIO-level executive', status: 'GENERIC_INFERENCE', rationale: 'Title level.', limitation: '' },
    },
    upward_mapping: [
      { person_or_role: 'Chris Founder', title: 'CIO', relationship_type: 'Reports to', linkedin_url: '', evidence_url: 'https://acme.com/press/jane-appointed', confidence: 'HIGH' },
    ],
    peers: [
      { name: 'Pat Peer', title: 'Senior Director, Security', linkedin_url: '', relationship: 'CONFIRMED_PEER', evidence_url: 'https://acme.com/leadership', confidence: 'MEDIUM' },
    ],
    direct_reports: { people: [], note: NO_DIRECT_REPORTS_NOTE },
    timing_signals: [
      { event: 'Promoted to Senior Director', date: '2026-03-01', relevance: 'Expanded scope', url: 'https://acme.com/press/jane-appointed' },
    ],
    checklist: LEADCHECK_CHECKLIST.map(c => ({ key: c.key, result: 'PASS' })),
    confidence: { overall_score: 9.1, rationale: 'Strong multi-source confirmation.', sources_summary: 'Employer site, LinkedIn, press.', gaps: [], flagged: [] },
    loop_check: { queries_repeated: ['"Jane Doe" "Acme Corp"'], engines: ['web_search'], newer_evidence_found: false, conflicts_found: false, result: '', checked_at: '' },
  };
}

const parse = (obj) => parseLeadCheckResponse(JSON.stringify(obj), { contact: CONTACT, nowIso: NOW });

// ── URL & email helpers ──────────────────────────────────────────────
test('sanitizeUrl: only plain http(s) survives', () => {
  assert.equal(sanitizeUrl('https://a.com/x'), 'https://a.com/x');
  assert.equal(sanitizeUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeUrl('data:text/html,x'), '');
  assert.equal(sanitizeUrl('linkedin.com/in/x'), '');
  assert.equal(sanitizeUrl(''), '');
});

test('isCorporateEmail distinguishes free-mail domains', () => {
  assert.equal(isCorporateEmail('a@acme.com'), true);
  assert.equal(isCorporateEmail('a@gmail.com'), false);
  assert.equal(isCorporateEmail('not-an-email'), false);
});

// ── Pre-analysis validation ──────────────────────────────────────────
test('sufficiency gate: the spec combinations', () => {
  assert.equal(assessLeadCheckInput({ name: 'Jane Doe', company: 'Acme' }).sufficient, true);
  assert.equal(assessLeadCheckInput({ name: 'Jane Doe', role: 'CTO' }).sufficient, true);
  assert.equal(assessLeadCheckInput({ name: 'Jane Doe', email: 'j@acme.com' }).sufficient, true);
  assert.equal(assessLeadCheckInput({ name: '', email: 'j@acme.com' }).sufficient, true);
  assert.equal(assessLeadCheckInput({ name: 'Jane Doe' }, { hasLinkedSourceText: true }).sufficient, true);
  // Insufficient: common name alone, personal email alone, single-word name.
  const bare = assessLeadCheckInput({ name: 'Jane Doe' });
  assert.equal(bare.sufficient, false);
  assert.ok(bare.missing.includes('Employer'));
  assert.equal(assessLeadCheckInput({ name: 'Jane Doe', email: 'j@gmail.com' }).sufficient, false);
  assert.equal(assessLeadCheckInput({ name: 'Madhu', company: '' , role: '' }).sufficient, false);
});

// ── Snapshot ─────────────────────────────────────────────────────────
test('snapshot: excludes phone from the research payload entirely', () => {
  const { snapshot } = buildLeadCheckSnapshot({ contact: CONTACT });
  assert.equal('phone' in snapshot, false);
  const prompt = buildLeadCheckPrompt({ snapshot, sourceMaterial: [], nowIso: NOW });
  assert.ok(!prompt.includes('555'));
  assert.ok(!prompt.includes('123-4567'));
});

test('snapshot: resolves linked CRM source text, strips HTML', () => {
  const { sourceMaterial, hasLinkedSourceText } = buildLeadCheckSnapshot({
    contact: CONTACT,
    transcripts: [{ transcript_id: 't1', transcript_text: '<p>Jane Doe (Director of IT, Acme Corp) joined the partnership call.</p>' }],
  });
  assert.equal(hasLinkedSourceText, true);
  assert.ok(sourceMaterial[0].text.includes('Jane Doe'));
  assert.ok(!sourceMaterial[0].text.includes('<p>'));
});

// ── Prompt ───────────────────────────────────────────────────────────
test('prompt: carries the workflow rules and untrusted-data guard', () => {
  const { snapshot, sourceMaterial } = buildLeadCheckSnapshot({
    contact: CONTACT,
    transcripts: [{ transcript_id: 't1', transcript_text: 'Jane Doe at Acme.' }],
  });
  const p = buildLeadCheckPrompt({ snapshot, sourceMaterial, nowIso: NOW, timezone: 'UTC' });
  for (const needle of [
    'Analyze the selected INDIVIDUAL only',
    'UNTRUSTED DATA',
    'NEEDS_MORE_INFORMATION',
    'AMBIGUOUS or NOT_VERIFIED',
    'Never silently resolve a conflict',
    NO_DIRECT_REPORTS_NOTE,
    'FINAL LOOPED VERIFICATION',
    'STRICT JSON only',
    'identity_matched',
    'timing_signal_found',
    'Jane Doe',
  ]) {
    assert.ok(p.includes(needle), `prompt missing: ${needle}`);
  }
});

// ── Validator: clean report ──────────────────────────────────────────
test('parse: a fully evidenced report survives as COMPLETE', () => {
  const r = parse(fullResponse());
  assert.equal(r.state, 'COMPLETE');
  assert.equal(r.identity.match, 'CONFIRMED');
  assert.equal(r.profile.title_status, 'CONFIRMED');
  assert.equal(r.reporting.reports_to.name, 'Chris Founder');
  assert.equal(r.peers.length, 1);
  assert.equal(r.confidence.coverage_pct, 100);
  assert.equal(r.confidence.label, 'HIGH');
  assert.equal(r.compliance_note, LEADCHECK_COMPLIANCE_NOTE);
});

// ── Validator: adversarial cases ─────────────────────────────────────
test('parse: a named manager without evidence URL is removed and downgraded', () => {
  const resp = fullResponse();
  resp.reporting.reports_to = { name: 'Invented Boss', title: 'CIO', linkedin_url: '', label: 'CONFIRMED', evidence_url: '', confidence: 'HIGH' };
  const r = parse(resp);
  assert.equal(r.reporting.reports_to.name, '');
  assert.equal(r.reporting.reports_to.label, 'UNKNOWN');
  assert.ok(r.reporting.reports_to.note.includes('no public evidence URL'));
});

test('parse: GENERIC_INFERENCE may never carry a person name', () => {
  const resp = fullResponse();
  resp.reporting.reports_to = { name: 'Someone Guessed', title: 'VP', linkedin_url: '', label: 'GENERIC_INFERENCE', evidence_url: 'https://acme.com/x', confidence: 'LOW' };
  const r = parse(resp);
  assert.equal(r.reporting.reports_to.name, '');
  assert.equal(r.reporting.reports_to.label, 'GENERIC_INFERENCE');
});

test('parse: peers, direct reports, content, and timing signals require evidence URLs', () => {
  const resp = fullResponse();
  resp.peers.push({ name: 'No Evidence Peer', title: 'Director', relationship: 'CONFIRMED_PEER', evidence_url: '', confidence: 'HIGH' });
  resp.direct_reports = { people: [
    { name: 'Fake Report', title: 'Analyst', label: 'CONFIRMED', evidence_url: '', confidence: 'HIGH' },
  ], note: '' };
  resp.content_footprint.push({ title: 'No URL item', type: 'article', publication: '', date: '2026-01-01', recency: 'CURRENT', role: 'Author', relevance: '', url: '' });
  resp.timing_signals.push({ event: 'Unevidenced award', date: '2026-01-01', relevance: '', url: 'javascript:alert(1)' });
  const r = parse(resp);
  assert.equal(r.peers.length, 1);
  assert.equal(r.direct_reports.people.length, 0);
  assert.equal(r.direct_reports.note, NO_DIRECT_REPORTS_NOTE);
  assert.equal(r.content_footprint.length, 1);
  assert.equal(r.timing_signals.length, 1);
});

test('parse: unresolved identity strips ALL organizational conclusions', () => {
  const resp = fullResponse();
  resp.identity.match = 'AMBIGUOUS';
  const r = parse(resp);
  assert.equal(r.state, 'NEEDS_REVIEW');
  assert.equal(r.reporting.reports_to.name, '');
  assert.equal(r.reporting.reports_to.label, 'UNKNOWN');
  assert.deepEqual(r.peers, []);
  assert.deepEqual(r.upward_mapping, []);
  assert.equal(r.direct_reports.people.length, 0);
  assert.equal(r.buying_role.classification, 'UNKNOWN');
});

test('parse: CONFIRMED identity without any source URL is downgraded', () => {
  const resp = fullResponse();
  resp.identity.sources = [{ title: 'nope', url: 'not-a-url', date: '' }];
  const r = parse(resp);
  assert.equal(r.identity.match, 'PROBABLE');
});

test('parse: identity with no public URLs anywhere is NOT_VERIFIED and gated', () => {
  const resp = fullResponse();
  resp.identity.sources = [];
  resp.profile.linkedin_url = '';
  resp.profile.official_bio_url = '';
  const r = parse(resp);
  assert.equal(r.identity.match, 'NOT_VERIFIED');
  assert.equal(r.state, 'NEEDS_REVIEW');
  assert.equal(r.buying_role.classification, 'UNKNOWN');
});

test('parse: DECISION_MAKER without evidence URLs downgrades to INFLUENCER', () => {
  const resp = fullResponse();
  resp.buying_role.evidence_urls = [];
  const r = parse(resp);
  assert.equal(r.buying_role.classification, 'INFLUENCER');
  assert.ok(r.buying_role.limitation.includes('Downgraded from DECISION_MAKER'));
});

test('parse: a different email than supplied is reset unless publicly confirmed', () => {
  const resp = fullResponse();
  resp.email_evaluation.email = 'invented@other.com';
  resp.email_evaluation.status = 'PATTERN_CONSISTENT';
  const r = parse(resp);
  assert.equal(r.email_evaluation.email, 'jane.doe@acme.com');
});

test('parse: with no supplied email, an unconfirmed address is never revealed', () => {
  const noEmailContact = { ...CONTACT, email: '' };
  const resp = fullResponse();
  resp.email_evaluation.email = 'guessed@acme.com';
  resp.email_evaluation.status = 'PATTERN_CONSISTENT';
  const r = parseLeadCheckResponse(JSON.stringify(resp), { contact: noEmailContact, nowIso: NOW });
  assert.equal(r.email_evaluation.email, '');
  assert.equal(r.email_evaluation.status, 'NOT_EVALUATED');
  // …and the checklist marks the email item NOT_APPLICABLE for coverage.
  assert.equal(r.checklist.find(c => c.key === 'email_evaluated').result, 'NOT_APPLICABLE');
});

test('parse: themes need URLs; single-URL themes are forced TENTATIVE', () => {
  const resp = fullResponse();
  resp.themes = [
    { name: 'No URL theme', supporting: [], urls: [], explanation: '', confidence: 'SUPPORTED' },
    { name: 'One URL theme', supporting: [], urls: ['https://a.com'], explanation: '', confidence: 'SUPPORTED' },
  ];
  const r = parse(resp);
  assert.equal(r.themes.length, 1);
  assert.equal(r.themes[0].confidence, 'TENTATIVE');
});

test('parse: conflicts set CONFLICT_FOUND and FLAG the confidence label', () => {
  const resp = fullResponse();
  resp.profile.title_status = 'CONFLICTING';
  const r = parse(resp);
  assert.equal(r.state, 'CONFLICT_FOUND');
  assert.equal(r.confidence.label, 'FLAGGED');
  assert.ok(r.confidence.flagged.some(f => f.includes('conflict') || f.includes('Conflict') || f.includes('sources conflict')));
});

test('parse: checklist is canonicalized and coverage recomputed (never trusted)', () => {
  const resp = fullResponse();
  resp.checklist = [
    { key: 'identity_matched', result: 'PASS' },
    { key: 'employer_confirmed', result: 'PARTIAL' },
    { key: 'made_up_key', result: 'PASS' },
    { key: 'location_supported', result: 'NOT_APPLICABLE' },
  ];
  resp.confidence.overall_score = 22; // absurd — must clamp
  const r = parse(resp);
  assert.equal(r.checklist.length, LEADCHECK_CHECKLIST.length);
  assert.equal(r.checklist.find(c => c.key === 'tenure_supported').result, 'NOT_FOUND');
  assert.equal(r.checklist.some(c => c.key === 'made_up_key'), false);
  // applicable = 22 - 1 N/A = 21; pass 1 + 0.5×1 = 1.5 → 7%
  assert.equal(r.confidence.coverage_pct, 7);
  assert.equal(r.confidence.overall_score, 10);
  assert.equal(r.state, 'COMPLETE_WITH_GAPS');
});

test('parse: NEEDS_MORE_INFORMATION short-circuits with the missing list', () => {
  const r = parse({ state: 'NEEDS_MORE_INFORMATION', missing_information: ['Employer', 'Work email'] });
  assert.equal(r.state, 'NEEDS_MORE_INFORMATION');
  assert.deepEqual(r.missing_information, ['Employer', 'Work email']);
  assert.equal(r.compliance_note, LEADCHECK_COMPLIANCE_NOTE);
});

test('parse: loop check gets defaults anchored to the provided timestamp', () => {
  const r = parse(fullResponse());
  assert.ok(r.loop_check.result.includes('No conflicting public data found as of 2026-07-23T10:00:00Z'));
  assert.equal(r.loop_check.checked_at, NOW);
});

test('parse: malformed payloads throw coded errors', () => {
  assert.throws(() => parseLeadCheckResponse('', { contact: CONTACT }), (e) => e.code === 'LEADCHECK_EMPTY');
  assert.throws(() => parseLeadCheckResponse('nope', { contact: CONTACT }), (e) => e.code === 'LEADCHECK_INVALID');
});

// ── Coverage & label math ────────────────────────────────────────────
test('computeVerificationCoverage: spec formula', () => {
  const { pct, calc } = computeVerificationCoverage([
    { result: 'PASS' }, { result: 'PASS' }, { result: 'PARTIAL' },
    { result: 'FAIL' }, { result: 'NOT_FOUND' }, { result: 'NOT_APPLICABLE' },
  ]);
  // (2 + 0.5) / 5 × 100 = 50
  assert.equal(pct, 50);
  assert.ok(calc.includes('÷ 5'));
});

test('confidenceLabelForScore: bands + FLAGGED override', () => {
  assert.equal(confidenceLabelForScore(9.2, false), 'HIGH');
  assert.equal(confidenceLabelForScore(6, false), 'MEDIUM');
  assert.equal(confidenceLabelForScore(3, false), 'LOW');
  assert.equal(confidenceLabelForScore(9.9, true), 'FLAGGED');
});

// ── Button-state machine ─────────────────────────────────────────────
test('button state: in-flight, view, review, add-info, and recovery transitions', () => {
  const today = '2026-07-23';
  assert.equal(leadCheckButtonState(CONTACT, { inFlight: true }).kind, 'analyzing');
  assert.equal(leadCheckButtonState(CONTACT, { todayIso: today }).kind, 'analyze');

  const done = {
    ...CONTACT,
    analysis_state: 'COMPLETE',
    analysis_last_verified: '2026-07-20T00:00:00Z',
    analysis_json: JSON.stringify(buildAnalysisRecord({ state: 'COMPLETE', report: {}, fingerprint: contactFingerprint(CONTACT), analyzedAtIso: '2026-07-20T00:00:00Z' })),
  };
  const view = leadCheckButtonState(done, { todayIso: today });
  assert.equal(view.kind, 'view');
  assert.equal(view.label, 'View Analysis');
  assert.equal(view.stale, false);
  assert.ok(view.tooltip.includes('Last verified 2026-07-20'));

  // Fingerprint change is surfaced.
  const edited = { ...done, role: 'VP of Platform' };
  assert.equal(leadCheckButtonState(edited, { todayIso: today }).changed, true);

  // Staleness beyond the freshness window.
  const old = { ...done, analysis_last_verified: '2026-01-01T00:00:00Z', analysis_json: JSON.stringify(buildAnalysisRecord({ state: 'COMPLETE', report: {}, fingerprint: contactFingerprint(CONTACT), analyzedAtIso: '2026-01-01T00:00:00Z' })) };
  assert.equal(leadCheckButtonState(old, { todayIso: today }).stale, true);

  assert.equal(leadCheckButtonState({ ...done, analysis_state: 'CONFLICT_FOUND' }, { todayIso: today }).kind, 'review');
  assert.equal(leadCheckButtonState({ ...done, analysis_state: 'NEEDS_REVIEW' }, { todayIso: today }).label, 'Review');

  // NEEDS_MORE_INFORMATION: Add Info while insufficient, back to Analyze
  // once the row gains identity fields.
  const nmiBare = { contact_id: 'x', name: 'Jane Doe', role: '', company: '', email: '', analysis_state: 'NEEDS_MORE_INFORMATION', analysis_json: '', analysis_last_verified: '' };
  assert.equal(leadCheckButtonState(nmiBare, { todayIso: today }).kind, 'add_info');
  const nmiFixed = { ...nmiBare, company: 'Acme Corp' };
  assert.equal(leadCheckButtonState(nmiFixed, { todayIso: today }).kind, 'analyze');

  assert.equal(leadCheckButtonState({ ...CONTACT, analysis_state: 'FAILED' }, { todayIso: today }).kind, 'analyze');
});

// ── Record persistence helpers ───────────────────────────────────────
test('analysis record: build/parse round-trip and staleness math', () => {
  const rec = buildAnalysisRecord({ state: 'COMPLETE', report: { a: 1 }, fingerprint: 'fp', analyzedAtIso: NOW });
  const back = parseAnalysisRecord(JSON.stringify(rec));
  assert.equal(back.state, 'COMPLETE');
  assert.equal(back.fingerprint, 'fp');
  assert.equal(parseAnalysisRecord('{broken'), null);
  assert.equal(analysisIsStale('2026-07-01T00:00:00Z', '2026-07-23T00:00:00Z', 30), false);
  assert.equal(analysisIsStale('2026-05-01T00:00:00Z', '2026-07-23T00:00:00Z', 30), true);
  assert.equal(analysisIsStale('', '2026-07-23', 30), true);
});

test('shrinkAnalysisRecordToFit reduces an oversized record under the cap', () => {
  const report = parse(fullResponse());
  report.content_footprint = Array.from({ length: 5 }, (_, i) => ({
    title: `T${i} ${'x'.repeat(180)}`, type: 'article', publication: 'P', date: '2026-01-01',
    recency: 'CURRENT', role: 'Author', relevance: 'r'.repeat(280), url: `https://a.com/${i}`,
  }));
  const rec = buildAnalysisRecord({ state: 'COMPLETE', report, fingerprint: 'fp', analyzedAtIso: NOW });
  const shrunk = shrinkAnalysisRecordToFit(rec, 6000);
  assert.ok(JSON.stringify(shrunk).length <= 6000);
  assert.ok(shrunk.report.confidence.gaps.some(g => g.includes('trimmed')));
  // An in-cap record is returned untouched.
  assert.equal(shrinkAnalysisRecordToFit(rec, 500_000), rec);
});

// ── Plain-text serialization ─────────────────────────────────────────
test('plain-text report carries the key verified facts and compliance note', () => {
  const text = leadCheckReportToPlainText(parse(fullResponse()), CONTACT);
  assert.ok(text.includes('LEADCHECK — Jane Doe'));
  assert.ok(text.includes('Reports to: Chris Founder'));
  assert.ok(text.includes(NO_DIRECT_REPORTS_NOTE));
  assert.ok(text.includes(LEADCHECK_COMPLIANCE_NOTE));
});

// ── Verified-role write-back ─────────────────────────────────────────
// The one narrow row write an analysis may make: a verified title fills
// an EMPTY Role field. Everything else must refuse.

// Run the real pipeline: mutate the model response, parse it under the
// given contact, and persist it the way runLeadCheck does (fingerprint of
// the contact as analyzed).
function recordFor(contact, mutate) {
  const response = fullResponse();
  if (mutate) mutate(response);
  const report = parseLeadCheckResponse(JSON.stringify(response), { contact, nowIso: NOW });
  return buildAnalysisRecord({
    state: report.state, report, fingerprint: contactFingerprint(contact), analyzedAtIso: NOW,
  });
}

test('verifiedRoleFromAnalysis: multi-source title on a CONFIRMED identity, completed run', () => {
  const contact = { ...CONTACT, role: '' };
  assert.equal(verifiedRoleFromAnalysis(recordFor(contact)), 'Senior Director, Enterprise Technology');

  // COMPLETE_WITH_GAPS with a CORROBORATED title still writes (low
  // checklist coverage is not a correctness problem for the title itself).
  const gaps = recordFor(contact, r => {
    r.profile.title_status = 'CORROBORATED';
    r.checklist = LEADCHECK_CHECKLIST.map(c => ({ key: c.key, result: 'NOT_FOUND' }));
  });
  assert.equal(gaps.state, 'COMPLETE_WITH_GAPS');
  assert.equal(verifiedRoleFromAnalysis(gaps), 'Senior Director, Enterprise Technology');
});

test('verifiedRoleFromAnalysis: every failed gate returns empty', () => {
  const contact = { ...CONTACT, role: '' };
  // Identity below CONFIRMED — could be a different person with this name.
  assert.equal(verifiedRoleFromAnalysis(recordFor(contact, r => { r.identity.match = 'PROBABLE'; })), '');
  // Single-source / unverified titles never write.
  assert.equal(verifiedRoleFromAnalysis(recordFor(contact, r => { r.profile.title_status = 'SINGLE_SOURCE'; })), '');
  assert.equal(verifiedRoleFromAnalysis(recordFor(contact, r => { r.profile.title_status = 'UNKNOWN'; })), '');
  // A conflicting title forces CONFLICT_FOUND — doubly refused.
  const conflict = recordFor(contact, r => { r.profile.title_status = 'CONFLICTING'; });
  assert.equal(conflict.state, 'CONFLICT_FOUND');
  assert.equal(verifiedRoleFromAnalysis(conflict), '');
  // Gated identity (NEEDS_REVIEW) never writes.
  const gated = recordFor(contact, r => { r.identity.match = 'AMBIGUOUS'; });
  assert.equal(gated.state, 'NEEDS_REVIEW');
  assert.equal(verifiedRoleFromAnalysis(gated), '');
  // No identified title, nothing to write.
  assert.equal(verifiedRoleFromAnalysis(recordFor(contact, r => { r.profile.current_title = ''; })), '');
  // Records without a report (FAILED / paused) never write.
  assert.equal(verifiedRoleFromAnalysis(buildAnalysisRecord({
    state: 'FAILED', error: 'boom', fingerprint: contactFingerprint(contact), analyzedAtIso: NOW,
  })), '');
  assert.equal(verifiedRoleFromAnalysis(buildAnalysisRecord({
    state: 'NEEDS_MORE_INFORMATION', missing: ['Employer'], fingerprint: contactFingerprint(contact), analyzedAtIso: NOW,
  })), '');
  assert.equal(verifiedRoleFromAnalysis(null), '');
});

test('verifiedRoleFromAnalysis: survives the shrink-to-fit last resort', () => {
  const contact = { ...CONTACT, role: '' };
  const shrunk = shrinkAnalysisRecordToFit(recordFor(contact), 500);
  assert.equal(verifiedRoleFromAnalysis(shrunk), 'Senior Director, Enterprise Technology');
});

test('applyAnalysisRoleToContact: fills only an EMPTY role, fingerprint kept in sync', () => {
  const contact = { ...CONTACT, role: '' };
  const record = recordFor(contact);
  const filled = applyAnalysisRoleToContact(contact, record, NOW);
  assert.equal(filled, 'Senior Director, Enterprise Technology');
  assert.equal(contact.role, 'Senior Director, Enterprise Technology');
  assert.equal(contact.updated_at, NOW);
  // The stored fingerprint now matches the filled row exactly, so the
  // fill can never raise a false "fields changed — re-analyze" flag.
  assert.equal(record.fingerprint, contactFingerprint(contact));
  const persisted = {
    ...contact, analysis_state: record.state,
    analysis_last_verified: NOW, analysis_json: JSON.stringify(record),
  };
  const st = leadCheckButtonState(persisted, { todayIso: NOW });
  assert.equal(st.kind, 'view');
  assert.equal(st.changed, false);

  // A role already on file — user-entered or previously filled — is
  // NEVER overwritten, even by a fully confirmed analysis.
  const kept = { ...CONTACT, role: 'Director of IT' };
  const rec2 = recordFor(kept);
  const before = rec2.fingerprint;
  assert.equal(applyAnalysisRoleToContact(kept, rec2, NOW), '');
  assert.equal(kept.role, 'Director of IT');
  assert.equal(rec2.fingerprint, before);
});

test('applyAnalysisRoleToContact: refuses a row whose identity fields changed', () => {
  const analyzed = { ...CONTACT, role: '' };
  // Renamed since the analysis — the report may describe someone else.
  const renamed = { ...analyzed, name: 'Janet Doe' };
  assert.equal(applyAnalysisRoleToContact(renamed, recordFor(analyzed), NOW), '');
  assert.equal(renamed.role, '');
  // Same guard for a changed company or email.
  const moved = { ...analyzed, company: 'Other Corp' };
  assert.equal(applyAnalysisRoleToContact(moved, recordFor(analyzed), NOW), '');
  // The role part of the fingerprint is deliberately ignored: an analysis
  // run while the row still had a role may fill it after it was cleared,
  // as long as name/company/email are unchanged.
  const hadRole = { ...CONTACT };
  const clearedNow = { ...CONTACT, role: '' };
  assert.equal(applyAnalysisRoleToContact(clearedNow, recordFor(hadRole), NOW), 'Senior Director, Enterprise Technology');
  // Malformed fingerprints refuse rather than guess.
  assert.equal(fingerprintMatchesIgnoringRole('not-a-fingerprint', analyzed), false);
  assert.equal(fingerprintWithRole('not-a-fingerprint', 'X'), 'not-a-fingerprint');
});

test('applyAnalysisRoleBackfill: fills eligible stored rows once, idempotent', () => {
  const eligible = { ...CONTACT, role: '' };
  eligible.analysis_json = JSON.stringify(recordFor(eligible));
  const taken = { ...CONTACT, contact_id: 'pct_2', role: 'Director of IT' };
  taken.analysis_json = JSON.stringify(recordFor(taken));
  const unanalyzed = { ...CONTACT, contact_id: 'pct_3', role: '', analysis_json: '' };
  const broken = { ...CONTACT, contact_id: 'pct_4', role: '', analysis_json: '{broken' };

  const contacts = [eligible, taken, unanalyzed, broken];
  const changed = applyAnalysisRoleBackfill(contacts, NOW);
  assert.deepEqual(changed, [eligible]);
  assert.equal(eligible.role, 'Senior Director, Enterprise Technology');
  assert.equal(eligible.updated_at, NOW);
  // analysis_json was re-serialized with the role-synced fingerprint.
  assert.equal(parseAnalysisRecord(eligible.analysis_json).fingerprint, contactFingerprint(eligible));
  assert.equal(taken.role, 'Director of IT');
  assert.equal(unanalyzed.role, '');
  assert.equal(broken.role, '');
  // Second pass: nothing left to fill.
  assert.deepEqual(applyAnalysisRoleBackfill(contacts, NOW), []);
});

// ── Header prefix extension (sheet schema growth) ────────────────────
test('isHeaderPrefixOf: accepts the 14→17 column growth, rejects divergence', () => {
  const old14 = PARTNER_CONTACT_HEADERS.slice(0, 14);
  assert.equal(isHeaderPrefixOf(old14, PARTNER_CONTACT_HEADERS), true);
  assert.equal(isHeaderPrefixOf([...old14, ''], PARTNER_CONTACT_HEADERS), true); // trailing blank ignored
  assert.equal(isHeaderPrefixOf(PARTNER_CONTACT_HEADERS, PARTNER_CONTACT_HEADERS), false); // equal → nothing to extend
  assert.equal(isHeaderPrefixOf(['contact_id', 'wrong'], PARTNER_CONTACT_HEADERS), false);
  assert.equal(isHeaderPrefixOf([], PARTNER_CONTACT_HEADERS), false);
});
