// Unit tests for js/utils/forecast-pdf-builder.js.
//
// buildForecastPdf() needs jsPDF (loaded via CDN in index.html). Rather
// than install jsPDF just to render in Node, we stub a minimal jsPDF
// shim on globalThis.window.jspdf and assert the public surface —
// crucially that the export never spills past two pages. The shim's
// splitTextToSize approximates real wrapping so the page-cap test is
// meaningful.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  slugName,
  forecastFilename,
  waitForJsPdf,
  buildForecastPdf,
} from '../js/utils/forecast-pdf-builder.js';

// ── slug + filename ──────────────────────────────────────────

test('slugName replaces spaces and strips punctuation', () => {
  assert.equal(slugName('Acme Corporation, Inc.'), 'Acme_Corporation_Inc');
});
test('slugName falls back to "opportunity" on empty', () => {
  assert.equal(slugName(''), 'opportunity');
  assert.equal(slugName(null), 'opportunity');
});

test('forecastFilename produces Analysis_{slug}_{date}.pdf', () => {
  assert.equal(
    forecastFilename('Acme Corporation', '2026-07-14'),
    'Analysis_Acme_Corporation_2026-07-14.pdf',
  );
});
test('forecastFilename trims a full ISO timestamp to the date', () => {
  assert.equal(
    forecastFilename('Acme', '2026-07-14T15:30:00Z'),
    'Analysis_Acme_2026-07-14.pdf',
  );
});
test('forecastFilename ignores non-ISO dates and uses today', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(forecastFilename('Acme', 'July 14, 2026'), `Analysis_Acme_${today}.pdf`);
  assert.equal(forecastFilename('Acme'), `Analysis_Acme_${today}.pdf`);
  assert.equal(forecastFilename('Acme', null), `Analysis_Acme_${today}.pdf`);
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
    this._calls = calls;
    this._pages = 1;
    this._page = 1;
    this.internal = { getNumberOfPages: () => this._pages };
    this.setFillColor = (...a) => calls.push({ op: 'setFillColor', a });
    this.setDrawColor = (...a) => calls.push({ op: 'setDrawColor', a });
    this.setTextColor = (...a) => calls.push({ op: 'setTextColor', a });
    this.setFont      = (...a) => calls.push({ op: 'setFont', a });
    this.setFontSize  = (...a) => calls.push({ op: 'setFontSize', a });
    this.setLineWidth = (...a) => calls.push({ op: 'setLineWidth', a });
    this.rect         = (...a) => calls.push({ op: 'rect', a });
    this.roundedRect  = (...a) => calls.push({ op: 'roundedRect', a });
    this.circle       = (...a) => calls.push({ op: 'circle', a });
    this.line         = (...a) => calls.push({ op: 'line', a });
    this.triangle     = (...a) => calls.push({ op: 'triangle', a });
    this.text         = (...a) => calls.push({ op: 'text', a });
    this.addPage      = (...a) => { this._pages += 1; this._page = this._pages; calls.push({ op: 'addPage', a }); };
    this.setPage      = (p)    => { this._page = p; calls.push({ op: 'setPage', a: [p] }); };
    // Approximate word-wrap: ~5pt per character at our font sizes.
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
    this.output = (kind) => {
      if (kind === 'blob') {
        return { _isBlob: true, type: 'application/pdf', size: 128, __calls: calls, __pages: this._pages };
      }
      return '';
    };
  }
  Shim.API = { autoTable: () => {} };
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

// A compact, realistic forecast: stage 1 fully met, stage 2 mixed.
function sampleForecast() {
  return {
    opportunity_id: 'opp-1',
    customer_name: 'Acme Corporation',
    summary: 'Discovery is complete and the buyer has committed to a follow-up with sales. Budget is not yet confirmed.',
    current_stage_confidence: 'medium',
    stages: [
      {
        stage_id: 'inside_sales_working',
        status: 'complete',
        notes: 'First stage cleared.',
        criteria: [
          { criterion_id: 'icp_match',         status: 'met', evidence: 'Enterprise IT buyer', source_date: '2026-01-05', source_id: 'd1' },
          { criterion_id: 'pain_validated',    status: 'met', evidence: 'Packaging pain confirmed', source_date: '2026-01-05', source_id: 'd1' },
          { criterion_id: 'meeting_committed', status: 'met', evidence: 'Demo booked', source_date: '2026-01-06', source_id: 'd2' },
        ],
      },
      {
        stage_id: 'sal',
        status: 'in_progress',
        notes: '',
        criteria: [
          { criterion_id: 'pain_confirmed',     status: 'partial',     evidence: 'Some pain noted', source_date: '2026-01-06', source_id: 'd2' },
          { criterion_id: 'use_case_uncovered', status: 'not_met',     evidence: '', source_date: '', source_id: '' },
          { criterion_id: 'next_steps_set',     status: 'no_evidence', evidence: '', source_date: '', source_id: '' },
        ],
      },
    ],
    gaps: ['Confirm budget owner', 'Create a mutual action plan'],
    open_questions: ['Who signs the contract?'],
  };
}

// ── buildForecastPdf ─────────────────────────────────────────

test('buildForecastPdf returns an application/pdf blob', async () => {
  installJsPdfShim();
  const blob = await buildForecastPdf({ forecast: sampleForecast(), opp: { customer_name: 'Acme Corporation', deal_name: 'VDI Modernization' } });
  assert.equal(blob.type, 'application/pdf');
  assert.ok(blob.size > 0);
});

test('buildForecastPdf renders the header, current position, board and lists', async () => {
  const calls = installJsPdfShim();
  const blob = await buildForecastPdf({ forecast: sampleForecast(), opp: { customer_name: 'Acme Corporation', deal_name: 'VDI Modernization' } });
  const c = blob.__calls;
  assert.ok(hasText(c, /SALES FORECAST ANALYSIS/), 'header eyebrow must render');
  assert.ok(hasText(c, /Acme Corporation/), 'customer name must render');
  assert.ok(hasText(c, /VDI Modernization/), 'deal name must render');
  assert.ok(hasText(c, /CURRENT POSITION/), 'current position heading must render');
  // Stage 1 is fully met → it is the current-position headline AND a board row.
  assert.ok(hasText(c, /Inside Sales Working/), 'furthest complete stage name must render');
  assert.ok(hasText(c, /STAGE BOARD/), 'stage board heading must render');
  assert.ok(hasText(c, /Confirmed commitment to a meeting with sales/), 'criterion labels must render');
  assert.ok(hasText(c, /GAPS/), 'gaps heading must render');
  assert.ok(hasText(c, /OPEN QUESTIONS/), 'open questions heading must render');
  assert.ok(hasText(c, /Confirm budget owner/), 'gap items must render');
  assert.ok(hasText(c, /Recast Software/), 'branded footer must render');
});

test('buildForecastPdf derives the board when none is passed', async () => {
  const calls = installJsPdfShim();
  // No `board` key — the builder must derive it from `forecast` and still
  // surface the furthest-complete stage in the Current Position block.
  const blob = await buildForecastPdf({ forecast: sampleForecast(), opp: { customer_name: 'Acme Corporation' } });
  assert.ok(hasText(blob.__calls, /Inside Sales Working/));
});

test('buildForecastPdf renders all seven stage names', async () => {
  const calls = installJsPdfShim();
  await buildForecastPdf({ forecast: sampleForecast() });
  for (const name of [
    'Inside Sales Working', 'SAL (Inside Sales Qualified)', 'Identification',
    'Qualification', 'Development', 'Proposal', 'Closing',
  ]) {
    assert.ok(hasText(calls, new RegExp(name.replace(/[()]/g, '.'))), `${name} must render`);
  }
});

test('buildForecastPdf never exceeds two pages, even with pathological input', async () => {
  installJsPdfShim();
  const forecast = sampleForecast();
  // Blow up every unbounded field far past what a real forecast holds.
  forecast.summary = 'This is a very long running summary sentence. '.repeat(60);
  forecast.gaps = Array.from({ length: 40 }, (_, i) => `Gap number ${i} which is intentionally quite long to force wrapping across several lines in the output`);
  forecast.open_questions = Array.from({ length: 40 }, (_, i) => `Open question number ${i} that also runs long enough to wrap onto multiple lines in the rendered PDF output`);
  const blob = await buildForecastPdf({ forecast });
  assert.ok(blob.__pages <= 2, `expected <= 2 pages, got ${blob.__pages}`);
});

test('buildForecastPdf caps long lists with a "+N more" note', async () => {
  const calls = installJsPdfShim();
  const forecast = sampleForecast();
  forecast.gaps = Array.from({ length: 20 }, (_, i) => `Gap ${i}`);
  const blob = await buildForecastPdf({ forecast });
  assert.ok(hasText(blob.__calls, /\+\d+ more/), 'over-cap lists must show a +N more note');
});

test('buildForecastPdf throws when the forecast is missing', async () => {
  installJsPdfShim();
  await assert.rejects(() => buildForecastPdf({}), /expected a parsed forecast object/);
  await assert.rejects(() => buildForecastPdf(), /expected a parsed forecast object/);
});
