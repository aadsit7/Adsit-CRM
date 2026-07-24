// ============================================================
// Tests for the V1.5 click-driven MAP PDF flow
// ============================================================
// Covers:
//  • buildMapJsonPromptFromMultiple — the synthesis prompt text
//  • requestMapPdfJsonFromMultiple  — same Messages-API shape as V1
//  • generateMapPdfFromSelection    — orchestrator validation + happy path
//
// Network-heavy assertions stub global fetch / FileReader / jsPDF so
// nothing actually hits Anthropic or Google Drive.
// ============================================================

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({
  ANTHROPIC_API_KEY: 'sk-ant-test-key',
  FILE_API_URL: 'https://example.invalid/file-api',
}));

const { requestMapPdfJsonFromMultiple, __mapJsonInternals } = await import('../js/utils/ai.js');
const { buildMapJsonPromptFromMultiple, buildMapJsonPrompt } = __mapJsonInternals;

// ── FileReader + jsPDF shim so buildMapPdf can run in Node ──
class FakeFileReader {
  onload = null;
  onerror = null;
  readAsDataURL(blob) {
    setTimeout(() => {
      this.result = `data:${blob._type || 'application/pdf'};base64,${blob._b64 || 'UEQ='}`;
      if (this.onload) this.onload();
    }, 0);
  }
}
globalThis.FileReader = FakeFileReader;

function installJsPdfShim() {
  function Shim() {
    this.internal = { getNumberOfPages: () => 2 };
    this.autoTable = () => { this.lastAutoTable = { finalY: 500 }; };
    const noop = () => {};
    this.setFillColor = noop; this.setDrawColor = noop; this.setTextColor = noop;
    this.setFont = noop; this.setFontSize = noop; this.setLineWidth = noop;
    this.rect = noop; this.roundedRect = noop; this.line = noop;
    this.triangle = noop; this.circle = noop; this.text = noop;
    this.addPage = noop; this.setPage = noop;
    this.splitTextToSize = s => [String(s)];
    this.getTextWidth = s => String(s || '').length * 5;
    this.output = (kind) => (kind === 'blob' ? { _isBlob: true, type: 'application/pdf', size: 42, _b64: 'UEQ=' } : '');
  }
  Shim.API = { autoTable: () => {} };
  globalThis.window = globalThis.window || {};
  globalThis.window.jspdf = { jsPDF: Shim };
}

// ── buildMapJsonPromptFromMultiple ──────────────────────────

test('single-desc prompt is byte-identical to V1 voice-flow prompt (no synthesis language)', () => {
  const opp = { name: 'ANICO', customerName: 'ANICO', dealName: 'ANICO MAP' };
  const entries = [{ date: '2026-04-15', content: 'Q2 discovery call.' }];
  const single = buildMapJsonPromptFromMultiple(opp, entries);
  const voice  = buildMapJsonPrompt(opp, entries);
  assert.equal(single, voice,
    'N=1 click flow must produce the same prompt as the voice flow — no regressions');
  assert.ok(!/synthesize across ALL/i.test(single),
    'single-description prompt must NOT carry the multi-source synthesis directive');
});

test('multi-desc prompt includes synthesis instruction and DATE markers for each entry', () => {
  const entries = [
    { date: '2026-04-15', content: 'Latest: pricing finalized, biweekly cadence agreed.' },
    { date: '2026-03-10', content: 'Mid-phase: discovery complete, scoping POC.' },
    { date: '2026-01-04', content: 'Early: initial qualification call.' },
  ];
  const prompt = buildMapJsonPromptFromMultiple(
    { name: 'Greenshield', customerName: 'Greenshield' },
    entries,
  );
  // Synthesis contract
  assert.match(prompt, /3 separate description entries/);
  assert.match(prompt, /synthesize and condense across ALL of them/i);
  assert.match(prompt, /the more recent entry wins/i);
  // DATE headers per entry
  assert.match(prompt, /--- DATE: 2026-04-15 ---/);
  assert.match(prompt, /--- DATE: 2026-03-10 ---/);
  assert.match(prompt, /--- DATE: 2026-01-04 ---/);
  // Golden Rule preserved across the multi-source prompt (V1.6 replaced
  // the older "GROUNDING RULES" header with the top-level Golden Rule
  // block — same intent, stronger language).
  assert.match(prompt, /GOLDEN RULE/);
  assert.match(prompt, /traceable to a specific phrase or sentence/i);
  assert.match(prompt, /Infer tool names that aren't in/i);
});

test('multi-desc prompt sorts entries newest-first regardless of input order', () => {
  // Deliberately pass in oldest-first to prove the builder re-sorts.
  const entries = [
    { date: '2026-01-04', content: 'Early: initial qualification call.' },
    { date: '2026-04-15', content: 'Latest: pricing finalized.' },
    { date: '2026-03-10', content: 'Mid-phase: discovery complete.' },
  ];
  const prompt = buildMapJsonPromptFromMultiple(
    { customerName: 'X' },
    entries,
  );
  const latestIdx = prompt.indexOf('2026-04-15');
  const midIdx    = prompt.indexOf('2026-03-10');
  const earlyIdx  = prompt.indexOf('2026-01-04');
  assert.ok(latestIdx > 0 && midIdx > 0 && earlyIdx > 0, 'all three dates must appear');
  assert.ok(latestIdx < midIdx && midIdx < earlyIdx,
    `entries must be newest-first; got latest@${latestIdx}, mid@${midIdx}, early@${earlyIdx}`);
});

test('requestMapPdfJsonFromMultiple uses the same model + headers as the voice flow', async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          customer_name: 'X',
          document_date: 'April 22, 2026',
          meeting_recap: [{ label: 'a', detail: 'b' }],
          current_environment: {
            infrastructure: [{ name: 'Citrix', subline: '' }],
            current_state_pain: ['p'],
            stakeholders_and_decision_process: ['s'],
          },
          mutual_action_plan: [{ phase: 'Discovery', action: 'x', owner: 'Recast', due_date: '2026-05-01', status: 'Complete' }],
        }) }],
      }),
    };
  };

  await requestMapPdfJsonFromMultiple(
    { customerName: 'X' },
    [
      { date: '2026-04-15', content: 'a' },
      { date: '2026-03-01', content: 'b' },
    ],
  );

  assert.ok(captured);
  assert.ok(captured.url.endsWith('/v1/messages'));
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.model, 'claude-opus-4-8');
  assert.equal(body.messages.length, 1);
  assert.match(body.messages[0].content, /DATE: 2026-04-15/);
  assert.match(body.messages[0].content, /DATE: 2026-03-01/);
});

// ── generateMapPdfFromSelection ─────────────────────────────

const { generateMapPdfFromSelection, __mapFromSelectionInternals } =
  await import('../js/utils/map-pdf-from-selection.js');
const { normalizeOpportunity, normalizeSelectedDescriptions, resolveDriveUrl } =
  __mapFromSelectionInternals;

test('generateMapPdfFromSelection rejects cleanly on empty selection', async () => {
  await assert.rejects(
    () => generateMapPdfFromSelection(
      { id: 'opp_1', customerName: 'ANICO' },
      [],
    ),
    (err) => err.code === 'MAP_SELECTION_EMPTY',
  );
});

test('generateMapPdfFromSelection rejects when opportunity lacks customerName', async () => {
  await assert.rejects(
    () => generateMapPdfFromSelection(
      { id: 'opp_1' },
      [{ content: 'x', date: '2026-04-15' }],
    ),
    (err) => err.code === 'MAP_SELECTION_INVALID_OPPORTUNITY',
  );
});

test('generateMapPdfFromSelection rejects when opportunity lacks id', async () => {
  await assert.rejects(
    () => generateMapPdfFromSelection(
      { customerName: 'ANICO' },
      [{ content: 'x', date: '2026-04-15' }],
    ),
    (err) => err.code === 'MAP_SELECTION_INVALID_OPPORTUNITY',
  );
});

test('generateMapPdfFromSelection firing onStage callbacks — N=1 uses "reading" stage', async () => {
  installJsPdfShim();
  const stages = [];

  // Track the two network calls:
  //  1. Anthropic Messages API
  //  2. Apps Script file API
  let fetchCount = 0;
  globalThis.fetch = async (url, opts) => {
    fetchCount += 1;
    if (url.includes('/v1/messages')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({
            customer_name: 'Greenshield',
            document_date: 'April 22, 2026',
            meeting_recap: [{ label: 'a', detail: 'b' }],
            current_environment: {
              infrastructure: [{ name: 'Citrix', subline: '' }],
              current_state_pain: ['p'],
              stakeholders_and_decision_process: ['s'],
            },
            mutual_action_plan: [{ phase: 'Discovery', action: 'x', owner: 'Recast', due_date: '2026-05-01', status: 'Complete' }],
          }) }],
        }),
      };
    }
    // Apps Script upload
    const payload = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        file: {
          doc_id: 'doc_123',
          file_name: payload.fileName,
          drive_url: 'https://drive.google.com/file/d/abc/view',
          date_added: '2026-04-22T12:00:00Z',
        },
      }),
    };
  };

  const result = await generateMapPdfFromSelection(
    { id: 'opp_1', customerName: 'Greenshield' },
    [{ content: 'single meeting', date: '2026-04-15' }],
    { onStage: (stage, extra) => stages.push({ stage, extra }) },
  );

  assert.equal(fetchCount, 2, 'exactly one Anthropic call and one Drive upload');
  assert.equal(result.success, true);
  assert.equal(result.driveUrl, 'https://drive.google.com/file/d/abc/view');
  // Filename uses the 1source suffix.
  assert.match(result.filename, /^MAP_Greenshield_\d{4}-\d{2}-\d{2}_1source\.pdf$/);
  // Stages: reading → building → saving
  assert.deepEqual(stages.map(s => s.stage), ['reading', 'building', 'saving']);
});

test('generateMapPdfFromSelection firing onStage — N>1 uses "synthesizing" stage with count', async () => {
  installJsPdfShim();
  const stages = [];
  globalThis.fetch = async (url, opts) => {
    if (url.includes('/v1/messages')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({
            customer_name: 'Greenshield',
            document_date: 'April 22, 2026',
            meeting_recap: [{ label: 'a', detail: 'b' }],
            current_environment: {
              infrastructure: [{ name: 'Citrix', subline: '' }],
              current_state_pain: ['p'],
              stakeholders_and_decision_process: ['s'],
            },
            mutual_action_plan: [{ phase: 'Discovery', action: 'x', owner: 'Recast', due_date: '2026-05-01', status: 'Complete' }],
          }) }],
        }),
      };
    }
    const payload = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        file: {
          doc_id: 'doc_123',
          file_name: payload.fileName,
          drive_url: 'https://drive.google.com/file/d/abc/view',
          date_added: '2026-04-22T12:00:00Z',
        },
      }),
    };
  };

  const result = await generateMapPdfFromSelection(
    { id: 'opp_1', customerName: 'Greenshield' },
    [
      { content: 'latest', date: '2026-04-15' },
      { content: 'older',  date: '2026-03-01' },
      { content: 'oldest', date: '2026-01-01' },
    ],
    { onStage: (stage, extra) => stages.push({ stage, extra }) },
  );

  assert.match(result.filename, /_3sources\.pdf$/);
  assert.equal(stages[0].stage, 'synthesizing');
  assert.equal(stages[0].extra.count, 3);
});

test('resolveDriveUrl walks every known response shape', () => {
  assert.equal(resolveDriveUrl({ file: { drive_url: 'a' } }), 'a');
  assert.equal(resolveDriveUrl({ drive_url: 'b' }), 'b');
  assert.equal(resolveDriveUrl({ file: { driveUrl: 'c' } }), 'c');
  assert.equal(resolveDriveUrl({ driveUrl: 'd' }), 'd');
  assert.equal(resolveDriveUrl({ file: { webViewLink: 'e' } }), 'e');
  assert.equal(resolveDriveUrl({ webViewLink: 'f' }), 'f');
  assert.equal(resolveDriveUrl({ file: { url: 'g' } }), 'g');
  assert.equal(resolveDriveUrl({ url: 'h' }), 'h');
  assert.equal(resolveDriveUrl({}), '');
  assert.equal(resolveDriveUrl(null), '');
});

test('normalizeSelectedDescriptions accepts both {date, content} and raw sheet rows', () => {
  const out = normalizeSelectedDescriptions([
    { date: '2026-04-15', content: 'shape A' },
    { description_date: '2026-03-10', description_text: 'shape B' },
    { date: '2026-02-01', content: '' },   // dropped (empty content)
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].content, 'shape A');
  assert.equal(out[1].content, 'shape B');
  assert.equal(out[1].date, '2026-03-10');
});
