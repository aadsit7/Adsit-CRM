// ============================================================
// Partner Analyzer PDF Builder — browser-side (jsPDF)
// ============================================================
// A Recast-branded, print-friendly PDF of the Partner Analyzer's maturity
// board: partner identity + CRM context, the operational maturity position,
// completion %, relationship health, a deterministic KPI strip, the
// seven-stage / 21-criterion board with per-criterion status and source
// dates, the likely org chart, then Next Best Actions, Maturity Gaps, Open
// Questions, Risks, Momentum and any coverage warnings.
//
// The board is derived with derivePartnerBoard() — the SAME pure function the
// on-screen view uses — so the PDF can never disagree with the page; the org
// chart likewise nests through buildOrgChartTree(), the same helper the
// on-screen tree uses. Uses partner vocabulary only: NO forecast
// probabilities and NO event countdowns.
//
// jsPDF is loaded via <script defer> in index.html (window.jspdf).
// ============================================================

import { derivePartnerBoard, resolvePartnerPosition, resolveFurthestDemonstrated, PARTNER_STAGES } from './partner-analyzer-stages.js';
import { buildOrgChartTree } from './partner-analyzer-schema.js';
import { formatDate } from './date.js';

// ── Palette (mirrors css/variables.css design tokens) ─────────
const PRIMARY_BLUE = [47, 107, 255];
const PRIMARY_LIGHT = [107, 147, 255];
const INK = [23, 29, 43];
const BODY_TEXT = [51, 51, 51];
const MUTED_TEXT = [138, 147, 168];
const SUCCESS = [10, 143, 130];
const WARNING = [185, 122, 26];
const DANGER = [239, 78, 91];
const BORDER = [220, 225, 236];
const NEUTRAL = [188, 196, 212];
const WHITE = [255, 255, 255];

// ── Page geometry (Letter @ pt) ───────────────────────────────
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_Y = PAGE_H - 26;
const BOTTOM_LIMIT = PAGE_H - MARGIN - 8;
const MAX_PAGES = 5; // partners carry more evidence than the 3-page event board (+1 for the org chart)

// ── Filename helper ───────────────────────────────────────────
export function slugName(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'partner';
  const cleaned = raw
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 60);
  return cleaned.replace(/^[_-]+|[_-]+$/g, '') || 'partner';
}

/**
 * Partner Analyzer PDF filename: `Partner_Analysis_{slug}_{YYYY-MM-DD}.pdf`.
 * The date is today's generation date unless a valid YYYY-MM-DD is passed.
 */
export function partnerAnalysisFilename(partnerName, dateISO) {
  const today = new Date().toISOString().slice(0, 10);
  const d = (typeof dateISO === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateISO)) ? dateISO.slice(0, 10) : today;
  return `Partner_Analysis_${slugName(partnerName)}_${d}.pdf`;
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
function money(n) { return `$${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`; }

function stageStatusStyle(status) {
  switch (status) {
    case 'complete': return { color: PRIMARY_BLUE, label: 'Complete' };
    case 'in_progress': return { color: PRIMARY_LIGHT, label: 'In progress' };
    default: return { color: NEUTRAL, label: 'Not started' };
  }
}
function criterionColor(status) {
  switch (status) {
    case 'met': return SUCCESS;
    case 'partial': return WARNING;
    case 'not_met': return DANGER;
    default: return MUTED_TEXT;
  }
}
function criterionLabel(status) {
  switch (status) {
    case 'met': return 'Met';
    case 'partial': return 'Partial';
    case 'not_met': return 'Not met';
    default: return 'No evidence';
  }
}
function healthColor(status) {
  switch (status) {
    case 'healthy': return SUCCESS;
    case 'watch': return WARNING;
    case 'at_risk': return DANGER;
    default: return MUTED_TEXT;
  }
}
// Org-chart node statuses — the same palette the Contact brief's org map
// uses (engaged/introduced/missing/identified).
function orgStatusColor(status) {
  switch (status) {
    case 'engaged': return SUCCESS;
    case 'introduced': return PRIMARY_LIGHT;
    case 'missing': return DANGER;
    default: return NEUTRAL; // identified
  }
}

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

// ── Headers ───────────────────────────────────────────────────
const HEADER_H = 84;

function drawHeaderBand(doc, title, subtitle, genDate) {
  setFill(doc, PRIMARY_BLUE);
  doc.rect(0, 0, PAGE_W, HEADER_H, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('PARTNER MATURITY ANALYSIS', MARGIN, 28);
  doc.setFontSize(21);
  doc.text(wrap(doc, title || 'Partner', CONTENT_W - 150)[0], MARGIN, 52);
  if (subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.text(wrap(doc, subtitle, CONTENT_W - 150)[0], MARGIN, 70);
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
  doc.text('Partner Maturity Analysis', MARGIN, 17);
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
function drawPositionStrip(doc, ctx, board, position, furthest, confidence, health, yStart) {
  let y = drawHeading(doc, 'Maturity Position', yStart) + 16;

  const posLabel = position.def
    ? (position.mature ? `${position.def.name} — Mature` : `${position.def.name} (operational stage)`)
    : 'Not started';
  setText(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(wrap(doc, posLabel, CONTENT_W)[0], MARGIN, y);
  y += 16;

  setText(doc, BODY_TEXT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  const completedStages = board.stages.filter(s => s.status === 'complete').length;
  const meta = `${completedStages} / ${PARTNER_STAGES.length} stages complete · ${board.completionPct}% of criteria (${board.metCount} of ${board.totalCriteria} met) · Confidence: ${confidence}`;
  doc.text(meta, MARGIN, y);
  y += 13;

  if (furthest && furthest.def && (!position.def || furthest.index > position.index)) {
    setText(doc, MUTED_TEXT);
    doc.setFontSize(9);
    doc.text(wrap(doc, `Demonstrates later-stage behavior up to “${furthest.def.name}” despite earlier gaps.`, CONTENT_W)[0], MARGIN, y);
    y += 12;
  }

  // Health chip line + the deterministic reason, so the label is transparent
  // and defensible (e.g. why a brand-new partnership is Watch, not At Risk).
  if (health && health.label) {
    setText(doc, healthColor(health.status));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.text(`Relationship health: ${health.label}`, MARGIN, y);
    y += 12;
    const reason = String(health.reason || '').trim();
    if (reason) {
      setText(doc, MUTED_TEXT);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      const rlines = wrap(doc, reason, CONTENT_W).slice(0, 3);
      doc.text(rlines, MARGIN, y);
      y += rlines.length * 9.5 + 3;
    }
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

// ── CRM context + KPI strip ───────────────────────────────────
function drawContext(doc, ctx, kpis, yStart) {
  let y = drawHeading(doc, 'CRM Context & KPIs', yStart) + 14;
  const k = kpis || {};

  // When the partnership began: the created date if stamped, otherwise the
  // earliest known interaction ("when we first engaged").
  const relSince = String(k.created_at || k.firstActivityDate || '').trim();

  const rows = [
    ['CRM tier', k.tier || '—'],
    ['CRM status', k.status || '—'],
    ['Type / region', [k.partner_type, k.region].filter(Boolean).join(' · ') || '—'],
    ['Relationship since', relSince ? (formatDate(relSince) || relSince) : '—'],
    ['Last activity', k.mostRecentActivityDate ? (formatDate(k.mostRecentActivityDate) || k.mostRecentActivityDate) : '—'],
    ['Transcripts', String(k.transcriptCount || 0)],
    ['Indexed meetings', String(k.meetingCount || 0)],
    ['Partner documents', String(k.documentCount || 0)],
    ['Partner events', `${k.eventCount || 0} (${k.upcomingEventCount || 0} upcoming, ${k.completedEventCount || 0} done)`],
    ['Total opportunities', String(k.totalOpps || 0)],
    ['Active pipeline', money(k.activePipelineValue)],
    ['Won revenue', `${money(k.wonRevenue)} (${k.wonOppCount || 0} won)`],
    ['Next expected close', k.nearestExpectedClose ? (formatDate(k.nearestExpectedClose) || k.nearestExpectedClose) : '—'],
  ];

  const colW = CONTENT_W / 2;
  const rowH = 15;
  doc.setFontSize(9);
  for (let i = 0; i < rows.length; i += 2) {
    y = breakIfNeeded(doc, ctx, y, rowH);
    for (let c = 0; c < 2 && (i + c) < rows.length; c++) {
      const [label, value] = rows[i + c];
      const x = MARGIN + c * colW;
      setText(doc, MUTED_TEXT);
      doc.setFont('helvetica', 'bold');
      doc.text(String(label).toUpperCase(), x, y);
      setText(doc, INK);
      doc.setFont('helvetica', 'normal');
      doc.text(wrap(doc, value, colW - 96)[0], x + 96, y);
    }
    y += rowH;
  }
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
    const lines = wrap(doc, summary, CONTENT_W).slice(0, 7);
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
  let y = drawHeading(doc, 'Maturity Board', yStart) + 14;
  for (const stage of board.stages) {
    y = drawStage(doc, ctx, stage, y);
    if (isFull(doc, y, 0)) break;
  }
  return y;
}

function drawStage(doc, ctx, stage, yStart) {
  const style = stageStatusStyle(stage.status);
  const criteria = stage.criteria || [];
  const headerH = 18;
  const labelW = CONTENT_W - 120;
  const lineCounts = criteria.map(c => wrap(doc, c.label, labelW).length);
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
  doc.text(wrap(doc, stage.def.name, CONTENT_W - 200)[0], nameX, y);

  setText(doc, MUTED_TEXT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`${style.label}  ·  ${stage.metCount}/3 met`, PAGE_W - MARGIN, y, { align: 'right' });

  y += 15;

  const glyphX = MARGIN + 14;
  const labelX = MARGIN + 22;
  for (const c of criteria) {
    const lines = wrap(doc, c.label, labelW);
    drawStatusGlyph(doc, glyphX, y - 2.6, c.status);
    setText(doc, c.status === 'no_evidence' ? MUTED_TEXT : BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(lines, labelX, y);

    const bits = [criterionLabel(c.status)];
    if (c.source_date) bits.push(formatDate(c.source_date) || c.source_date);
    setText(doc, criterionColor(c.status));
    doc.setFontSize(7.5);
    doc.text(bits.join(' · '), PAGE_W - MARGIN, y, { align: 'right' });

    y += lines.length * 10 + 4;
  }

  return y + 6;
}

// ── Likely org chart (indented tree with connector elbows) ───
// The validated flat org_map is nested through buildOrgChartTree() — the
// SAME depth normalization the on-screen chart applies — then re-flattened
// here into indented rows. Each row draws its own connector elbow, so a
// page break can never orphan half a line.
function flattenOrgTree(roots, depth = 0, out = []) {
  for (const branch of roots || []) {
    out.push({ ...branch.node, depth });
    flattenOrgTree(branch.children, depth + 1, out);
  }
  return out;
}

const ORG_INDENT = 16;
function drawOrgChart(doc, ctx, orgMap, yStart) {
  const rows = flattenOrgTree(buildOrgChartTree(orgMap));
  if (!rows.length) return yStart;

  let y = breakIfNeeded(doc, ctx, yStart, 56);
  y = drawHeading(doc, 'Likely Org Chart', y) + 14;
  setText(doc, MUTED_TEXT);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.text('Inferred from saved contacts and CRM evidence — not an official org chart', MARGIN, y);
  y += 12;

  for (const node of rows) {
    const x = MARGIN + node.depth * ORG_INDENT;
    const tagBits = [String(node.status || 'identified').toUpperCase()];
    if (node.contact_id) tagBits.push('SAVED');
    const tag = tagBits.join(' · ');
    const nameW = CONTENT_W - node.depth * ORG_INDENT - 10 - (tag.length * 4.6 + 12);
    const nameLines = wrap(doc, node.name, Math.max(nameW, 120));
    const need = Math.max(12, nameLines.length * 11);
    y = breakIfNeeded(doc, ctx, y, need);
    if (isFull(doc, y, need)) break;

    // Self-contained connector elbow back to the parent's indent column.
    if (node.depth > 0) {
      setStroke(doc, BORDER);
      doc.setLineWidth(0.9);
      const elbowX = x - ORG_INDENT + 2.4;
      doc.line(elbowX, y - 9.5, elbowX, y - 2.6);
      doc.line(elbowX, y - 2.6, x - 1.6, y - 2.6);
    }

    setFill(doc, orgStatusColor(node.status));
    doc.circle(x + 2.4, y - 2.6, 2.4, 'F');
    setText(doc, INK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(nameLines, x + 10, y);

    setText(doc, orgStatusColor(node.status));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text(tag, PAGE_W - MARGIN, y, { align: 'right' });

    y += need + 3;
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
  const left = `Recast Software  |  ${title || 'Partner'} — Partner Maturity Analysis  |  Generated ${genDate}`;
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

function formatSubtitle(partner, kpis) {
  const p = partner || {};
  const k = kpis || {};
  const bits = [
    String(p.partner_type || k.partner_type || '').trim(),
    String(p.tier || k.tier || '').trim(),
    String(p.region || k.region || '').trim(),
  ].filter(Boolean);
  return bits.join('  ·  ');
}

function formatGenDate() {
  const iso = new Date().toISOString().slice(0, 10);
  return formatDate(iso) || iso;
}

/**
 * Build the Partner Analyzer PDF from a parsed partner analysis. Returns a
 * Blob of type "application/pdf". Bounded to MAX_PAGES pages.
 *
 * @param {object} payload
 * @param {object} payload.analysis  Parsed partner-analysis JSON (partner-analyzer-schema.js).
 * @param {object} [payload.board]   Pre-derived board; derived from analysis when omitted.
 * @param {object} [payload.partner] Partners row (title/subtitle source).
 * @param {object} [payload.kpis]    Deterministic KPI strip.
 * @param {object} [payload.health]  Relationship health { status, label }.
 * @param {string[]} [payload.coverageWarnings]  Non-fatal coverage notes.
 * @param {object} [options]  { timeoutMs } forwarded to waitForJsPdf.
 * @returns {Promise<Blob>}
 */
export async function buildPartnerAnalysisPdf({ analysis, board, partner, kpis, health, coverageWarnings = [] } = {}, options) {
  if (!analysis || typeof analysis !== 'object') {
    throw new Error('buildPartnerAnalysisPdf: expected a parsed partner analysis object');
  }

  const JsPDF = await waitForJsPdf(options || {});
  const doc = new JsPDF({ unit: 'pt', format: 'letter', compress: true });

  const resolvedBoard = board || derivePartnerBoard(analysis);
  const position = resolvePartnerPosition(resolvedBoard);
  const furthest = resolveFurthestDemonstrated(resolvedBoard);
  const title = String(analysis.partner_name || (partner && partner.display_name) || 'Partner').trim() || 'Partner';
  const confidence = String(analysis.confidence || 'low');
  const genDate = formatGenDate();

  const ctx = { title };

  drawHeaderBand(doc, title, formatSubtitle(partner, kpis), genDate);
  let y = HEADER_H + 22;

  y = drawPositionStrip(doc, ctx, resolvedBoard, position, furthest, confidence, health, y);
  y = drawContext(doc, ctx, kpis, y);
  y = drawOverview(doc, ctx, analysis, y);
  y = drawStageBoard(doc, ctx, resolvedBoard, y);
  y = drawOrgChart(doc, ctx, analysis.org_map, y);
  y = drawList(doc, ctx, 'Do This Next', 'The most useful next best actions', analysis.next_actions, y);
  y = drawList(doc, ctx, 'Maturity Gaps', 'What is missing to advance the operational stage', analysis.gaps, y);
  y = drawList(doc, ctx, 'Open Questions', 'What the evidence leaves unanswered', analysis.open_questions, y);
  y = drawList(doc, ctx, 'Relationship Risks', 'Risks to the relationship', analysis.risks, y);
  y = drawList(doc, ctx, 'Positive Momentum', 'What is going well', analysis.momentum, y);
  drawCoverage(doc, ctx, coverageWarnings, y);

  drawFooters(doc, title, genDate);

  return doc.output('blob');
}
