// Unit tests for js/utils/contact-analyzer-pdf-builder.js.
// Uses a minimal jsPDF shim (same shape as the sibling PDF suites, plus
// getTextWidth which this builder uses for inline bold labels) and asserts the
// public surface: a safe filename, the branded header, every brief section, and
// that a sparse / empty brief renders without throwing.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  slugName,
  contactBriefFilename,
  waitForJsPdf,
  buildContactBriefPdf,
} from '../js/utils/contact-analyzer-pdf-builder.js';
import { parseContactBriefResponse } from '../js/utils/contact-analyzer-schema.js';

// ── slug + filename ──────────────────────────────────────────
test('slugName strips punctuation, falls back to "contact"', () => {
  assert.equal(slugName('Anna Donnelly, Inc.!'), 'Anna_Donnelly_Inc');
  assert.equal(slugName(''), 'contact');
  assert.equal(slugName(null), 'contact');
});

test('contactBriefFilename produces Account_Brief_{slug}_{date}.pdf', () => {
  assert.equal(contactBriefFilename('Anna Donnelly', '2026-07-23'), 'Account_Brief_Anna_Donnelly_2026-07-23.pdf');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(contactBriefFilename('Anna', 'bad'), `Account_Brief_Anna_${today}.pdf`);
});

test('waitForJsPdf throws a clear timeout when jsPDF is missing', async () => {
  delete globalThis.window?.jspdf;
  if (globalThis.window) delete globalThis.window.jsPDF;
  await assert.rejects(
    () => waitForJsPdf({ timeoutMs: 30, pollMs: 10 }),
    (err) => /jsPDF/i.test(err.message) && /didn't finish loading/i.test(err.message),
  );
});

// ── jsPDF shim ───────────────────────────────────────────────
function installJsPdfShim() {
  const calls = [];
  function Shim() {
    this._pages = 1;
    this._page = 1;
    this.internal = { getNumberOfPages: () => this._pages };
    this.setFillColor = (...a) => calls.push({ op: 'setFillColor', a });
    this.setDrawColor = (...a) => calls.push({ op: 'setDrawColor', a });
    this.setTextColor = (...a) => calls.push({ op: 'setTextColor', a });
    this.setFont = (...a) => calls.push({ op: 'setFont', a });
    this.setFontSize = (...a) => calls.push({ op: 'setFontSize', a });
    this.setLineWidth = (...a) => calls.push({ op: 'setLineWidth', a });
    this.rect = (...a) => calls.push({ op: 'rect', a });
    this.roundedRect = (...a) => calls.push({ op: 'roundedRect', a });
    this.circle = (...a) => calls.push({ op: 'circle', a });
    this.line = (...a) => calls.push({ op: 'line', a });
    this.text = (...a) => calls.push({ op: 'text', a });
    this.getTextWidth = (t) => String(t == null ? '' : t).length * 5;
    this.addPage = (...a) => { this._pages += 1; this._page = this._pages; calls.push({ op: 'addPage', a }); };
    this.setPage = (p) => { this._page = p; calls.push({ op: 'setPage', a: [p] }); };
    this.splitTextToSize = (text, maxW) => {
      const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
      if (!words.length) return [''];
      const maxChars = Math.max(1, Math.floor(Number(maxW || 500) / 5));
      const lines = [];
      let cur = '';
      for (const w of words) {
        const candidate = cur ? `${cur} ${w}` : w;
        if (candidate.length > maxChars && cur) { lines.push(cur); cur = w; }
        else cur = candidate;
      }
      if (cur) lines.push(cur);
      return lines;
    };
    this.output = (kind) => (kind === 'blob'
      ? { _isBlob: true, type: 'application/pdf', size: 256, __calls: calls, __pages: this._pages }
      : '');
  }
  globalThis.window = globalThis.window || {};
  globalThis.window.jspdf = { jsPDF: Shim };
  return calls;
}

function textStrings(calls) {
  return calls
    .filter(c => c.op === 'text')
    .map(c => Array.isArray(c.a?.[0]) ? c.a[0].join(' ') : String(c.a?.[0] ?? ''));
}
function hasText(calls, re) { return textStrings(calls).some(t => re.test(t)); }

function sampleBrief() {
  return parseContactBriefResponse(JSON.stringify({
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
    sources: [{ label: 'Insight author bio', url: 'https://www.insight.com/anna.html' }],
  }));
}

test('returns an application/pdf blob', async () => {
  installJsPdfShim();
  const blob = await buildContactBriefPdf({ brief: sampleBrief() });
  assert.equal(blob.type, 'application/pdf');
  assert.ok(blob.size > 0);
});

test('renders the branded header and every brief section', async () => {
  const calls = installJsPdfShim();
  await buildContactBriefPdf({ brief: sampleBrief() });
  assert.ok(hasText(calls, /ACCOUNT INTELLIGENCE BRIEF/), 'header eyebrow');
  assert.ok(hasText(calls, /Anna Donnelly/), 'contact name');
  assert.ok(hasText(calls, /CONFIDENTIAL/), 'confidential note');
  assert.ok(hasText(calls, /EXECUTIVE SUMMARY/), 'exec summary heading');
  assert.ok(hasText(calls, /CONTACT ASSESSMENT/), 'assessment heading');
  assert.ok(hasText(calls, /INFLUENCE SCORES/), 'influence heading');
  assert.ok(hasText(calls, /4\/10/), 'a score');
  assert.ok(hasText(calls, /WHY THIS CLASSIFICATION/), 'classification heading');
  assert.ok(hasText(calls, /MISSING STAKEHOLDER MAP/), 'stakeholder heading');
  assert.ok(hasText(calls, /LIKELY ORGANIZATIONAL MAP/), 'org heading');
  assert.ok(hasText(calls, /ACCOUNT RISK/), 'risk heading');
  assert.ok(hasText(calls, /Overall risk: MODERATE/), 'risk overall');
  assert.ok(hasText(calls, /RECOMMENDED NEXT MOVE/), 'next move heading');
  assert.ok(hasText(calls, /SELLER FOCUS/), 'seller focus heading');
  assert.ok(hasText(calls, /Recast Software/), 'footer branding');
});

test('a sparse brief (only exec summary) renders without throwing', async () => {
  installJsPdfShim();
  const brief = parseContactBriefResponse(JSON.stringify({ executive_summary: { company: 'Acme' } }));
  const blob = await buildContactBriefPdf({ brief });
  assert.equal(blob.type, 'application/pdf');
});

test('missing brief input throws a clear error', async () => {
  installJsPdfShim();
  await assert.rejects(() => buildContactBriefPdf({}), /expected a parsed brief/i);
});
