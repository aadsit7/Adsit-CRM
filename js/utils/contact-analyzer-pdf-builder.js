// ============================================================
// Contact Analyzer PDF Builder — browser-side (jsPDF)
// ============================================================
// A Recast-branded, print-friendly "Account Intelligence Brief" for one
// contact: executive summary, contact assessment, influence scores, why-this-
// classification, missing-stakeholder map, likely org map, account risk, the
// recommended next move, and the three-column seller focus. The layout mirrors
// the reference brief the sales team produces by hand.
//
// The brief passed in is the SAME validated object the on-screen board renders
// from (contact-analyzer-schema.js), so the PDF can never disagree with the
// page. jsPDF is loaded via <script defer> in index.html (window.jspdf).
// ============================================================

import { formatDate } from './date.js';
import { deriveContactBriefBoard } from './contact-analyzer-schema.js';

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
const MAX_PAGES = 6;

// ── Filename helpers ───────────────────────────────────────────
export function slugName(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'contact';
  const cleaned = raw
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 60);
  return cleaned.replace(/^[_-]+|[_-]+$/g, '') || 'contact';
}

/** `Account_Brief_{slug}_{YYYY-MM-DD}.pdf`. */
export function contactBriefFilename(contactName, dateISO) {
  const today = new Date().toISOString().slice(0, 10);
  const d = (typeof dateISO === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateISO)) ? dateISO.slice(0, 10) : today;
  return `Account_Brief_${slugName(contactName)}_${d}.pdf`;
}

// ── jsPDF loader (same contract as the sibling builders) ───────
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

function coverageColor(level) {
  switch (level) {
    case 'green': return SUCCESS;
    case 'red': return DANGER;
    default: return WARNING;
  }
}
function riskColor(overall) {
  switch (overall) {
    case 'LOW': return SUCCESS;
    case 'HIGH': return DANGER;
    default: return WARNING;
  }
}
function orgStatusColor(status) {
  switch (status) {
    case 'engaged': return SUCCESS;
    case 'introduced': return PRIMARY_LIGHT;
    case 'missing': return DANGER;
    default: return NEUTRAL; // identified
  }
}
function classificationColor(level) {
  switch (level) {
    case 'verified': return SUCCESS;
    case 'strong_inference': return WARNING;
    default: return MUTED_TEXT;
  }
}
function classificationLabel(level) {
  switch (level) {
    case 'verified': return 'Verified';
    case 'strong_inference': return 'Strong inference';
    default: return 'Inference';
  }
}
function scoreColor(score) {
  if (typeof score !== 'number') return NEUTRAL;
  if (score >= 7) return SUCCESS;
  if (score >= 4) return WARNING;
  return DANGER;
}

// ── Headers / footers ─────────────────────────────────────────
const HEADER_H = 84;
function drawHeaderBand(doc, title, subtitle, genDate) {
  setFill(doc, PRIMARY_BLUE);
  doc.rect(0, 0, PAGE_W, HEADER_H, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('ACCOUNT INTELLIGENCE BRIEF', MARGIN, 28);
  doc.setFontSize(21);
  doc.text(wrap(doc, title || 'Contact', CONTENT_W - 150)[0], MARGIN, 52);
  if (subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.text(wrap(doc, subtitle, CONTENT_W - 150)[0], MARGIN, 70);
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${genDate}`, PAGE_W - MARGIN, 28, { align: 'right' });
  doc.setFontSize(7.5);
  doc.text('CONFIDENTIAL — Internal Use Only', PAGE_W - MARGIN, 42, { align: 'right' });
}

const CONT_HEADER_H = 26;
function drawContinuationHeader(doc, title) {
  setFill(doc, PRIMARY_BLUE);
  doc.rect(0, 0, PAGE_W, CONT_HEADER_H, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Account Intelligence Brief', MARGIN, 17);
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

function drawFooters(doc, footerLine) {
  const total = doc.internal.getNumberOfPages();
  for (let p = 1; p <= total; p += 1) {
    doc.setPage(p);
    setStroke(doc, BORDER);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, FOOTER_Y - 8, PAGE_W - MARGIN, FOOTER_Y - 8);
    setText(doc, MUTED_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(footerLine, MARGIN, FOOTER_Y);
    doc.text(`Page ${p} of ${total}`, PAGE_W - MARGIN, FOOTER_Y, { align: 'right' });
  }
}

function formatGenDate() {
  const iso = new Date().toISOString().slice(0, 10);
  return formatDate(iso) || iso;
}

// ── Reusable content blocks ───────────────────────────────────
// A label→value grid row (two-line: bold uppercase label, wrapped value).
function drawKeyValues(doc, ctx, rows, yStart, { labelW = 130 } = {}) {
  let y = yStart;
  doc.setFontSize(9);
  for (const [label, value, valueColor] of rows) {
    const text = String(value == null ? '' : value).trim();
    if (!text) continue;
    const lines = wrap(doc, text, CONTENT_W - labelW);
    const need = Math.max(13, lines.length * 11);
    y = breakIfNeeded(doc, ctx, y, need);
    if (isFull(doc, y, need)) break;
    setText(doc, MUTED_TEXT);
    doc.setFont('helvetica', 'bold');
    doc.text(wrap(doc, String(label).toUpperCase(), labelW - 6), MARGIN, y);
    setText(doc, valueColor || INK);
    doc.setFont('helvetica', 'normal');
    doc.text(lines, MARGIN + labelW, y);
    y += need + 3;
  }
  return y;
}

// A titled callout line with a colored glyph (used for likely-is / gap / move).
function drawCallout(doc, ctx, glyphColor, title, text, y) {
  const body = String(text || '').trim();
  if (!body) return y;
  const label = title ? `${title}: ` : '';
  const lines = wrap(doc, label + body, CONTENT_W - 14);
  const need = lines.length * 11 + 3;
  y = breakIfNeeded(doc, ctx, y, need);
  if (isFull(doc, y, need)) return y;
  setFill(doc, glyphColor);
  doc.circle(MARGIN + 3, y - 2.6, 2.2, 'F');
  setText(doc, BODY_TEXT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  // Draw the title bold inline by overprinting, then the body — simplest is a
  // single wrapped block; keep it readable with the leading label in bold.
  if (title) {
    setText(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.text(`${title}:`, MARGIN + 12, y);
    const indent = doc.getTextWidth(`${title}: `);
    const firstLineW = CONTENT_W - 14 - indent;
    const reflow = wrap(doc, body, CONTENT_W - 14);
    setText(doc, BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    // Put body on the same line if it fits, else wrap under.
    if (doc.getTextWidth(reflow[0]) <= firstLineW && reflow.length === 1) {
      doc.text(reflow[0], MARGIN + 12 + indent, y);
      return y + 13;
    }
    doc.text(reflow, MARGIN + 12, y + 11);
    return y + 11 + reflow.length * 11 + 3;
  }
  doc.text(lines, MARGIN + 12, y);
  return y + need;
}

// A bulleted list under a heading (reused for risk factors, sources).
function drawBullets(doc, ctx, items, yStart, { color = PRIMARY_LIGHT, cap = 12 } = {}) {
  const list = (Array.isArray(items) ? items : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, cap);
  let y = yStart;
  const textX = MARGIN + 12;
  const listW = CONTENT_W - 12;
  for (const item of list) {
    const lines = wrap(doc, item, listW);
    const need = lines.length * 11;
    y = breakIfNeeded(doc, ctx, y, need);
    if (isFull(doc, y, need)) break;
    setFill(doc, color);
    doc.circle(MARGIN + 4, y - 2.4, 1.5, 'F');
    setText(doc, BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(lines, textX, y);
    y += need + 4;
  }
  return y;
}

// ── Section: Executive Summary ────────────────────────────────
function drawExecutiveSummary(doc, ctx, es, y) {
  y = drawHeading(doc, 'Executive Summary', y) + 16;

  const covLevel = es.coverage_status?.level || 'yellow';
  const covText = `${covLevel.charAt(0).toUpperCase()}${covLevel.slice(1)}${es.coverage_status?.note ? ` — ${es.coverage_status.note}` : ''}`;

  y = drawKeyValues(doc, ctx, [
    ['Company', es.company],
    ['Contact', es.contact],
    ['Primary ICP bucket', es.primary_icp_bucket],
    ['Coverage status', covText, coverageColor(covLevel)],
    ['Account maturity', es.account_maturity],
  ], y);

  y += 4;
  y = drawCallout(doc, ctx, PRIMARY_BLUE, 'What this person likely is', es.likely_is, y);
  y = drawCallout(doc, ctx, NEUTRAL, 'What this person likely is not', es.likely_is_not, y);
  y = drawCallout(doc, ctx, WARNING, 'Biggest gap', es.biggest_gap, y);
  y = drawCallout(doc, ctx, SUCCESS, 'Best next move', es.best_next_move, y);
  return y + 8;
}

// ── Section: Contact Assessment ───────────────────────────────
function drawContactAssessment(doc, ctx, ca, y) {
  const has = ca.likely_responsibility || ca.confidence || ca.what_they_care_about || ca.recast_focus;
  if (!has) return y;
  y = drawHeading(doc, 'Contact Assessment', y) + 16;
  y = drawKeyValues(doc, ctx, [
    ['Likely responsibility', ca.likely_responsibility],
    ['Confidence', ca.confidence],
    ['What they care about', ca.what_they_care_about],
    ['Recast focus', ca.recast_focus],
  ], y);
  return y + 8;
}

// ── Section: Influence Scores ─────────────────────────────────
function drawInfluenceScores(doc, ctx, scores, avg, y) {
  const list = Array.isArray(scores) ? scores : [];
  if (!list.length) return y;
  y = drawHeading(doc, 'Influence Scores', y) + 14;

  if (typeof avg === 'number') {
    setText(doc, MUTED_TEXT);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.text(`Average influence ${avg}/10 across ${list.length} dimensions`, MARGIN, y);
    y += 12;
  }

  const barX = MARGIN + 150;
  const barW = 90;
  for (const row of list) {
    const reason = String(row.reason || '').trim();
    const reasonLines = reason ? wrap(doc, reason, CONTENT_W) : [];
    const need = 12 + reasonLines.length * 10 + 4;
    y = breakIfNeeded(doc, ctx, y, need);
    if (isFull(doc, y, need)) break;

    // Dimension + score
    setText(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(wrap(doc, row.dimension, 140)[0], MARGIN, y);

    const hasScore = typeof row.score === 'number';
    // Score bar
    setFill(doc, BORDER);
    doc.roundedRect(barX, y - 6, barW, 5, 1.5, 1.5, 'F');
    if (hasScore) {
      const filled = Math.max(0, Math.min(1, row.score / 10)) * barW;
      if (filled > 0) { setFill(doc, scoreColor(row.score)); doc.roundedRect(barX, y - 6, filled, 5, 1.5, 1.5, 'F'); }
    }
    setText(doc, hasScore ? scoreColor(row.score) : MUTED_TEXT);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(hasScore ? `${row.score}/10` : '—', barX + barW + 8, y - 1.5);

    y += 12;
    if (reasonLines.length) {
      setText(doc, MUTED_TEXT);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(reasonLines, MARGIN, y);
      y += reasonLines.length * 10;
    }
    y += 4;
  }
  return y + 6;
}

// ── Section: Why this classification ──────────────────────────
function drawClassification(doc, ctx, items, y) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return y;
  y = drawHeading(doc, 'Why This Classification', y) + 14;
  for (const row of list) {
    const badge = classificationLabel(row.level);
    const text = String(row.text || '').trim();
    if (!text) continue;
    const combined = `${badge} — ${text}`;
    const lines = wrap(doc, combined, CONTENT_W - 12);
    const need = lines.length * 11 + 2;
    y = breakIfNeeded(doc, ctx, y, need);
    if (isFull(doc, y, need)) break;
    setFill(doc, classificationColor(row.level));
    doc.circle(MARGIN + 4, y - 2.4, 2, 'F');
    // Badge in its color, then body.
    setText(doc, classificationColor(row.level));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(`${badge} —`, MARGIN + 12, y);
    const indent = doc.getTextWidth(`${badge} — `);
    setText(doc, BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    const bodyLines = wrap(doc, text, CONTENT_W - 12 - indent);
    doc.text(bodyLines[0] || '', MARGIN + 12 + indent, y);
    if (bodyLines.length > 1) {
      const rest = wrap(doc, bodyLines.slice(1).join(' '), CONTENT_W - 12);
      doc.text(rest, MARGIN + 12, y + 11);
      y += 11 + rest.length * 11;
    }
    y += 13;
  }
  return y + 6;
}

// ── Section: Missing stakeholder map ──────────────────────────
function drawStakeholders(doc, ctx, list, y) {
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) return y;
  y = drawHeading(doc, 'Missing Stakeholder Map', y) + 14;
  setText(doc, MUTED_TEXT);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.text('Who is not yet in the room', MARGIN, y);
  y += 12;

  let n = 0;
  for (const s of rows) {
    n += 1;
    const roleLine = `${n}. ${String(s.role || '').trim()}${s.icp_bucket ? `  ·  ${s.icp_bucket}` : ''}`;
    const why = String(s.why_needed || '').trim();
    const conv = String(s.recommended_conversation || '').trim();
    const roleLines = wrap(doc, roleLine, CONTENT_W);
    const whyLines = why ? wrap(doc, `Why: ${why}`, CONTENT_W - 12) : [];
    const convLines = conv ? wrap(doc, `Talk to them about: ${conv}`, CONTENT_W - 12) : [];
    const need = roleLines.length * 11 + whyLines.length * 10 + convLines.length * 10 + 8;
    y = breakIfNeeded(doc, ctx, y, need);
    if (isFull(doc, y, need)) break;

    setText(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(roleLines, MARGIN, y);
    y += roleLines.length * 11;
    setText(doc, BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    if (whyLines.length) { doc.text(whyLines, MARGIN + 12, y); y += whyLines.length * 10; }
    if (convLines.length) { doc.text(convLines, MARGIN + 12, y); y += convLines.length * 10; }
    y += 8;
  }
  return y + 4;
}

// ── Section: Likely org map (indented tree) ───────────────────
function drawOrgMap(doc, ctx, nodes, y) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return y;
  y = drawHeading(doc, 'Likely Organizational Map', y) + 14;
  setText(doc, MUTED_TEXT);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.text('Inferred structure — not an official org chart', MARGIN, y);
  y += 12;

  for (const node of list) {
    const indent = MARGIN + Math.min(node.depth || 0, 6) * 16;
    const nameLines = wrap(doc, node.name, CONTENT_W - (indent - MARGIN) - 70);
    const need = Math.max(12, nameLines.length * 11);
    y = breakIfNeeded(doc, ctx, y, need);
    if (isFull(doc, y, need)) break;
    setFill(doc, orgStatusColor(node.status));
    doc.circle(indent + 2, y - 2.6, 2.4, 'F');
    setText(doc, INK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(nameLines, indent + 10, y);
    // status tag at right
    setText(doc, orgStatusColor(node.status));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text(String(node.status || '').toUpperCase(), PAGE_W - MARGIN, y, { align: 'right' });
    y += need + 3;
  }
  return y + 6;
}

// ── Section: Account risk ─────────────────────────────────────
function drawRisk(doc, ctx, risk, y) {
  const r = risk || {};
  if (!r.overall && !(r.factors || []).length) return y;
  y = drawHeading(doc, 'Account Risk', y) + 15;
  setText(doc, riskColor(r.overall));
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(`Overall risk: ${r.overall || 'MODERATE'}`, MARGIN, y);
  y += 15;
  y = drawBullets(doc, ctx, r.factors, y, { color: riskColor(r.overall) });
  return y + 6;
}

// ── Section: Recommended next move ────────────────────────────
function drawNextMove(doc, ctx, nm, y) {
  const m = nm || {};
  const has = m.immediate_objective || m.next_role_to_engage || m.next_meeting || m.suggested_ask;
  if (!has) return y;
  y = drawHeading(doc, 'Recommended Next Move', y) + 16;
  y = drawKeyValues(doc, ctx, [
    ['Immediate objective', m.immediate_objective],
    ['Next role to engage', m.next_role_to_engage],
    ['Next meeting', m.next_meeting],
  ], y);
  const ask = String(m.suggested_ask || '').trim();
  if (ask) {
    const lines = wrap(doc, ask, CONTENT_W - 20);
    const need = lines.length * 11 + 16;
    y = breakIfNeeded(doc, ctx, y, need);
    setFill(doc, [244, 247, 255]);
    setStroke(doc, PRIMARY_LIGHT);
    doc.setLineWidth(0.6);
    doc.roundedRect(MARGIN, y - 2, CONTENT_W, lines.length * 11 + 14, 3, 3, 'FD');
    setText(doc, MUTED_TEXT);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text('SUGGESTED ASK', MARGIN + 8, y + 8);
    setText(doc, INK);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.text(lines, MARGIN + 8, y + 19);
    y += lines.length * 11 + 18;
  }
  return y + 8;
}

// ── Section: Seller focus (three labeled lists) ───────────────
function drawSellerFocus(doc, ctx, sf, y) {
  const f = sf || {};
  const groups = [
    ['Discuss now', f.discuss_now, SUCCESS],
    ['Do not force yet', f.do_not_force_yet, WARNING],
    ['Evidence to obtain', f.evidence_to_obtain, PRIMARY_LIGHT],
  ].filter(g => (g[1] || []).length);
  if (!groups.length) return y;

  y = drawHeading(doc, 'Seller Focus', y) + 14;
  for (const [label, items, color] of groups) {
    y = breakIfNeeded(doc, ctx, y, 24);
    setText(doc, color);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(String(label).toUpperCase(), MARGIN, y);
    y += 12;
    y = drawBullets(doc, ctx, items, y, { color });
    y += 4;
  }
  return y + 4;
}

// ── Section: Sources ──────────────────────────────────────────
function drawSources(doc, ctx, sources, y) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) return y;
  y = drawHeading(doc, 'Sources', y) + 14;
  for (const s of list.slice(0, 20)) {
    const label = String(s.label || s.url || '').trim();
    const url = String(s.url || '').trim();
    const text = url && url !== label ? `${label} — ${url}` : label;
    if (!text) continue;
    const lines = wrap(doc, text, CONTENT_W - 12);
    const need = lines.length * 10;
    y = breakIfNeeded(doc, ctx, y, need);
    if (isFull(doc, y, need)) break;
    setFill(doc, NEUTRAL);
    doc.circle(MARGIN + 4, y - 2.2, 1.3, 'F');
    setText(doc, MUTED_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(lines, MARGIN + 12, y);
    y += need + 3;
  }
  return y + 4;
}

/**
 * Build the Account Intelligence Brief PDF from a validated brief. Returns a
 * Blob of type "application/pdf". Bounded to MAX_PAGES pages.
 *
 * @param {object} payload
 * @param {object} payload.brief    Validated brief (contact-analyzer-schema.js).
 * @param {object} [payload.contact] The selected contact (title/subtitle fallback).
 * @param {object} [options]  { timeoutMs } forwarded to waitForJsPdf.
 * @returns {Promise<Blob>}
 */
export async function buildContactBriefPdf({ brief, contact } = {}, options) {
  if (!brief || typeof brief !== 'object') {
    throw new Error('buildContactBriefPdf: expected a parsed brief object');
  }

  const JsPDF = await waitForJsPdf(options || {});
  const doc = new JsPDF({ unit: 'pt', format: 'letter', compress: true });

  const board = deriveContactBriefBoard(brief);
  const es = brief.executive_summary || {};
  const name = String(brief.contact?.name || (contact && contact.name) || 'Contact').trim() || 'Contact';
  const company = String(brief.contact?.company || es.company || (contact && (contact.company || contact.partner_name)) || '').trim();
  const title = String(brief.contact?.title || (contact && contact.role) || '').trim();
  const subtitleBits = [company, title].filter(Boolean);
  const genDate = formatGenDate();
  const ctx = { title: name };

  drawHeaderBand(doc, name, subtitleBits.join('  ·  '), genDate);
  let y = HEADER_H + 22;

  y = drawExecutiveSummary(doc, ctx, es, y);
  y = drawContactAssessment(doc, ctx, brief.contact_assessment || {}, y);
  y = drawInfluenceScores(doc, ctx, brief.influence_scores, board.avgInfluence, y);
  y = drawClassification(doc, ctx, brief.why_this_classification, y);
  y = drawStakeholders(doc, ctx, brief.missing_stakeholders, y);
  y = drawOrgMap(doc, ctx, brief.org_map, y);
  y = drawRisk(doc, ctx, brief.account_risk, y);
  y = drawNextMove(doc, ctx, brief.recommended_next_move, y);
  y = drawSellerFocus(doc, ctx, brief.seller_focus, y);
  drawSources(doc, ctx, brief.sources, y);

  const footerCompany = company ? ` — not for distribution to ${company}` : '';
  drawFooters(doc, `Recast Software  |  Account Intelligence Brief  |  Internal Use Only${footerCompany}`);

  return doc.output('blob');
}
