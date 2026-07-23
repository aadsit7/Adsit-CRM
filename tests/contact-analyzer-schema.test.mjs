// Tests for the Contact Analyzer structural parser
// (js/utils/contact-analyzer-schema.js). Unlike the maturity analyzers this
// validator preserves inference — its job is to guarantee STRUCTURE: enums are
// canonical, scores clamp to 0–10, arrays/strings are bounded, URLs are
// sanitized, a truncated reply is salvaged, and a missing section becomes its
// empty form so the board and PDF always render.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseContactBriefResponse,
  deriveContactBriefBoard,
  extractJsonObject,
  coerceScore,
  canonCoverage,
  canonRisk,
  canonOrgStatus,
  canonClassification,
  sanitizeUrl,
} from '../js/utils/contact-analyzer-schema.js';

function fullBrief() {
  return {
    contact: { name: 'Anna Donnelly', title: 'Product Manager, Services', company: 'Insight' },
    executive_summary: {
      company: 'Insight (Insight Enterprises, Inc.)',
      contact: 'Anna Donnelly — Product Manager, Services',
      primary_icp_bucket: 'Revenue / GTM Owner',
      coverage_status: { level: 'yellow', note: 'economic buyer named but not engaged' },
      account_maturity: 'Stage 6 — Strategic partnership design',
      likely_is: 'The service design and GTM owner.',
      likely_is_not: 'Not the final economic approver.',
      biggest_gap: 'No direct engagement with Joe Flynn.',
      best_next_move: 'Land the executive alignment meeting.',
    },
    contact_assessment: {
      likely_responsibility: 'Owns service design & GTM.',
      confidence: 'Strongly inferred.',
      what_they_care_about: 'Outcome-driven service offering.',
      recast_focus: 'Managed Application Delivery motion.',
    },
    influence_scores: [
      { dimension: 'Technical influence', score: 4, reason: 'Not the validator.' },
      { dimension: 'Commercial influence', score: 8, reason: 'Drives pricing.' },
      { dimension: 'Partner influence', score: 9, reason: 'The sponsor.' },
    ],
    why_this_classification: [
      { level: 'verified', text: 'Employment confirmed via author bio.' },
      { level: 'strong_inference', text: 'GTM owner from the recap.' },
    ],
    missing_stakeholders: [
      { role: 'Joe Flynn — Director', icp_bucket: 'Economic Buyer', why_needed: 'Final approver', recommended_conversation: 'Business case review' },
    ],
    org_map: [
      { name: 'Joe Flynn — Director', status: 'identified', depth: 0 },
      { name: 'Anna Donnelly — PM', status: 'engaged', depth: 1 },
    ],
    account_risk: { overall: 'MODERATE', factors: ['Economic buyer not engaged.'] },
    recommended_next_move: {
      immediate_objective: 'Executive alignment meeting.',
      next_role_to_engage: 'Joe Flynn',
      next_meeting: '30-minute call',
      suggested_ask: 'Can we get 30 minutes with Joe?',
    },
    seller_focus: {
      discuss_now: ['Joe Flynn introduction'],
      do_not_force_yet: ['Hard seat minimum'],
      evidence_to_obtain: ['Cost-to-serve per endpoint'],
    },
    sources: [{ label: 'Insight author bio', url: 'https://www.insight.com/anna-donnelly.html' }],
  };
}

test('parses a full brief into every canonical section', () => {
  const brief = parseContactBriefResponse(JSON.stringify(fullBrief()));
  assert.equal(brief.contact.name, 'Anna Donnelly');
  assert.equal(brief.executive_summary.primary_icp_bucket, 'Revenue / GTM Owner');
  assert.equal(brief.executive_summary.coverage_status.level, 'yellow');
  assert.equal(brief.influence_scores.length, 3);
  assert.equal(brief.influence_scores[1].score, 8);
  assert.equal(brief.missing_stakeholders[0].role, 'Joe Flynn — Director');
  assert.equal(brief.org_map[1].status, 'engaged');
  assert.equal(brief.account_risk.overall, 'MODERATE');
  assert.equal(brief.seller_focus.discuss_now.length, 1);
  assert.equal(brief.sources[0].url, 'https://www.insight.com/anna-donnelly.html');
  assert.equal(brief.partial, false);
});

test('clamps and coerces influence scores to 0–10 integers, null when unparseable', () => {
  const b = fullBrief();
  b.influence_scores = [
    { dimension: 'A', score: 12, reason: '' },
    { dimension: 'B', score: -3, reason: '' },
    { dimension: 'C', score: '7/10', reason: '' },
    { dimension: 'D', score: 4.6, reason: '' },
    { dimension: 'E', score: 'n/a', reason: '' },
  ];
  const brief = parseContactBriefResponse(JSON.stringify(b));
  assert.equal(brief.influence_scores[0].score, 10);
  assert.equal(brief.influence_scores[1].score, 0);
  assert.equal(brief.influence_scores[2].score, 7);
  assert.equal(brief.influence_scores[3].score, 5);
  assert.equal(brief.influence_scores[4].score, null);
});

test('canonicalizes loose enum language', () => {
  assert.equal(canonCoverage('Yellow — partial coverage'), 'yellow');
  assert.equal(canonCoverage('broad and strong'), 'green');
  assert.equal(canonCoverage('single-threaded'), 'red');
  assert.equal(canonCoverage('anything else'), 'yellow');

  assert.equal(canonRisk('Critical'), 'HIGH');
  assert.equal(canonRisk('minimal'), 'LOW');
  assert.equal(canonRisk('MODERATE'), 'MODERATE');
  assert.equal(canonRisk('weird'), 'MODERATE');

  assert.equal(canonOrgStatus('Actively engaged'), 'engaged');
  assert.equal(canonOrgStatus('recently introduced'), 'introduced');
  assert.equal(canonOrgStatus('not in the room'), 'missing');
  assert.equal(canonOrgStatus('name known'), 'identified');

  assert.equal(canonClassification('Verified fact'), 'verified');
  assert.equal(canonClassification('strong inference'), 'strong_inference');
  assert.equal(canonClassification('a guess'), 'inference');
});

test('missing / malformed sections become empty forms — never throws', () => {
  const brief = parseContactBriefResponse(JSON.stringify({ executive_summary: { company: 'Acme' } }));
  assert.equal(brief.executive_summary.company, 'Acme');
  assert.equal(brief.executive_summary.coverage_status.level, 'yellow'); // defaulted
  assert.deepEqual(brief.influence_scores, []);
  assert.deepEqual(brief.missing_stakeholders, []);
  assert.deepEqual(brief.org_map, []);
  assert.deepEqual(brief.seller_focus.discuss_now, []);
  assert.equal(brief.account_risk.overall, 'MODERATE');
});

test('backfills the contact block from context when the model omits it', () => {
  const brief = parseContactBriefResponse(JSON.stringify({ executive_summary: {} }), {
    contact: { name: 'Jane Roe', role: 'CISO', company: 'Globex', partner_name: 'Globex Partners' },
  });
  assert.equal(brief.contact.name, 'Jane Roe');
  assert.equal(brief.contact.title, 'CISO');
  assert.equal(brief.contact.company, 'Globex');
});

test('salvages a reply cut off at the token limit', () => {
  // A valid object truncated mid-array (no closing brackets).
  const truncated = '{"executive_summary":{"company":"Insight","likely_is":"owns GTM"},"influence_scores":[{"dimension":"Commercial influence","score":8,"reason":"drives pricing"';
  const brief = parseContactBriefResponse(truncated, { truncated: true });
  assert.equal(brief.executive_summary.company, 'Insight');
  assert.equal(brief.influence_scores[0].dimension, 'Commercial influence');
  assert.equal(brief.influence_scores[0].score, 8);
  assert.equal(brief.partial, true);
});

test('strips ```json fences and surrounding prose', () => {
  const wrapped = 'Here is the brief:\n```json\n{"executive_summary":{"company":"Insight"}}\n```\nDone.';
  const brief = parseContactBriefResponse(wrapped);
  assert.equal(brief.executive_summary.company, 'Insight');
});

test('sanitizes source URLs — only http(s) survive', () => {
  const b = fullBrief();
  b.sources = [
    { label: 'ok', url: 'https://example.com/a' },
    { label: 'js', url: 'javascript:alert(1)' },
    { label: 'ftp', url: 'ftp://example.com/x' },
    { label: 'label only', url: '' },
  ];
  const brief = parseContactBriefResponse(JSON.stringify(b));
  const urls = brief.sources.map(s => s.url);
  assert.ok(urls.includes('https://example.com/a'));
  assert.ok(!urls.some(u => u.startsWith('javascript:')));
  assert.ok(!urls.some(u => u.startsWith('ftp:')));
  assert.equal(sanitizeUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeUrl('https://ok.com'), 'https://ok.com/');
});

test('caps runaway arrays', () => {
  const b = fullBrief();
  b.influence_scores = Array.from({ length: 40 }, (_, i) => ({ dimension: `D${i}`, score: 5, reason: 'x' }));
  b.org_map = Array.from({ length: 200 }, (_, i) => ({ name: `P${i}`, status: 'identified', depth: 0 }));
  const brief = parseContactBriefResponse(JSON.stringify(b));
  assert.ok(brief.influence_scores.length <= 8);
  assert.ok(brief.org_map.length <= 30);
});

test('empty / non-object input throws a coded error', () => {
  assert.throws(() => parseContactBriefResponse(''), /empty/i);
  assert.throws(() => parseContactBriefResponse('not json at all — no braces'), /parse/i);
});

test('coerceScore unit behavior', () => {
  assert.equal(coerceScore(5), 5);
  assert.equal(coerceScore('8 / 10'), 8);
  assert.equal(coerceScore('99'), 10);
  assert.equal(coerceScore(''), null);
  assert.equal(coerceScore('none'), null);
});

test('extractJsonObject handles clean, fenced, and truncated inputs', () => {
  assert.equal(extractJsonObject('{"a":1}').a, 1);
  assert.equal(extractJsonObject('```json\n{"a":2}\n```').a, 2);
  assert.equal(extractJsonObject('prefix {"a":3} suffix').a, 3);
  assert.equal(extractJsonObject('{"a":4,"b":[1,2').a, 4); // truncated → repaired
  assert.equal(extractJsonObject('no object here'), null);
});

test('deriveContactBriefBoard computes headline conveniences', () => {
  const brief = parseContactBriefResponse(JSON.stringify(fullBrief()));
  const board = deriveContactBriefBoard(brief);
  assert.equal(board.avgInfluence, 7); // (4+8+9)/3 = 7
  assert.equal(board.orgTotal, 2);
  assert.equal(board.orgEngaged, 1);
  assert.equal(board.stakeholderGaps, 1);
});
