// Unit tests for js/utils/event-analyzer-pdf-builder.js.
// Uses the same minimal jsPDF shim approach as forecast-pdf-builder.test.mjs
// and asserts the public surface: event-specific filename, event vocabulary
// (no sales stages/buckets), the seven stages, and the page cap.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  slugName,
  eventAnalysisFilename,
  waitForJsPdf,
  buildEventAnalysisPdf,
} from '../js/utils/event-analyzer-pdf-builder.js';
import { parseEventAnalysisResponse } from '../js/utils/event-analyzer-schema.js';

// ── slug + filename ──────────────────────────────────────────
test('slugName replaces spaces and strips punctuation; falls back to "event"', () => {
  assert.equal(slugName('Cloud Security Workshop!'), 'Cloud_Security_Workshop');
  assert.equal(slugName(''), 'event');
  assert.equal(slugName(null), 'event');
});

test('eventAnalysisFilename produces Event_Analysis_{slug}_{date}.pdf', () => {
  assert.equal(
    eventAnalysisFilename('Cloud Security Workshop', '2026-07-14'),
    'Event_Analysis_Cloud_Security_Workshop_2026-07-14.pdf',
  );
});
test('eventAnalysisFilename trims a full ISO timestamp and ignores non-ISO dates', () => {
  assert.equal(eventAnalysisFilename('Workshop', '2026-07-14T10:00:00Z'), 'Event_Analysis_Workshop_2026-07-14.pdf');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(eventAnalysisFilename('Workshop', 'July 2026'), `Event_Analysis_Workshop_${today}.pdf`);
  assert.equal(eventAnalysisFilename('Workshop'), `Event_Analysis_Workshop_${today}.pdf`);
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

const EVENT = { title: 'Cloud Security Workshop', event_date: '2026-04-22', end_date: '2026-04-23', event_type: 'Workshop' };

// A realistic analysis: Event stage complete, Audience underway.
function sampleAnalysis() {
  const raw = {
    event_id: 'evt_002',
    event_title: 'Cloud Security Workshop',
    current_stage_confidence: 'medium',
    summary: 'The event is set up and audience work has begun. Messaging and drive-attendance work still to do.',
    stages: [
      { stage_id: 'setup', status: 'complete', notes: '', activities: [
        { activity_id: 'setup_topic', status: 'met', evidence: 'Topic agreed on the kickoff call.', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' },
        { activity_id: 'setup_why', status: 'met', evidence: 'The WHY was outlined on the kickoff call.', source_type: 'event_description', source_id: 'edsc_1', source_date: '2026-03-05' },
      ] },
      { stage_id: 'audience', status: 'in_progress', notes: '', activities: [
        { activity_id: 'audience_upload', status: 'met', evidence: '240 contacts uploaded', source_type: 'event_contacts', source_id: '', source_date: '' },
      ] },
    ],
    next_actions: ['Finalize the messaging', 'Launch outreach'],
    gaps: ['No owners assigned yet'],
    open_questions: ['Who leads the follow-up?'],
  };
  return parseEventAnalysisResponse(JSON.stringify(raw), {
    validSourceIds: ['edsc_1'], validSourceDates: ['2026-03-05'],
    sourceTextById: { edsc_1: 'Kickoff call agreed the topic and outlined the WHY for the workshop.' },
    facts: {
      structuredSupport: { audience_upload: true },
      deterministic: { setup_date: { status: 'met', source_type: 'event_metadata', evidence: 'Event date scheduled for 2026-04-22.', source_date: '2026-04-22' } },
    },
  });
}

// ── buildEventAnalysisPdf ────────────────────────────────────
test('returns an application/pdf blob', async () => {
  installJsPdfShim();
  const blob = await buildEventAnalysisPdf({ analysis: sampleAnalysis(), event: EVENT });
  assert.equal(blob.type, 'application/pdf');
  assert.ok(blob.size > 0);
});

test('renders event identity, dates, position, board, and lists (event vocabulary)', async () => {
  installJsPdfShim();
  const blob = await buildEventAnalysisPdf({ analysis: sampleAnalysis(), event: EVENT, timingLine: '21 days until the event.' });
  const c = blob.__calls;
  assert.ok(hasText(c, /EVENT LIFECYCLE ANALYSIS/), 'header eyebrow');
  assert.ok(hasText(c, /Cloud Security Workshop/), 'event title');
  assert.ok(hasText(c, /Workshop/), 'event type/dates line');
  assert.ok(hasText(c, /LIFECYCLE POSITION/), 'position heading');
  assert.ok(hasText(c, /complete/), 'completion metadata');
  assert.ok(hasText(c, /LIFECYCLE BOARD/), 'board heading');
  assert.ok(hasText(c, /WHAT TO DO NEXT/), 'next actions heading');
  assert.ok(hasText(c, /GAPS/), 'gaps heading');
  assert.ok(hasText(c, /OPEN QUESTIONS/), 'open questions heading');
  assert.ok(hasText(c, /Finalize the messaging/), 'next action item');
  assert.ok(hasText(c, /Recast Software/), 'branded footer');
  // Event vocabulary only — no sales stage/bucket/probability language.
  assert.ok(!hasText(c, /SALES FORECAST/), 'no sales forecast language');
  assert.ok(!hasText(c, /probability/i), 'no probability language');
  assert.ok(!hasText(c, /Best Case|Commit|Pipeline/), 'no sales bucket language');
});

test('renders all seven stage names', async () => {
  const calls = installJsPdfShim();
  await buildEventAnalysisPdf({ analysis: sampleAnalysis(), event: EVENT });
  for (const name of ['Event', 'Audience', 'Messaging', 'Drive Attendance', 'Event Day', 'Follow-Up', 'Results']) {
    assert.ok(hasText(calls, new RegExp(name.replace(/[-]/g, '.'))), `${name} must render`);
  }
});

test('derives the board when none is passed, and renders coverage warnings', async () => {
  const calls = installJsPdfShim();
  await buildEventAnalysisPdf({
    analysis: sampleAnalysis(), event: EVENT,
    coverageWarnings: ['Saved playbook state could not be loaded; the board reflects notes and CRM facts.'],
  });
  assert.ok(hasText(calls, /Audience/), 'board derived and rendered');
  assert.ok(hasText(calls, /COVERAGE NOTES/), 'coverage heading');
  assert.ok(hasText(calls, /Saved playbook state could not be loaded/), 'coverage warning text');
});

test('never exceeds the page cap, even with pathological input', async () => {
  installJsPdfShim();
  const analysis = sampleAnalysis();
  analysis.summary = 'A very long running summary sentence. '.repeat(80);
  analysis.next_actions = Array.from({ length: 40 }, (_, i) => `Next action ${i} that runs long enough to wrap onto several lines in the rendered output here`);
  analysis.gaps = Array.from({ length: 40 }, (_, i) => `Gap ${i} which is intentionally quite long to force wrapping across several lines in the output`);
  analysis.open_questions = Array.from({ length: 40 }, (_, i) => `Open question ${i} that also runs long enough to wrap onto multiple lines in the rendered PDF`);
  const blob = await buildEventAnalysisPdf({ analysis, event: EVENT });
  assert.ok(blob.__pages <= 3, `expected <= 3 pages, got ${blob.__pages}`);
});

test('caps long lists with a "+N more" note', async () => {
  installJsPdfShim();
  const analysis = sampleAnalysis();
  analysis.gaps = Array.from({ length: 25 }, (_, i) => `Gap ${i}`);
  const blob = await buildEventAnalysisPdf({ analysis, event: EVENT });
  assert.ok(hasText(blob.__calls, /\+\d+ more/), 'over-cap lists must show a +N more note');
});

test('throws when the analysis is missing', async () => {
  installJsPdfShim();
  await assert.rejects(() => buildEventAnalysisPdf({}), /expected a parsed event analysis object/);
  await assert.rejects(() => buildEventAnalysisPdf(), /expected a parsed event analysis object/);
});
