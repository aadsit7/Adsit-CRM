// ============================================================
// Event Analyzer PDF Builder — browser-side (jsPDF)
// ============================================================
// A Recast-branded, print-friendly PDF of the Event Analyzer's lifecycle
// board: event identity + dates, the analyzed lifecycle position and
// completion %, the seven-stage / 21-activity board with per-activity
// status and source dates, then Next Actions, Gaps, Open Questions and any
// coverage warnings.
//
// The board is derived with deriveEventBoard() — the SAME pure function the
// on-screen view uses — so the PDF can never disagree with the page. Uses
// event vocabulary only: NO sales stages, buckets or win percentages.
//
// jsPDF is loaded via <script defer> in index.html (window.jspdf). This
// builder uses jsPDF primitives only (no autotable plugin).
// ============================================================

import { deriveEventBoard, resolveEventPosition, ownerLabel } from './event-analyzer-stages.js';
import { formatDate } from './date.js';

// ── Palette (mirrors css/variables.css design tokens) ─────────
const PRIMARY_BLUE = [0, 0, 204]; // Primary Blue   #0000CC
const PRIMARY_LIGHT = [0, 191, 255]; // Accent Cyan    #00BFFF
const INK = [26, 26, 46]; // Dark Text      #1A1A2E
const BODY_TEXT = [74, 74, 90]; // Medium Gray    #4A4A5A
const MUTED_TEXT = [103, 103, 122]; // Muted text     #67677A
const SUCCESS = [15, 122, 63]; // Green          #0F7A3F
const WARNING = [204, 136, 0]; // Warn Amber     #CC8800
const DANGER = [204, 34, 34]; // Risk Red       #CC2222
const BORDER = [221, 221, 238]; // Divider        #DDDDEE
const NEUTRAL = [198, 198, 220]; // Neutral rail   #C6C6DC
const WHITE = [255, 255, 255];

// ── Page geometry (Letter @ pt) ───────────────────────────────
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_Y = PAGE_H - 26;
const BOTTOM_LIMIT = PAGE_H - MARGIN - 8;
const MAX_PAGES = 3; // events carry more rows than the 2-page forecast

// ── Filename helper ───────────────────────────────────────────
export function slugName(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'event';
  const cleaned = raw
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 60);
  return cleaned.replace(/^[_-]+|[_-]+$/g, '') || 'event';
}

/**
 * Event Analyzer PDF filename: `Event_Analysis_{slug}_{YYYY-MM-DD}.pdf`.
 * The date is today's generation date unless a valid YYYY-MM-DD is passed.
 */
export function eventAnalysisFilename(eventName, dateISO) {
  const today = new Date().toISOString().slice(0, 10);
  const d = (typeof dateISO === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateISO)) ? dateISO.slice(0, 10) : today;
  return `Event_Analysis_${slugName(eventName)}_${d}.pdf`;
}

// ── jsPDF loader ──────────────────────────────────────────────
const DEFAULT_READY_TIMEOUT_MS = 10_000;

export async function waitForJsPdf({ timeoutMs = DEFAULT_READY_TIMEOUT_MS, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const jspdf = g.jspdf || g.jsPDF;
    const JsPDF = jspdf && jspdf.jsPDF;
    if (JsPDF) return JsPDF;
    if (Date.now() >= deadline) {
      throw new Error(
        `jsPDF didn't finish loading within ${Math.round(timeoutMs / 1000)}s. ` +
        'Check the <script> tags in index.html and the browser console for 404 / CORS errors on the CDN URLs.'
      );
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// ── Primitives ────────────────────────────────────────────────
function setFill(doc, rgb) { doc.setFillColor(rgb[0], rgb[1], rgb[2]); }
function setStroke(doc, rgb) { doc.setDrawColor(rgb[0], rgb[1], rgb[2]); }
function setText(doc, rgb) { doc.setTextColor(rgb[0], rgb[1], rgb[2]); }
function wrap(doc, text, w) { return doc.splitTextToSize(String(text == null ? '' : text), w); }

function stageStatusStyle(status) {
  switch (status) {
    case 'complete': return { color: PRIMARY_BLUE, label: 'Complete' };
    case 'in_progress': return { color: PRIMARY_LIGHT, label: 'In progress' };
    default: return { color: NEUTRAL, label: 'Not started' };
  }
}

function activityColor(status) {
  switch (status) {
    case 'met': return SUCCESS;
    case 'partial': return WARNING;
    case 'not_met': return DANGER;
    default: return MUTED_TEXT; // no_evidence
  }
}

function activityLabel(status) {
  switch (status) {
    case 'met': return 'Met';
    case 'partial': return 'Partial';
    case 'not_met': return 'Not met';
    default: return 'No evidence';
  }
}

// Vector status glyph — identical set to the on-screen icons.
function drawStatusGlyph(doc, cx, cy, status) {
  const c = activityColor(status);
  if (status === 'met') {
    setFill(doc, c);
    doc.circle(cx, cy, 3.4, 'F');
    setStroke(doc, WHITE);
    doc.setLineWidth(0.9);
    doc.line(cx - 1.6, cy + 0.1, cx - 0.4, cy + 1.4);
    doc.line(cx - 0.4, cy + 1.4, cx + 1.9, cy - 1.5);
  } else if (status === 'partial') {
    setStroke(doc, c);
    doc.setLineWidth(1.1);
    doc.circle(cx, cy, 3.2, 'S');
    setFill(doc, c);
    doc.circle(cx, cy, 1.4, 'F');
  } else if (status === 'not_met') {
    setStroke(doc, c);
    doc.setLineWidth(1.2);
    doc.line(cx - 2.4, cy - 2.4, cx + 2.4, cy + 2.4);
    doc.line(cx + 2.4, cy - 2.4, cx - 2.4, cy + 2.4);
  } else {
    setStroke(doc, c);
    doc.setLineWidth(1.3);
    doc.line(cx - 2.6, cy, cx + 2.6, cy);
  }
}

// ── Headers ───────────────────────────────────────────────────
const HEADER_H = 84;

function drawHeaderBand(doc, title, dates, genDate) {
  setFill(doc, PRIMARY_BLUE);
  doc.rect(0, 0, PAGE_W, HEADER_H, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('EVENT LIFECYCLE ANALYSIS', MARGIN, 28);
  doc.setFontSize(21);
  doc.text(wrap(doc, title || 'Event', CONTENT_W - 150)[0], MARGIN, 52);
  if (dates) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.text(wrap(doc, dates, CONTENT_W - 150)[0], MARGIN, 70);
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${genDate}`, PAGE_W - MARGIN, 28, { align: 'right' });
}

const CONT_HEADER_H = 26;

function drawContinuationHeader(doc, title) {
  setFill(doc, PRIMARY_BLUE);
  doc.rect(0, 0, PAGE_W, CONT_HEADER_H, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Event Lifecycle Analysis', MARGIN, 17);
  if (title) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(wrap(doc, title, 220)[0], PAGE_W - MARGIN, 17, { align: 'right' });
  }
  return CONT_HEADER_H + 20;
}

const HEADING_H = 16;

function drawHeading(doc, label, y) {
  setFill(doc, PRIMARY_BLUE);
  doc.rect(MARGIN, y, CONTENT_W, HEADING_H, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text(String(label).toUpperCase(), MARGIN + 8, y + HEADING_H - 4.5);
  return y + HEADING_H;
}

function breakIfNeeded(doc, ctx, y, needed) {
  if (y + needed <= BOTTOM_LIMIT) return y;
  if (doc.internal.getNumberOfPages() < MAX_PAGES) {
    doc.addPage();
    return drawContinuationHeader(doc, ctx.title);
  }
  return y;
}

function isFull(doc, y, needed) {
  return doc.internal.getNumberOfPages() >= MAX_PAGES && (y + needed > BOTTOM_LIMIT);
}

// ── Position + completion strip ───────────────────────────────
function drawPositionStrip(doc, ctx, board, position, confidence, timingLine, yStart) {
  let y = drawHeading(doc, 'Lifecycle Position', yStart) + 16;

  const posLabel = position.def
    ? (position.complete ? `${position.def.name} — lifecycle complete` : `${position.def.name} (in progress)`)
    : 'Not started';
  setText(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(wrap(doc, posLabel, CONTENT_W)[0], MARGIN, y);
  y += 16;

  setText(doc, BODY_TEXT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  const meta = `${board.completionPct}% complete · ${board.metCount} of ${board.totalActivities} activities met · Confidence: ${confidence}`;
  doc.text(meta, MARGIN, y);
  y += 13;
  if (timingLine) {
    setText(doc, MUTED_TEXT);
    doc.setFontSize(9);
    doc.text(wrap(doc, timingLine, CONTENT_W)[0], MARGIN, y);
    y += 12;
  }

  // Completion bar.
  const barW = CONTENT_W;
  const barH = 6;
  setFill(doc, BORDER);
  doc.roundedRect(MARGIN, y, barW, barH, 2, 2, 'F');
  const filled = Math.max(0, Math.min(1, board.completionPct / 100)) * barW;
  if (filled > 0) {
    setFill(doc, PRIMARY_BLUE);
    doc.roundedRect(MARGIN, y, filled, barH, 2, 2, 'F');
  }
  y += barH + 6;

  return y + 6;
}

// ── Overview ──────────────────────────────────────────────────
function drawOverview(doc, ctx, analysis, yStart) {
  let y = drawHeading(doc, 'Overview', yStart) + 16;
  const summary = String(analysis.summary || '').trim();
  if (summary) {
    setText(doc, BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const lines = wrap(doc, summary, CONTENT_W).slice(0, 6);
    doc.text(lines, MARGIN, y);
    y += lines.length * 12.5 + 4;
  } else {
    setText(doc, MUTED_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('No summary available.', MARGIN, y);
    y += 12;
  }
  return y + 8;
}

// ── Stage board ───────────────────────────────────────────────
function drawStageBoard(doc, ctx, board, yStart) {
  let y = drawHeading(doc, 'Lifecycle Board', yStart) + 14;
  for (const stage of board.stages) {
    y = drawStage(doc, ctx, stage, y);
    if (isFull(doc, y, 0)) break;
  }
  return y;
}

function drawStage(doc, ctx, stage, yStart) {
  const style = stageStatusStyle(stage.status);
  const activities = stage.activities || [];
  const headerH = 18;
  const labelW = CONTENT_W - 120;
  const lineCounts = activities.map(a => wrap(doc, a.label, labelW).length);
  const critH = lineCounts.reduce((s, n) => s + n * 10 + 4, 0);
  const blockH = headerH + critH + 6;

  let y = breakIfNeeded(doc, ctx, yStart, Math.min(blockH, 130));

  const railTop = y - 11;
  const railBottom = y + blockH - headerH - 2;
  setFill(doc, style.color);
  doc.rect(MARGIN, railTop, 2.5, Math.max(railBottom - railTop, headerH), 'F');

  const badgeW = 15;
  const badgeX = MARGIN + 8;
  setFill(doc, style.color);
  doc.roundedRect(badgeX, y - 10, badgeW, 13, 2, 2, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text(String(stage.index + 1), badgeX + badgeW / 2, y - 0.5, { align: 'center' });

  setText(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  const nameX = badgeX + badgeW + 8;
  doc.text(wrap(doc, stage.def.name, CONTENT_W - 220)[0], nameX, y);

  setText(doc, MUTED_TEXT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`${style.label}  ·  ${stage.def.timing}`, PAGE_W - MARGIN, y, { align: 'right' });

  y += 15;

  const glyphX = MARGIN + 14;
  const labelX = MARGIN + 22;
  for (const a of activities) {
    const lines = wrap(doc, a.label, labelW);
    drawStatusGlyph(doc, glyphX, y - 2.6, a.status);
    setText(doc, a.status === 'no_evidence' ? MUTED_TEXT : BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(lines, labelX, y);

    // Right-aligned status + owner + (source date / manual marker).
    const bits = [activityLabel(a.status), ownerLabel(a.owner)];
    if (a.manual) bits.push('saved playbook');
    else if (a.source_date) bits.push(formatDate(a.source_date) || a.source_date);
    setText(doc, activityColor(a.status));
    doc.setFontSize(7.5);
    doc.text(bits.join(' · '), PAGE_W - MARGIN, y, { align: 'right' });

    y += lines.length * 10 + 4;
  }

  return y + 6;
}

// ── Lists ─────────────────────────────────────────────────────
const LIST_CAP = 10;

function drawList(doc, ctx, title, subtitle, items, yStart) {
  const list = Array.isArray(items) ? items.map(x => String(x || '').trim()).filter(Boolean) : [];
  const bodyRows = list.length === 0 ? 1 : Math.min(list.length, LIST_CAP);
  const reserve = 42 + Math.min(bodyRows, 6) * 13;
  let y = breakIfNeeded(doc, ctx, yStart, reserve);

  y = drawHeading(doc, title, y);
  setText(doc, MUTED_TEXT);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.text(subtitle, MARGIN, y + 11);
  y += 22;

  if (list.length === 0) {
    setText(doc, MUTED_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('Nothing flagged from the evidence.', MARGIN + 4, y);
    return y + 10;
  }

  const shown = list.slice(0, LIST_CAP);
  const dotX = MARGIN + 4;
  const textX = MARGIN + 12;
  const listW = CONTENT_W - 12;
  let drawn = 0;
  for (const item of shown) {
    const lines = wrap(doc, item, listW);
    const need = lines.length * 11;
    y = breakIfNeeded(doc, ctx, y, need);
    if (isFull(doc, y, need)) break;
    setFill(doc, PRIMARY_LIGHT);
    doc.circle(dotX, y - 2.4, 1.5, 'F');
    setText(doc, BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(lines, textX, y);
    y += need + 4;
    drawn += 1;
  }

  const remaining = list.length - drawn;
  if (remaining > 0 && !isFull(doc, y, 12)) {
    setText(doc, MUTED_TEXT);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8.5);
    doc.text(`+${remaining} more`, textX, y);
    y += 12;
  }
  return y + 8;
}

// Coverage warnings (non-fatal notes, e.g. saved playbook couldn't load).
function drawCoverage(doc, ctx, warnings, yStart) {
  const list = Array.isArray(warnings) ? warnings.map(x => String(x || '').trim()).filter(Boolean) : [];
  if (list.length === 0) return yStart;
  let y = breakIfNeeded(doc, ctx, yStart, 40);
  y = drawHeading(doc, 'Coverage Notes', y) + 14;
  for (const w of list) {
    const lines = wrap(doc, w, CONTENT_W - 12);
    const need = lines.length * 11;
    y = breakIfNeeded(doc, ctx, y, need);
    if (isFull(doc, y, need)) break;
    setText(doc, WARNING);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('!', MARGIN + 2, y);
    setText(doc, BODY_TEXT);
    doc.text(lines, MARGIN + 12, y);
    y += need + 4;
  }
  return y + 6;
}

function drawFooters(doc, title, genDate) {
  const total = doc.internal.getNumberOfPages();
  const left = `Recast Software  |  ${title || 'Event'} — Lifecycle Analysis  |  Generated ${genDate}`;
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    setStroke(doc, BORDER);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, FOOTER_Y - 8, PAGE_W - MARGIN, FOOTER_Y - 8);
    setText(doc, MUTED_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(left, MARGIN, FOOTER_Y);
    doc.text(`Page ${p} of ${total}`, PAGE_W - MARGIN, FOOTER_Y, { align: 'right' });
  }
}

function formatEventDates(event) {
  const start = String(event?.event_date || '').trim();
  const end = String(event?.end_date || '').trim();
  const s = start ? (formatDate(start) || start) : '';
  const e = end && end !== start ? (formatDate(end) || end) : '';
  const type = String(event?.event_type || '').trim();
  const datePart = s ? (e ? `${s} – ${e}` : s) : '';
  return [type, datePart].filter(Boolean).join('  ·  ');
}

function formatGenDate() {
  const iso = new Date().toISOString().slice(0, 10);
  return formatDate(iso) || iso;
}

/**
 * Build the Event Analyzer PDF from a parsed event analysis. Returns a Blob
 * of type "application/pdf". Bounded to MAX_PAGES pages.
 *
 * @param {object} payload
 * @param {object} payload.analysis  Parsed event-analysis JSON (event-analyzer-schema.js).
 * @param {object} [payload.board]   Pre-derived board; derived from analysis when omitted.
 * @param {object} [payload.event]   Events row ({ title, event_date, end_date, event_type, ... }).
 * @param {string} [payload.timingLine]  Human timing line (e.g. "21 days until the event").
 * @param {string[]} [payload.coverageWarnings]  Non-fatal coverage notes.
 * @param {object} [options]  { timeoutMs } forwarded to waitForJsPdf.
 * @returns {Promise<Blob>}
 */
export async function buildEventAnalysisPdf({ analysis, board, event, timingLine = '', coverageWarnings = [] } = {}, options) {
  if (!analysis || typeof analysis !== 'object') {
    throw new Error('buildEventAnalysisPdf: expected a parsed event analysis object');
  }

  const JsPDF = await waitForJsPdf(options || {});
  const doc = new JsPDF({ unit: 'pt', format: 'letter', compress: true });

  const resolvedBoard = board || deriveEventBoard(analysis);
  const position = resolveEventPosition(resolvedBoard);
  const title = String(analysis.event_title || event?.title || 'Event').trim() || 'Event';
  const confidence = String(analysis.current_stage_confidence || 'low');
  const genDate = formatGenDate();

  const ctx = { title };

  drawHeaderBand(doc, title, formatEventDates(event), genDate);
  let y = HEADER_H + 22;

  y = drawPositionStrip(doc, ctx, resolvedBoard, position, confidence, timingLine, y);
  y = drawOverview(doc, ctx, analysis, y);
  y = drawStageBoard(doc, ctx, resolvedBoard, y);
  y = drawList(doc, ctx, 'What to do next', 'The most useful next steps', analysis.next_actions, y);
  y = drawList(doc, ctx, 'Gaps', 'What is missing to finish the current stage', analysis.gaps, y);
  y = drawList(doc, ctx, 'Open Questions', 'What the evidence leaves unanswered', analysis.open_questions, y);
  drawCoverage(doc, ctx, coverageWarnings, y);

  drawFooters(doc, title, genDate);

  return doc.output('blob');
}
