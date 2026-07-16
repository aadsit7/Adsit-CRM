// ============================================================
// Analyzer PDF Builder — browser-side (jsPDF)
// ============================================================
// Produces a Recast-branded, at-most-two-page PDF of the Analyzer tab's
// forecast board: an overview paragraph, the seven-stage exit-criteria
// board (with per-criterion status), and the Gaps / Open Questions
// working lists. It is a print-friendly rendering of what the Analyzer
// view shows on screen, except the current-position headline (stage name
// + pipeline % + confidence) is deliberately left out of the export —
// the overview paragraph opens the document instead.
//
// The board is derived with deriveForecastBoard() — the SAME pure
// function the on-screen view uses — so the PDF can never disagree with
// the page. Evidence quotes (hidden behind the expandable criterion rows
// on screen) are intentionally omitted here to keep the export compact
// and bounded to two pages; the PDF mirrors the board's default,
// collapsed state.
//
// jsPDF is loaded via <script defer> in index.html and exposed as
// window.jspdf. This builder uses jsPDF primitives only (no autotable),
// so it has no plugin dependency.
// ============================================================

import { deriveForecastBoard } from './forecast-stages.js';
import { formatDate } from './date.js';

// ── Palette (mirrors css/variables.css design tokens) ─────────
const PRIMARY_BLUE  = [47,  107, 255]; // --color-primary        #2F6BFF  (complete)
const PRIMARY_LIGHT = [107, 147, 255]; // --color-primary-lighter #6B93FF (in_progress)
const INK           = [23,  29,  43];  // --color-text-primary   #171D2B
const BODY_TEXT     = [51,  51,  51];  // #333333
const MUTED_TEXT    = [138, 147, 168]; // --color-text-muted     #8A93A8
const SUCCESS       = [10,  143, 130]; // --color-success        #0A8F82  (met)
const WARNING       = [185, 122, 26];  // --color-warning        #B97A1A  (partial)
const DANGER        = [239, 78,  91];  // --color-danger         #EF4E5B  (not_met)
const BORDER        = [220, 225, 236]; // --color-border         #DCE1EC
const BG_LIGHT      = [244, 246, 251]; // --color-bg             #F4F6FB
const NEUTRAL       = [188, 196, 212]; // not_started rail
const WHITE         = [255, 255, 255];

// ── Page geometry (Letter @ pt) ───────────────────────────────
const PAGE_W    = 612;
const PAGE_H    = 792;
const MARGIN    = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_Y  = PAGE_H - 26;
const BOTTOM_LIMIT = PAGE_H - MARGIN - 8; // last usable baseline before footer zone
const MAX_PAGES = 2;                      // hard cap — the export never spills past 2 pages

// ── Filename helper ───────────────────────────────────────────
export function slugName(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'opportunity';
  const cleaned = raw
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 60);
  return cleaned.replace(/^[_-]+|[_-]+$/g, '') || 'opportunity';
}

/**
 * Analyzer PDF filename: `Analysis_{slug}_{YYYY-MM-DD}.pdf`. The date is
 * always today's generation date; any dateISO passed that isn't a
 * YYYY-MM-DD string is ignored in favour of today (same guard the MAP /
 * Timeline filenames use).
 */
export function forecastFilename(customerName, dateISO) {
  const today = new Date().toISOString().slice(0, 10);
  const d = (typeof dateISO === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateISO))
    ? dateISO.slice(0, 10)
    : today;
  return `Analysis_${slugName(customerName)}_${d}.pdf`;
}

// ── jsPDF loader (matches the other builders' probe) ──────────
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
function setFill(doc, rgb)   { doc.setFillColor(rgb[0], rgb[1], rgb[2]); }
function setStroke(doc, rgb) { doc.setDrawColor(rgb[0], rgb[1], rgb[2]); }
function setText(doc, rgb)   { doc.setTextColor(rgb[0], rgb[1], rgb[2]); }
function wrap(doc, text, w)  { return doc.splitTextToSize(String(text == null ? '' : text), w); }

// Colour + label for a stage status.
function stageStatusStyle(status) {
  switch (status) {
    case 'complete':    return { color: PRIMARY_BLUE,  label: 'Complete' };
    case 'in_progress': return { color: PRIMARY_LIGHT, label: 'In progress' };
    default:            return { color: NEUTRAL,       label: 'Not started' };
  }
}

// Colour for a criterion status glyph / label.
function criterionColor(status) {
  switch (status) {
    case 'met':      return SUCCESS;
    case 'partial':  return WARNING;
    case 'not_met':  return DANGER;
    default:         return MUTED_TEXT; // no_evidence
  }
}

// Draw the ~8pt status glyph centred at (cx, cy), matching the on-screen
// criterion icons: met = filled check, partial = ring, not_met = cross,
// no_evidence = dash. Vector-drawn (not a font glyph) so it renders
// identically regardless of jsPDF's Latin-1 font coverage.
function drawStatusGlyph(doc, cx, cy, status) {
  const c = criterionColor(status);
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

// ── Page 1 header band ────────────────────────────────────────
const HEADER_H = 84;

function drawHeaderBand(doc, customer, deal, genDate) {
  setFill(doc, PRIMARY_BLUE);
  doc.rect(0, 0, PAGE_W, HEADER_H, 'F');

  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('SALES FORECAST ANALYSIS', MARGIN, 28);

  doc.setFontSize(21);
  doc.text(wrap(doc, customer || 'Opportunity', CONTENT_W - 150)[0], MARGIN, 52);

  if (deal) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.text(wrap(doc, deal, CONTENT_W - 150)[0], MARGIN, 70);
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${genDate}`, PAGE_W - MARGIN, 28, { align: 'right' });
}

// ── Slim continuation header (page 2) ─────────────────────────
const CONT_HEADER_H = 26;

function drawContinuationHeader(doc, customer) {
  setFill(doc, PRIMARY_BLUE);
  doc.rect(0, 0, PAGE_W, CONT_HEADER_H, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Sales Forecast Analysis', MARGIN, 17);
  if (customer) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(wrap(doc, customer, 220)[0], PAGE_W - MARGIN, 17, { align: 'right' });
  }
  return CONT_HEADER_H + 20;
}

// ── Section heading bar ───────────────────────────────────────
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

// ── Page-break helper — never exceeds MAX_PAGES ───────────────
// Returns the y to continue drawing at. If the block fits on the current
// page, y is unchanged. If it overflows and we're still under the page
// cap, a fresh page (with its slim header) is opened. Once the cap is
// reached the cursor is left as-is: callers combined with the content
// caps below never actually overflow page 2 for real forecasts, so this
// only ever acts as a backstop against pathological input.
function breakIfNeeded(doc, ctx, y, needed) {
  if (y + needed <= BOTTOM_LIMIT) return y;
  if (doc.internal.getNumberOfPages() < MAX_PAGES) {
    doc.addPage();
    return drawContinuationHeader(doc, ctx.customer);
  }
  return y;
}

// True once we're on the last allowed page and out of vertical room —
// used to stop emitting further optional content instead of overflowing.
function isFull(doc, y, needed) {
  return doc.internal.getNumberOfPages() >= MAX_PAGES && (y + needed > BOTTOM_LIMIT);
}

// ── Overview ──────────────────────────────────────────────────
// The on-screen view leads with the current-position headline (stage
// name, pipeline % and confidence); the PDF intentionally omits that and
// opens with the overview paragraph alone.
function drawOverview(doc, ctx, forecast, yStart) {
  let y = drawHeading(doc, 'Overview', yStart) + 16;

  const summary = String(forecast.summary || '').trim();
  if (summary) {
    setText(doc, BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    // Cap the summary so a very long paragraph can't crowd out the board.
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
  let y = drawHeading(doc, 'Stage Board', yStart) + 14;

  for (const stage of board.stages) {
    y = drawStage(doc, ctx, stage, y);
    if (isFull(doc, y, 0)) break; // backstop — never happens for real data
  }
  return y;
}

function drawStage(doc, ctx, stage, yStart) {
  const style = stageStatusStyle(stage.status);
  const criteria = stage.criteria || [];

  // Estimate the block height so a stage never straddles the 2-page break.
  const headerH = 18;
  let critH = 0;
  const labelW = CONTENT_W - 20;
  const lineCounts = criteria.map(c => wrap(doc, c.label, labelW).length);
  critH = lineCounts.reduce((s, n) => s + n * 10 + 3, 0);
  const blockH = headerH + critH + 6;

  let y = breakIfNeeded(doc, ctx, yStart, Math.min(blockH, 120));

  // Status rail down the left edge of the stage block.
  const railTop = y - 11;
  const railBottom = y + blockH - headerH - 2;
  setFill(doc, style.color);
  doc.rect(MARGIN, railTop, 2.5, Math.max(railBottom - railTop, headerH), 'F');

  // Header row: number badge + name + right-aligned bucket · prob.
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
  doc.text(wrap(doc, stage.def.name, CONTENT_W - 190)[0], nameX, y);

  setText(doc, MUTED_TEXT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`${style.label}  ·  ${stage.def.bucket} · ${stage.def.probability}%`, PAGE_W - MARGIN, y, { align: 'right' });

  y += 15;

  // Criteria rows.
  const glyphX = MARGIN + 14;
  const labelX = MARGIN + 22;
  for (const c of criteria) {
    const lines = wrap(doc, c.label, labelW);
    drawStatusGlyph(doc, glyphX, y - 2.6, c.status);
    setText(doc, c.status === 'no_evidence' ? MUTED_TEXT : BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(lines, labelX, y);
    y += lines.length * 10 + 3;
  }

  return y + 6;
}

// ── Gaps / Open Questions lists ───────────────────────────────
const LIST_CAP = 8;

function drawList(doc, ctx, title, subtitle, items, yStart) {
  const list = Array.isArray(items) ? items.map(x => String(x || '').trim()).filter(Boolean) : [];

  // Keep the heading with the top of its body: reserve room for the
  // heading + subtitle + the first handful of rows. If that block can't
  // fit on the current page, the whole section starts on the next one
  // (rather than orphaning the heading at the bottom with its items
  // spilling onto — or colliding with the footer of — this page).
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
    doc.text('Nothing flagged from the notes.', MARGIN + 4, y);
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
    if (isFull(doc, y, need)) break; // page 2 exhausted — stop cleanly
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
  if (remaining > 0) {
    y = breakIfNeeded(doc, ctx, y, 12);
    if (!isFull(doc, y, 12)) {
      setText(doc, MUTED_TEXT);
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8.5);
      doc.text(`+${remaining} more`, textX, y);
      y += 12;
    }
  }

  return y + 8;
}

// ── Two-pass footers ──────────────────────────────────────────
function drawFooters(doc, customer, genDate) {
  const total = doc.internal.getNumberOfPages();
  const left = `Recast Software  |  ${customer || 'Opportunity'} — Analysis  |  Generated ${genDate}`;
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

// ── Public entry point ────────────────────────────────────────
/**
 * Build the Analyzer PDF from a forecast result. Returns a Blob of type
 * "application/pdf". Never produces more than two pages.
 *
 * @param {object}  payload
 * @param {object}  payload.forecast  Parsed forecast JSON (forecast-schema.js).
 * @param {object}  [payload.board]   Pre-derived board (from the view). When
 *                                    omitted it is derived from `forecast`
 *                                    with the same shared function, so the
 *                                    PDF matches the on-screen board exactly.
 * @param {object}  [payload.opp]     Opportunity row ({ customer_name, deal_name }).
 * @param {string}  [payload.overrideStageId]  Accepted for call-site
 *                                    compatibility but no longer rendered:
 *                                    the export intentionally omits the
 *                                    current-position headline (stage name,
 *                                    pipeline % and confidence).
 * @param {object}  [options]         { timeoutMs } forwarded to waitForJsPdf.
 * @returns {Promise<Blob>}
 */
export async function buildForecastPdf({ forecast, board, opp, overrideStageId = '' } = {}, options) {
  if (!forecast || typeof forecast !== 'object') {
    throw new Error('buildForecastPdf: expected a parsed forecast object');
  }

  const JsPDF = await waitForJsPdf(options || {});
  const doc = new JsPDF({ unit: 'pt', format: 'letter', compress: true });

  const resolvedBoard = board || deriveForecastBoard(forecast);
  const customer = String(forecast.customer_name || opp?.customer_name || 'Opportunity').trim() || 'Opportunity';
  const deal = String(opp?.deal_name || '').trim();
  const genDate = formatGenDate();

  const ctx = { customer, overrideStageId };

  // Page 1 header.
  drawHeaderBand(doc, customer, deal, genDate);
  let y = HEADER_H + 22;

  y = drawOverview(doc, ctx, forecast, y);
  y = drawStageBoard(doc, ctx, resolvedBoard, y);
  y = drawList(doc, ctx, 'Gaps', 'What’s missing to advance', forecast.gaps, y);
  drawList(doc, ctx, 'Open Questions', 'What the notes leave unanswered', forecast.open_questions, y);

  drawFooters(doc, customer, genDate);

  return doc.output('blob');
}

// Human-readable generation date for the header / footer. formatDate()
// handles ISO input; fall back to a plain locale string if it can't.
function formatGenDate() {
  const iso = new Date().toISOString().slice(0, 10);
  const pretty = formatDate(iso);
  return pretty || iso;
}
