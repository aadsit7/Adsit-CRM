// ============================================================
// MAP PDF Builder — browser-side (jsPDF + jspdf-autotable)
// ============================================================
// Produces a Recast-branded Mutual Action Plan PDF from a structured
// JSON payload returned by requestMapPdfJson(). Runs entirely in the
// browser — no backend, no sandbox, no Files API. Mirrors the visual
// style of the approved ReportLab reference in
// skills/recast-map-pdf/reference_map_pdf.py.
//
// jsPDF is loaded via CDN in index.html and exposed as window.jspdf.
// jspdf-autotable registers a .autoTable() method on the doc.
// ============================================================

// ── Brand palette ─────────────────────────────────────────────
const RECAST_BLUE   = [0,   0,   204];
const CORAL         = [224, 112, 80];
const INK           = [26,  26,  46];
const GREEN         = [15,  122, 63];
const AMBER         = [204, 136, 0];
const RED           = [204, 34,  34];
const CYAN          = [42,  127, 255];
const NAVY          = [30,  58,  138];
const LIGHT_BLUE    = [246, 248, 255];
const GREEN_TINT    = [232, 245, 238];
const AMBER_TINT    = [255, 244, 224];
const RED_TINT      = [252, 232, 232];
const GRAY_TINT     = [240, 240, 246];
const BORDER_GRAY   = [221, 221, 234];
const MUTED         = [136, 136, 136];
const WHITE         = [255, 255, 255];

// Letter @ default jsPDF units (pt). 612 × 792.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

// ── Filename + blob helpers ──────────────────────────────────

export function slugName(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'opportunity';
  const cleaned = raw
    .replace(/[^\w\s-]/g, '')        // drop punctuation (commas, dots, apostrophes, etc.)
    .replace(/\s+/g, '_')             // whitespace runs → single _
    .replace(/_+/g, '_')              // collapse consecutive _
    .replace(/^[_-]+|[_-]+$/g, '')    // trim leading/trailing _ or - from cleanup
    .slice(0, 60);                    // cap length before a final trim
  return cleaned.replace(/^[_-]+|[_-]+$/g, '') || 'opportunity';
}

/**
 * ISO-only filename. The date is ALWAYS today's generation date in
 * YYYY-MM-DD — never a human-readable form like "April 22, 2026" that
 * might sneak through from the JSON payload and slugify into garbage
 * (`April_20_`). The optional dateISO arg is accepted for caller
 * convenience but validated: anything that isn't YYYY-MM-DD is ignored
 * in favour of today.
 *
 * `sourceCount` is optional. When null/undefined it's omitted (voice
 * flow behaviour — byte-identical to the pre-V1.5 filename). When a
 * positive integer is passed, a `_Nsource(s)` suffix is appended so
 * the file stands out in Drive — `1source` when N=1, `Nsources` when
 * N>=2. Non-positive or non-integer values fall back to the no-suffix
 * filename rather than throwing, which keeps the click path resilient
 * if a caller accidentally passes zero descriptions (the selection UI
 * already blocks that with a disabled CTA).
 */
export function mapFilename(customerName, dateISO, sourceCount) {
  const today = new Date().toISOString().slice(0, 10);
  const d = (typeof dateISO === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateISO))
    ? dateISO.slice(0, 10)
    : today;
  const base = `MAP_${slugName(customerName)}_${d}`;
  if (sourceCount === null || sourceCount === undefined) return `${base}.pdf`;
  if (!Number.isInteger(sourceCount) || sourceCount < 1) return `${base}.pdf`;
  const suffix = sourceCount === 1 ? '1source' : `${sourceCount}sources`;
  return `${base}_${suffix}.pdf`;
}

// Promise → base64 string (no data: prefix). Matches what
// fileApiRequest() / Apps Script expects for the `fileData` field.
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

// ── jsPDF discovery ──────────────────────────────────────────
//
// Both jsPDF and jspdf-autotable are loaded via <script defer> in
// index.html. `defer` guarantees they execute in document order
// before DOMContentLoaded fires, so by the time a voice command
// reaches this module the globals should be ready. But "should be"
// isn't "are" — slow CDN, throttled CPU, user triggers the flow in
// the first seconds after page load, and the synchronous check from
// the V1 code was observed failing in a real portal session.
//
// Poll-wait instead. Returns the jsPDF constructor once both the
// library and the autoTable plugin are present.

const DEFAULT_READY_TIMEOUT_MS = 10_000;

export async function waitForJsPdf({ timeoutMs = DEFAULT_READY_TIMEOUT_MS, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const jspdf = g.jspdf || g.jsPDF;
    const JsPDF = jspdf && jspdf.jsPDF;
    // jspdf-autotable registers itself on jsPDF.API.autoTable when its
    // script runs. Checking API.autoTable is the most reliable probe
    // because it proves both libraries loaded AND their order was right.
    if (JsPDF && typeof JsPDF.API?.autoTable === 'function') {
      return JsPDF;
    }
    if (Date.now() >= deadline) {
      const which = !JsPDF
        ? 'jsPDF'
        : (typeof JsPDF.API?.autoTable !== 'function' ? 'jspdf-autotable' : 'jsPDF');
      throw new Error(
        `${which} didn't finish loading within ${Math.round(timeoutMs / 1000)}s. ` +
        'Check the <script> tags in index.html and the browser console for 404 / CORS errors on the CDN URLs.'
      );
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// ── Primitives ───────────────────────────────────────────────

function setFill(doc, rgb)   { doc.setFillColor(rgb[0], rgb[1], rgb[2]); }
function setStroke(doc, rgb) { doc.setDrawColor(rgb[0], rgb[1], rgb[2]); }
function setText(doc, rgb)   { doc.setTextColor(rgb[0], rgb[1], rgb[2]); }

// Measure-aware text wrap. jsPDF's splitTextToSize does roughly what we
// want but wants the width in the current unit — we're in pt already.
function wrapText(doc, text, maxW) {
  return doc.splitTextToSize(String(text || ''), maxW);
}

// ── Page 1 ───────────────────────────────────────────────────

// Compact header band: ~80pt of blue, Recast wordmark on the left,
// title + subtitle stacked on the right, coral divider underneath.
// Designed to reclaim vertical space on Page 1 relative to V1's
// oversized customer-name treatment.
const HEADER_BAND_H = 80;
const HEADER_DIVIDER_H = 3;
const HEADER_TOTAL_H = HEADER_BAND_H + HEADER_DIVIDER_H;

function drawPlusMarks(doc) {
  // Subtle "+" brand markers scattered in the upper band at low opacity.
  const saveGState = doc.saveGraphicsState ? doc.saveGraphicsState.bind(doc) : null;
  const restoreGState = doc.restoreGraphicsState ? doc.restoreGraphicsState.bind(doc) : null;
  if (saveGState) saveGState();
  if (doc.setGState && doc.GState) {
    try { doc.setGState(new doc.GState({ opacity: 0.25 })); } catch { /* graceful degrade */ }
  }
  setStroke(doc, WHITE);
  doc.setLineWidth(0.9);
  // Deterministic-ish scatter so every MAP PDF looks the same but not
  // mechanical. Positions are hand-picked to avoid colliding with text.
  const marks = [
    [150, 14, 4], [210, 28, 3], [275, 10, 4], [330, 24, 3],
    [150, 52, 3], [225, 60, 4], [280, 46, 3], [345, 56, 4],
    [180, 72, 3], [260, 72, 3],
  ];
  for (const [x, y, size] of marks) {
    doc.line(x - size, y, x + size, y);
    doc.line(x, y - size, x, y + size);
  }
  if (restoreGState) restoreGState();
}

function drawHeaderBand(doc, customerName, documentDate) {
  // Dark navy background band (Greenshield-style)
  setFill(doc, NAVY);
  doc.rect(0, 0, PAGE_W, HEADER_BAND_H, 'F');

  // Very subtle "+" brand markers in the centre zone of the band
  drawPlusMarks(doc);

  // Recast wordmark — bold "Recast" large, lighter "Software" below
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.text('Recast', MARGIN, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.text('Software', MARGIN, 58);

  // Right side: prominent document title on top, tight customer|date
  // metadata below. Customer name is secondary metadata — not a banner.
  const rightX = PAGE_W - MARGIN;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  doc.text('Meeting Recap & Mutual Action Plan', rightX, 36, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const customerStr = String(customerName || 'Opportunity').trim();
  const dateStr = String(documentDate || '').trim();
  const metaLine = dateStr ? `${customerStr}  |  ${dateStr}` : customerStr;
  doc.text(metaLine, rightX, 54, { align: 'right' });

  // Coral divider bar (#E07050) separating header from body
  setFill(doc, CORAL);
  doc.rect(0, HEADER_BAND_H, PAGE_W, HEADER_DIVIDER_H, 'F');
}

// Solid blue heading bar — the Priority-2 replacement for the underlined
// text treatment. Full content-width rectangle in Recast Primary Blue
// with white bolded label inside. Returns the y just below the bar so
// callers can chain.
const HEADING_BAR_H = 16;

function drawSectionHeading(doc, label, y) {
  setFill(doc, RECAST_BLUE);
  doc.rect(MARGIN, y, CONTENT_W, HEADING_BAR_H, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(String(label).toUpperCase(), MARGIN + 8, y + HEADING_BAR_H - 5);
  return y + HEADING_BAR_H;
}

function drawCheckBullet(doc, x, y) {
  setFill(doc, GREEN);
  doc.circle(x, y, 3, 'F');
  // Inline checkmark tick (two strokes) in white
  setStroke(doc, WHITE);
  doc.setLineWidth(0.9);
  doc.line(x - 1.4, y - 0.1, x - 0.3, y + 1.1);
  doc.line(x - 0.3, y + 1.1, x + 1.8, y - 1.2);
}

function drawSquareBullet(doc, x, y, rgb) {
  setFill(doc, rgb);
  doc.rect(x - 2.5, y - 2.5, 5, 5, 'F');
}

function drawMeetingRecap(doc, items, yStart) {
  let y = drawSectionHeading(doc, 'Meeting Recap', yStart);
  y += 14;
  setText(doc, INK);
  doc.setFontSize(10);
  for (const raw of (items || []).slice(0, 7)) {
    // Tolerate either the new {label, detail} shape or a legacy flat
    // string — the parser normalizes but a caller building the JSON
    // directly might still pass strings.
    const entry = typeof raw === 'string' ? { label: '', detail: raw } : (raw || {});
    const label = String(entry.label || '').trim();
    const detail = String(entry.detail || '').trim();
    if (!label && !detail) continue;

    drawCheckBullet(doc, MARGIN + 4, y - 2);

    const textX = MARGIN + 14;
    const textMaxW = CONTENT_W - 18;
    if (label && detail) {
      // Measure the bold label + ": " so the detail flows right after.
      doc.setFont('helvetica', 'bold');
      const labelText = `${label}:`;
      doc.text(labelText, textX, y);
      const labelW = doc.getTextWidth(labelText);
      doc.setFont('helvetica', 'normal');
      // If label+detail fits on one line, render inline; otherwise wrap
      // the detail under the label from the same indent.
      const detailW = doc.getTextWidth(' ' + detail);
      if (labelW + detailW <= textMaxW) {
        doc.text(' ' + detail, textX + labelW, y);
        y += 13;
      } else {
        const wrapped = wrapText(doc, detail, textMaxW);
        y += 12;
        doc.text(wrapped, textX, y);
        y += wrapped.length * 11 + 2;
      }
    } else if (label) {
      doc.setFont('helvetica', 'bold');
      const wrapped = wrapText(doc, label, textMaxW);
      doc.text(wrapped, textX, y);
      doc.setFont('helvetica', 'normal');
      y += wrapped.length * 12 + 2;
    } else {
      doc.setFont('helvetica', 'normal');
      const wrapped = wrapText(doc, detail, textMaxW);
      doc.text(wrapped, textX, y);
      y += wrapped.length * 12 + 2;
    }
  }
  return y + 4;
}

// Draws a list of plain-string bullets under a bold subsection label.
// Returns the input y unchanged when items is empty — the whole
// subsection (heading bar + bullets) is skipped under the Golden Rule.
function drawEnvSubsection(doc, label, items, color, yStart) {
  const list = (items || []).map(s => String(s || '').trim()).filter(Boolean).slice(0, 5);
  if (list.length === 0) return yStart;
  setText(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(label, MARGIN, yStart);
  let y = yStart + 14;
  doc.setFont('helvetica', 'normal');
  for (const line of list) {
    const wrapped = wrapText(doc, line, CONTENT_W - 14);
    drawSquareBullet(doc, MARGIN + 3, y - 2, color);
    doc.text(wrapped, MARGIN + 12, y);
    y += wrapped.length * 11 + 2;
  }
  return y + 6;
}

// Infrastructure is richer than the other env subsections — each entry
// is {name, subline}. The name renders like a normal bullet; the subline
// sits underneath in muted colour and is suppressed when empty.
// Returns the input y unchanged when items is empty — the subsection is
// skipped entirely (heading + bullets) under the Golden Rule.
function drawInfrastructureSubsection(doc, items, yStart) {
  const entries = (items || [])
    .map(raw => (typeof raw === 'string' ? { name: raw, subline: '' } : (raw || {})))
    .map(entry => ({
      name: String(entry.name || '').trim(),
      subline: String(entry.subline || '').trim(),
    }))
    .filter(e => e.name)
    .slice(0, 10);
  if (entries.length === 0) return yStart;

  setText(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Infrastructure', MARGIN, yStart);
  let y = yStart + 14;
  for (const entry of entries) {
    drawSquareBullet(doc, MARGIN + 3, y - 2, CYAN);
    setText(doc, INK);
    doc.setFont('helvetica', 'bold');
    const nameWrapped = wrapText(doc, entry.name, CONTENT_W - 14);
    doc.text(nameWrapped, MARGIN + 12, y);
    y += nameWrapped.length * 11;

    if (entry.subline) {
      setText(doc, MUTED);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      const subWrapped = wrapText(doc, entry.subline, CONTENT_W - 14);
      y += 9;
      doc.text(subWrapped, MARGIN + 12, y);
      y += subWrapped.length * 10;
      doc.setFontSize(10);
    }
    y += 3;
  }
  return y + 6;
}

// Whole-section gate: if infrastructure, pain, and stakeholders are ALL
// empty, the blue "YOUR CURRENT ENVIRONMENT" heading is skipped too —
// the Meeting Recap and MAP table carry the page on their own.
function drawCurrentEnvironment(doc, env, yStart) {
  const infra = Array.isArray(env?.infrastructure) ? env.infrastructure : [];
  const pain = Array.isArray(env?.current_state_pain) ? env.current_state_pain : [];
  const stakeholders = Array.isArray(env?.stakeholders_and_decision_process)
    ? env.stakeholders_and_decision_process : [];
  const hasAny = infra.some(e => (typeof e === 'string' ? e.trim() : String(e?.name || '').trim()))
    || pain.some(s => String(s || '').trim())
    || stakeholders.some(s => String(s || '').trim());
  if (!hasAny) return yStart;

  let y = drawSectionHeading(doc, 'Your Current Environment', yStart);
  y += 14;
  y = drawInfrastructureSubsection(doc, infra, y);
  y = drawEnvSubsection(doc, 'Current State Pain Points',      pain,         RED,  y);
  y = drawEnvSubsection(doc, 'Stakeholders & Decision Process', stakeholders, NAVY, y);
  return y;
}

// Cell styler hook for autotable — colour-codes the Status column and
// adds a faint green left accent on Complete rows.
function makeMapTableDidParseCell(statusColIndex) {
  return function didParseCell(data) {
    if (data.section !== 'body') return;
    if (data.column.index === statusColIndex) {
      const raw = String(data.cell.raw || '').trim().toLowerCase();
      if (raw === 'complete') {
        data.cell.styles.fillColor = GREEN_TINT;
        data.cell.styles.textColor = GREEN;
        data.cell.styles.fontStyle = 'bold';
      } else if (raw === 'in progress') {
        data.cell.styles.fillColor = AMBER_TINT;
        data.cell.styles.textColor = AMBER;
        data.cell.styles.fontStyle = 'bold';
      } else if (raw === 'blocked') {
        data.cell.styles.fillColor = RED_TINT;
        data.cell.styles.textColor = RED;
        data.cell.styles.fontStyle = 'bold';
      } else {
        data.cell.styles.fillColor = GRAY_TINT;
        data.cell.styles.textColor = MUTED;
      }
    }
  };
}

function makeMapTableDidDrawCell(statusColIndex) {
  return function didDrawCell(data) {
    // Faint green left-border accent on whole Complete rows.
    if (data.section !== 'body') return;
    if (data.column.index !== 0) return;
    const row = data.row.raw || [];
    const status = String(row[statusColIndex] || '').trim().toLowerCase();
    if (status === 'complete') {
      setFill(data.doc, GREEN);
      data.doc.rect(data.cell.x, data.cell.y, 1.5, data.cell.height, 'F');
    }
  };
}

function drawMapTable(doc, rows, yStart) {
  const safeRows = (rows || []).filter(r => r && typeof r === 'object');
  // Golden-rule skip: if there are no MAP rows at all, suppress the
  // whole section — no heading bar, no empty table. This is an edge
  // case (most MAPs have action items) but if the source described
  // nothing actionable, a fabricated "No action items captured yet"
  // placeholder would violate the grounding contract.
  if (safeRows.length === 0) return yStart;

  const headingBottom = drawSectionHeading(doc, 'Mutual Action Plan', yStart);
  const body = safeRows.map(r => [
    r.phase || '',
    r.action || '',
    r.owner || '',
    r.due_date || '',
    r.status || 'Pending',
  ]);
  const statusColIndex = 4;
  doc.autoTable({
    startY: headingBottom + 6,
    head: [['Phase', 'Action', 'Owner', 'Due Date', 'Status']],
    body,
    theme: 'grid',
    margin: { left: MARGIN, right: MARGIN },
    styles: {
      font: 'helvetica',
      fontSize: 9,
      cellPadding: { top: 4, right: 6, bottom: 4, left: 6 },
      textColor: INK,
      lineColor: BORDER_GRAY,
      lineWidth: 0.3,
    },
    headStyles: {
      fillColor: RECAST_BLUE,
      textColor: WHITE,
      fontStyle: 'bold',
      halign: 'left',
      fontSize: 9,
    },
    alternateRowStyles: { fillColor: LIGHT_BLUE },
    columnStyles: {
      0: { cellWidth: 78  },
      1: { cellWidth: 208 },
      2: { cellWidth: 62  },
      3: { cellWidth: 68  },
      4: { cellWidth: 78, halign: 'center' },
    },
    didParseCell: makeMapTableDidParseCell(statusColIndex),
    didDrawCell:  makeMapTableDidDrawCell(statusColIndex),
  });
  return doc.lastAutoTable?.finalY || yStart + 100;
}

// ── Architecture page — 8-layer transformation infographic ───
//
// Rebuilt from a generic 3-box diagram in V1 to a customer-specific
// current-state → Application Workspace → proposed-state story. Layers
// (top to bottom):
//   1. "CURRENT ENVIRONMENT — [Customer]" blue heading + intro
//   2. Grid of 6-10 customer tool boxes ({name, subline})
//   3. Amber "Key Friction" callout (from current_state_pain)
//   4. Down-pointing triangle transition
//   5. "PROPOSED STATE — Application Workspace…" blue heading
//   6. 3-column diagram: Applications → APPLICATION WORKSPACE → Targets
//   7. "End Users" 4-box persona row
//   8. Green "What Changes" outcome callout

function drawToolBox(doc, x, y, w, h, name, subline) {
  setFill(doc, GRAY_TINT);
  setStroke(doc, BORDER_GRAY);
  doc.setLineWidth(0.6);
  doc.roundedRect(x, y, w, h, 4, 4, 'FD');
  setText(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  const nameLines = wrapText(doc, name || '', w - 10);
  const hasSub = subline && String(subline).trim();
  const nameStartY = hasSub ? y + 13 : y + h / 2 + 2;
  for (let i = 0; i < Math.min(nameLines.length, 2); i++) {
    doc.text(nameLines[i], x + w / 2, nameStartY + i * 10, { align: 'center' });
  }
  if (hasSub) {
    setText(doc, MUTED);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    const subLines = wrapText(doc, subline, w - 10);
    const subBaseY = nameStartY + Math.min(nameLines.length, 2) * 10 + 2;
    for (let i = 0; i < Math.min(subLines.length, 2); i++) {
      doc.text(subLines[i], x + w / 2, subBaseY + i * 8, { align: 'center' });
    }
  }
}

function drawCalloutBox(doc, y, bgRgb, textRgb, labelBold, body) {
  const padX = 10;
  const padY = 8;
  setText(doc, textRgb);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  const labelWidth = doc.getTextWidth(labelBold + ' ');
  doc.setFont('helvetica', 'normal');
  const bodyMaxW = CONTENT_W - padX * 2 - labelWidth;
  const bodyLines = wrapText(doc, body, bodyMaxW);
  // If the body wraps too much to stay aligned, fall back to two-line
  // layout: bold prefix on line 1, body wrapped below.
  const inline = bodyLines.length === 1;
  const height = inline
    ? padY * 2 + 12
    : padY * 2 + 12 + bodyLines.length * 11;
  setFill(doc, bgRgb);
  setStroke(doc, textRgb);
  doc.setLineWidth(0.4);
  doc.roundedRect(MARGIN, y, CONTENT_W, height, 4, 4, 'FD');
  if (inline) {
    setText(doc, textRgb);
    doc.setFont('helvetica', 'bold');
    doc.text(labelBold, MARGIN + padX, y + padY + 9);
    doc.setFont('helvetica', 'normal');
    doc.text(bodyLines[0], MARGIN + padX + labelWidth, y + padY + 9);
  } else {
    setText(doc, textRgb);
    doc.setFont('helvetica', 'bold');
    doc.text(labelBold, MARGIN + padX, y + padY + 9);
    doc.setFont('helvetica', 'normal');
    doc.text(bodyLines, MARGIN + padX, y + padY + 9 + 12);
  }
  return y + height;
}

function drawDownTriangle(doc, cx, yTop, size = 10) {
  setFill(doc, RECAST_BLUE);
  doc.triangle(cx - size, yTop, cx + size, yTop, cx, yTop + size * 1.2, 'F');
  return yTop + size * 1.2;
}

function pickStringList(list, max) {
  return (list || [])
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function drawArchitecturePage(doc, json) {
  const env = json?.current_environment || {};
  const infraEntries = (Array.isArray(env.infrastructure) ? env.infrastructure : [])
    .map(e => (typeof e === 'string' ? { name: e, subline: '' } : (e || {})))
    .filter(e => e && String(e.name || '').trim())
    .slice(0, 10);
  const pains = pickStringList(env.current_state_pain, 4);
  const personas = (Array.isArray(json?.end_users_personas) ? json.end_users_personas : [])
    .map(e => (typeof e === 'string' ? { label: e, subline: '' } : (e || {})))
    .filter(e => e && String(e.label || '').trim())
    .slice(0, 6);
  const whatChanges = String(json?.what_changes || '').trim();
  const customerName = json?.customer_name || '';

  // ── Header band: compact blue band to match Page 1 treatment ──
  setFill(doc, RECAST_BLUE);
  doc.rect(0, 0, PAGE_W, 60, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('HOW APPLICATION WORKSPACE FITS', MARGIN, 38);
  setFill(doc, CORAL);
  doc.rect(0, 60, PAGE_W, 3, 'F');

  let y = 75;

  // ── Layer 1: "CURRENT ENVIRONMENT — [Customer]" intro ─────────
  const layer1Label = customerName
    ? `Current Environment — ${customerName}`
    : 'Current Environment';
  y = drawSectionHeading(doc, layer1Label, y);
  y += 10;
  setText(doc, INK);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const introLines = wrapText(
    doc,
    'Based on our conversations, the following reflects your current systems architecture and the key infrastructure components involved in application delivery.',
    CONTENT_W,
  );
  doc.text(introLines, MARGIN, y);
  y += introLines.length * 11 + 10;

  // ── Layer 2: current-tools grid (3-10 {name, subline} boxes) ──
  // Skipped entirely when infrastructure is empty — no heading, no
  // "No infrastructure details captured" placeholder (which was itself
  // a subtle fabrication of narrative).
  if (infraEntries.length > 0) {
    y = drawSectionHeading(doc, 'Current State — Per-Platform Delivery, Multiple Dependencies', y);
    y += 10;
    const cols = infraEntries.length <= 4 ? 2 : 3;
    const gap = 10;
    const boxW = (CONTENT_W - gap * (cols - 1)) / cols;
    const boxH = 44;
    const rows = Math.ceil(infraEntries.length / cols);
    for (let i = 0; i < infraEntries.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = MARGIN + col * (boxW + gap);
      const by = y + row * (boxH + gap);
      drawToolBox(doc, x, by, boxW, boxH, infraEntries[i].name, infraEntries[i].subline);
    }
    y += rows * (boxH + gap);
  }

  // ── Layer 3: amber "Key Friction" callout ─────────────────────
  if (pains.length > 0) {
    const frictionBody = pains.join('  •  ');
    y = drawCalloutBox(doc, y + 2, AMBER_TINT, AMBER, 'Key Friction:', frictionBody);
  }

  // ── Layer 4: down-pointing triangle transition ────────────────
  y += 10;
  y = drawDownTriangle(doc, PAGE_W / 2, y, 8);
  y += 8;

  // ── Layer 5: "PROPOSED STATE" heading bar ─────────────────────
  y = drawSectionHeading(doc, 'Proposed State — Application Workspace as the Unified Delivery Layer', y);
  y += 12;

  // ── Layer 6: three-column diagram ─────────────────────────────
  const diagramH = 110;
  const leftW = 130;
  const centerW = 220;
  const rightW = 130;
  const gap6 = 12;
  const totalW = leftW + centerW + rightW + gap6 * 2;
  const baseX = MARGIN + Math.max(0, (CONTENT_W - totalW) / 2);
  const diagramY = y;

  // Applications box (left)
  setFill(doc, LIGHT_BLUE);
  setStroke(doc, RECAST_BLUE);
  doc.setLineWidth(0.6);
  doc.roundedRect(baseX, diagramY, leftW, diagramH, 5, 5, 'FD');
  setText(doc, RECAST_BLUE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Applications', baseX + leftW / 2, diagramY + 14, { align: 'center' });
  setText(doc, INK);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  const appsLines = wrapText(
    doc,
    'Custom apps + Setup Store catalog + Legacy apps',
    leftW - 14,
  );
  doc.text(appsLines, baseX + leftW / 2, diagramY + 32, { align: 'center' });

  // Arrow into the center
  setStroke(doc, CYAN);
  doc.setLineWidth(2);
  const a1y = diagramY + diagramH / 2;
  doc.line(baseX + leftW + 2, a1y, baseX + leftW + gap6 - 3, a1y);
  setFill(doc, CYAN);
  doc.triangle(
    baseX + leftW + gap6 - 3, a1y - 4,
    baseX + leftW + gap6 - 3, a1y + 4,
    baseX + leftW + gap6 + 1, a1y,
    'F',
  );

  // APPLICATION WORKSPACE center
  const centerX = baseX + leftW + gap6;
  setFill(doc, RECAST_BLUE);
  doc.roundedRect(centerX, diagramY, centerW, diagramH, 6, 6, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('APPLICATION WORKSPACE', centerX + centerW / 2, diagramY + 22, { align: 'center' });
  setText(doc, LIGHT_BLUE);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const capsLines = wrapText(
    doc,
    'Smart Icons • Conditional Launch • Custom Actions (replaces RES) • On-Demand Install / App Attach • Identity-Based • Context-Aware • User Profile Mgmt',
    centerW - 16,
  );
  doc.text(capsLines, centerX + centerW / 2, diagramY + 44, { align: 'center' });

  // Arrow into targets
  setStroke(doc, CYAN);
  doc.setLineWidth(2);
  const a2y = diagramY + diagramH / 2;
  doc.line(centerX + centerW + 2, a2y, centerX + centerW + gap6 - 3, a2y);
  setFill(doc, CYAN);
  doc.triangle(
    centerX + centerW + gap6 - 3, a2y - 4,
    centerX + centerW + gap6 - 3, a2y + 4,
    centerX + centerW + gap6 + 1, a2y,
    'F',
  );

  // Delivery targets column (right) — 1–4 stacked boxes driven by proposed_delivery_targets
  const rightX = centerX + centerW + gap6;
  const proposedTargets = (Array.isArray(json?.proposed_delivery_targets)
    ? json.proposed_delivery_targets : [])
    .map(e => (typeof e === 'string' ? { name: e, subline: '' } : (e || {})))
    .filter(e => e && String(e.name || '').trim())
    .slice(0, 4);
  const tCount = proposedTargets.length;
  const tGap = 3;
  const targetH = tCount > 0 ? (diagramH - tGap * (tCount - 1)) / tCount : diagramH;
  for (let i = 0; i < proposedTargets.length; i++) {
    const ty = diagramY + i * (targetH + tGap);
    setFill(doc, GRAY_TINT);
    setStroke(doc, BORDER_GRAY);
    doc.setLineWidth(0.5);
    doc.roundedRect(rightX, ty, rightW, targetH, 4, 4, 'FD');
    setText(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text(proposedTargets[i].name, rightX + rightW / 2, ty + 12, { align: 'center' });
    if (proposedTargets[i].subline) {
      setText(doc, MUTED);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text(proposedTargets[i].subline, rightX + rightW / 2, ty + 22, { align: 'center' });
    }
  }

  y = diagramY + diagramH + 14;

  // ── Layer 7: End Users persona row ───────────────────────────
  // Only renders when Claude returned grounded personas. Generic
  // fallback rows ("Office Workers / Remote / VDI Users / External
  // Users") were removed in V1.6 — they were customer-shaped narrative
  // that wasn't actually traceable to any source description.
  if (personas.length > 0) {
    setText(doc, RECAST_BLUE);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('End Users', MARGIN, y);
    y += 8;

    const pGap = 10;
    const pBoxW = (CONTENT_W - pGap * (personas.length - 1)) / personas.length;
    const pBoxH = 36;
    for (let i = 0; i < personas.length; i++) {
      const x = MARGIN + i * (pBoxW + pGap);
      setFill(doc, LIGHT_BLUE);
      setStroke(doc, BORDER_GRAY);
      doc.setLineWidth(0.5);
      doc.roundedRect(x, y, pBoxW, pBoxH, 4, 4, 'FD');
      setText(doc, NAVY);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text(personas[i].label, x + pBoxW / 2, y + 14, { align: 'center' });
      if (personas[i].subline) {
        setText(doc, MUTED);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.text(personas[i].subline, x + pBoxW / 2, y + 26, { align: 'center' });
      }
    }
    y += pBoxH + 14;
  }

  // ── Layer 8: green "What Changes" outcome callout ────────────
  // Only renders when Claude returned a grounded transformation
  // summary. The hardcoded "RES eliminated • Per-platform packaging
  // eliminated …" fallback was removed in V1.6 — when the source
  // doesn't describe outcomes, the architecture diagram itself is the
  // visual conclusion.
  if (whatChanges) {
    drawCalloutBox(doc, y, GREEN_TINT, GREEN, 'What Changes:', whatChanges);
  }
}

// ── Footer on every page ─────────────────────────────────────

function drawFooters(doc, customerName) {
  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    setText(doc, MUTED);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text('Recast Software', MARGIN, PAGE_H - 20);
    doc.text(`Page ${p} of ${totalPages}`, PAGE_W - MARGIN, PAGE_H - 20, { align: 'right' });
    const note = `Confidential — Prepared for ${customerName || 'the customer'}`;
    doc.text(note, PAGE_W / 2, PAGE_H - 20, { align: 'center' });
  }
}

// ── Public entry point ───────────────────────────────────────

/**
 * Build a Recast-branded MAP PDF from the structured JSON payload.
 * Returns a Blob with type "application/pdf".
 *
 * Async because it waits for jsPDF + jspdf-autotable to finish loading
 * from the CDN — safe no matter how fast the caller fires.
 *
 * @param {object} json       Parsed JSON from requestMapPdfJson().
 * @param {object} [opportunity] Optional extras (unused today; reserved
 *   for when Randy needs to embed deal_value / stage / etc.).
 * @param {object} [options]  { timeoutMs } forwarded to waitForJsPdf
 *                            (mostly a test hook).
 */
export async function buildMapPdf(json, opportunity, options) {
  if (!json || typeof json !== 'object') {
    throw new Error('buildMapPdf: expected a parsed JSON object');
  }
  const JsPDF = await waitForJsPdf(options || {});
  const doc = new JsPDF({ unit: 'pt', format: 'letter', compress: true });

  const customerName =
    json.customer_name ||
    opportunity?.customerName ||
    opportunity?.opportunityName ||
    '';
  const docDate = json.document_date || new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  // Page 1
  drawHeaderBand(doc, customerName, docDate);
  let y = HEADER_TOTAL_H + 20;
  y = drawMeetingRecap(doc, json.meeting_recap, y);
  y = drawCurrentEnvironment(doc, json.current_environment, y + 4);
  drawMapTable(doc, json.mutual_action_plan, y + 6);

  // Architecture page — conditional under the Golden Rule. Requires BOTH
  // an anchor (current infrastructure or pain) AND proposed delivery
  // targets. Without proposed targets the three-column diagram is
  // incomplete (arrows pointing into nothing) and the page heading
  // "HOW APPLICATION WORKSPACE FITS" would be misleading. Customers with
  // rich Current State data but no confirmed future direction receive a
  // clean 2-page MAP — their current environment remains visible on Page 1.
  // This is intentional: the page only renders when it can tell a complete
  // transformation story.
  const env = json.current_environment || {};
  const archPageHasAnchor =
    (Array.isArray(env.infrastructure) && env.infrastructure.length > 0) ||
    (Array.isArray(env.current_state_pain) && env.current_state_pain.length > 0);
  const hasProposedTargets =
    Array.isArray(json.proposed_delivery_targets) &&
    json.proposed_delivery_targets.length > 0;
  if (archPageHasAnchor && hasProposedTargets) {
    doc.addPage();
    drawArchitecturePage(doc, json);
  }

  // Footers last, once we know the final page count.
  drawFooters(doc, customerName);

  return doc.output('blob');
}
