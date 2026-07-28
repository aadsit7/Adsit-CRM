// Unit tests for js/utils/partner-analyzer-pdf-builder.js.
// Uses the same minimal jsPDF shim as the event/forecast PDF suites and
// asserts the public surface: a safe Partner filename, partner vocabulary (no
// forecast probabilities / event countdowns), all seven maturity stages, the
// KPI strip, long-content pagination, and missing-input handling.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  slugName,
  partnerAnalysisFilename,
  waitForJsPdf,
  buildPartnerAnalysisPdf,
} from '../js/utils/partner-analyzer-pdf-builder.js';
import { parsePartnerAnalysisResponse } from '../js/utils/partner-analyzer-schema.js';

// ── slug + filename ──────────────────────────────────────────
test('slugName replaces spaces and strips punctuation; falls back to "partner"', () => {
  assert.equal(slugName('Nerdio, Inc.!'), 'Nerdio_Inc');
  assert.equal(slugName(''), 'partner');
  assert.equal(slugName(null), 'partner');
});

test('partnerAnalysisFilename produces Partner_Analysis_{slug}_{date}.pdf', () => {
  assert.equal(partnerAnalysisFilename('Nerdio', '2026-07-21'), 'Partner_Analysis_Nerdio_2026-07-21.pdf');
  assert.equal(partnerAnalysisFilename('Nerdio', '2026-07-21T10:00:00Z'), 'Partner_Analysis_Nerdio_2026-07-21.pdf');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(partnerAnalysisFilename('Nerdio', 'not-a-date'), `Partner_Analysis_Nerdio_${today}.pdf`);
  assert.equal(partnerAnalysisFilename(''), `Partner_Analysis_partner_${today}.pdf`);
});

// ── waitForJsPdf ─────────────────────────────────────────────
test('waitForJsPdf throws a clear timeout error when jsPDF is missing', async () => {
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
      ? { _isBlob: true, type: 'application/pdf', size: 128, __calls: calls, __pages: this._pages }
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
function hasText(calls, re) {
  return textStrings(calls).some(t => re.test(t));
}

const PARTNER = { partner_id: 'p1', display_name: 'Nerdio', partner_type: 'Technology', tier: 'Premier/Strategic', region: 'North America' };
const KPIS = { tier: 'Premier/Strategic', status: 'active', partner_type: 'Technology', region: 'North America', transcriptCount: 3, meetingCount: 2, documentCount: 1, eventCount: 2, upcomingEventCount: 1, completedEventCount: 1, totalOpps: 3, activeOppCount: 1, activePipelineValue: 150000, wonOppCount: 1, wonRevenue: 75000, nearestExpectedClose: '2026-09-15', mostRecentActivityDate: '2026-06-25' };

function sampleAnalysis() {
  const raw = {
    partner_id: 'p1', partner_name: 'Nerdio', confidence: 'medium',
    summary: 'Profile and relationship are established; pipeline is active with one win. GTM planning is the gap.',
    stages: [
      { stage_id: 'profile_fit', status: 'complete', criteria: [
        { criterion_id: 'partner_profile_complete', status: 'met', source_type: 'partner_profile', source_id: 'p1' },
      ] },
      { stage_id: 'pipeline_execution', status: 'in_progress', criteria: [
        { criterion_id: 'opportunities_created', status: 'met', source_type: 'opportunity', source_id: 'o1' },
      ] },
    ],
    next_actions: ['Build a joint GTM plan', 'Schedule enablement'],
    gaps: ['No documented GTM plan'],
    open_questions: ['Who is the exec sponsor?'],
    risks: ['Single-threaded relationship'],
    momentum: ['First deal won'],
  };
  return parsePartnerAnalysisResponse(JSON.stringify(raw), {
    facts: {
      structuredSupport: { partner_profile_complete: true, opportunities_created: true },
    },
  });
}

// ── buildPartnerAnalysisPdf ──────────────────────────────────
test('returns an application/pdf blob', async () => {
  installJsPdfShim();
  const blob = await buildPartnerAnalysisPdf({ analysis: sampleAnalysis(), partner: PARTNER, kpis: KPIS });
  assert.equal(blob.type, 'application/pdf');
  assert.ok(blob.size > 0);
});

test('renders partner identity, position, KPIs, board and lists (partner vocabulary)', async () => {
  installJsPdfShim();
  const blob = await buildPartnerAnalysisPdf({ analysis: sampleAnalysis(), partner: PARTNER, kpis: KPIS });
  const c = blob.__calls;
  assert.ok(hasText(c, /PARTNER MATURITY ANALYSIS/), 'header eyebrow');
  assert.ok(hasText(c, /Nerdio/), 'partner name');
  assert.ok(hasText(c, /MATURITY POSITION/), 'position heading');
  assert.ok(hasText(c, /CRM CONTEXT & KPIS/), 'KPI heading');
  assert.ok(hasText(c, /Premier\/Strategic/), 'CRM tier shown as context');
  assert.ok(hasText(c, /MATURITY BOARD/), 'board heading');
  assert.ok(hasText(c, /DO THIS NEXT/), 'next actions heading');
  assert.ok(hasText(c, /MATURITY GAPS/), 'gaps heading');
  assert.ok(hasText(c, /RELATIONSHIP RISKS/), 'risks heading');
  assert.ok(hasText(c, /POSITIVE MOMENTUM/), 'momentum heading');
  assert.ok(hasText(c, /Build a joint GTM plan/), 'a next-action item');
  assert.ok(hasText(c, /Recast Software/), 'branded footer');
  // Partner vocabulary only — no forecast probability / event countdown.
  assert.ok(!hasText(c, /probability/i), 'no forecast probability language');
  assert.ok(!hasText(c, /days until the event/i), 'no event countdown language');
  // Relationship health was removed from the analyzer entirely — the maturity
  // position must never carry a health label again.
  assert.ok(!hasText(c, /relationship health/i), 'no relationship-health section');
});

test('renders all seven maturity stage names', async () => {
  const calls = installJsPdfShim();
  await buildPartnerAnalysisPdf({ analysis: sampleAnalysis(), partner: PARTNER, kpis: KPIS });
  for (const name of ['Profile & Fit', 'Relationship & Alignment', 'Enablement & Readiness', 'Joint Go-to-Market Planning', 'Market Engagement', 'Pipeline Execution', 'Revenue & Growth']) {
    assert.ok(hasText(calls, new RegExp(name.replace(/[-&]/g, '.'))), `${name} must render`);
  }
});

test('renders coverage warnings when provided', async () => {
  const calls = installJsPdfShim();
  await buildPartnerAnalysisPdf({
    analysis: sampleAnalysis(), partner: PARTNER, kpis: KPIS,
    coverageWarnings: ['5 transcripts were not sent to Randy due to size limits.'],
  });
  assert.ok(hasText(calls, /COVERAGE NOTES/), 'coverage heading');
  assert.ok(hasText(calls, /5 transcripts were not sent/), 'coverage warning text');
});

test('never exceeds the page cap, even with pathological input', async () => {
  installJsPdfShim();
  const analysis = sampleAnalysis();
  analysis.summary = 'A very long running summary sentence. '.repeat(80);
  analysis.next_actions = Array.from({ length: 40 }, (_, i) => `Next action ${i} that runs long enough to wrap onto several lines in the rendered output here`);
  analysis.gaps = Array.from({ length: 40 }, (_, i) => `Gap ${i} which is intentionally quite long to force wrapping across multiple lines in the output`);
  analysis.risks = Array.from({ length: 40 }, (_, i) => `Risk ${i} written to be long enough that it wraps across a couple of lines each time`);
  analysis.momentum = Array.from({ length: 40 }, (_, i) => `Momentum ${i} also long enough to wrap onto multiple lines in the rendered PDF output`);
  const blob = await buildPartnerAnalysisPdf({ analysis, partner: PARTNER, kpis: KPIS });
  assert.ok(blob.__pages <= 4, `expected <= 4 pages, got ${blob.__pages}`);
});

test('caps long lists with a "+N more" note', async () => {
  installJsPdfShim();
  const analysis = sampleAnalysis();
  analysis.gaps = Array.from({ length: 25 }, (_, i) => `Gap ${i}`);
  const blob = await buildPartnerAnalysisPdf({ analysis, partner: PARTNER, kpis: KPIS });
  assert.ok(hasText(blob.__calls, /\+\d+ more/), 'over-cap lists must show a +N more note');
});

test('throws when the analysis is missing', async () => {
  installJsPdfShim();
  await assert.rejects(() => buildPartnerAnalysisPdf({}), /expected a parsed partner analysis object/);
  await assert.rejects(() => buildPartnerAnalysisPdf(), /expected a parsed partner analysis object/);
});

test('tolerates missing kpis without throwing', async () => {
  installJsPdfShim();
  const blob = await buildPartnerAnalysisPdf({ analysis: sampleAnalysis(), partner: PARTNER });
  assert.equal(blob.type, 'application/pdf');
});
