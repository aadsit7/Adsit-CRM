// ============================================================
// Timeline PDF Builder — browser-side (jsPDF + jspdf-autotable)
// ============================================================
// Produces a Recast-branded opportunity timeline PDF.
// jsPDF + jspdf-autotable loaded via CDN in index.html.
// ============================================================

// ── Palette ───────────────────────────────────────────────────
const PRIMARY_BLUE = [0, 0, 204]; // Primary Blue   #0000CC
const DARK_TEXT    = [26, 26, 46]; // Dark Text      #1A1A2E
const BODY_TEXT    = [74, 74, 90]; // Medium Gray    #4A4A5A
const MUTED_TEXT   = [103, 103, 122]; // Muted text     #67677A
const CHECK_GREEN  = [15, 122, 63]; // Green          #0F7A3F
const LIGHT_BORDER = [221, 221, 238]; // Divider        #DDDDEE
const BG_LIGHT     = [240, 240, 246]; // Light Gray     #F0F0F6
const WHITE        = [255, 255, 255];

// ── Page geometry ─────────────────────────────────────────────
const PAGE_W    = 612;
const PAGE_H    = 792;
const MARGIN    = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;

// ── Filename helper ───────────────────────────────────────────
export function timelineFilename(customerName) {
  const today = new Date().toISOString().slice(0, 10);
  const slug = String(customerName || 'opportunity')
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 60) || 'opportunity';
  return `Timeline_${slug}_${today}.pdf`;
}

// ── jsPDF loader ──────────────────────────────────────────────
async function waitForJsPdf(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const jspdf = g.jspdf || g.jsPDF;
    const JsPDF = jspdf && jspdf.jsPDF;
    if (JsPDF && typeof JsPDF.API?.autoTable === 'function') return JsPDF;
    if (Date.now() >= deadline) throw new Error('jsPDF or jspdf-autotable did not load in time.');
    await new Promise(r => setTimeout(r, 50));
  }
}

// ── Primitives ────────────────────────────────────────────────
function setFill(doc, rgb)   { doc.setFillColor(rgb[0], rgb[1], rgb[2]); }
function setText(doc, rgb)   { doc.setTextColor(rgb[0], rgb[1], rgb[2]); }
function wrap(doc, text, w)  { return doc.splitTextToSize(String(text || ''), w); }

// Add a new page if y + needed would overflow the footer zone.
function pageBreakIfNeeded(doc, y, needed = 40) {
  if (y + needed > PAGE_H - MARGIN - 10) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

// ── Page 1 header band ────────────────────────────────────────
const HEADER_H = 88;

function drawPage1Header(doc, title, subtitle, dateRange) {
  setFill(doc, PRIMARY_BLUE);
  doc.rect(0, 0, PAGE_W, HEADER_H, 'F');

  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(21);
  doc.text(String(title || 'Opportunity Timeline'), MARGIN, 36);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  if (subtitle) doc.text(String(subtitle), MARGIN, 54);

  doc.setFontSize(9);
  if (dateRange) doc.text(String(dateRange), MARGIN, 72);
}

// ── Phase page header (pages 2+) ──────────────────────────────
const PHASE_HEADER_H = 30;

function drawPhaseHeader(doc, phaseName, dateRange) {
  setFill(doc, PRIMARY_BLUE);
  doc.rect(0, 0, PAGE_W, PHASE_HEADER_H, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(String(phaseName || ''), MARGIN, 21);
  if (dateRange) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(String(dateRange), PAGE_W - MARGIN, 21, { align: 'right' });
  }
}

// ── Section heading bar ───────────────────────────────────────
const HEADING_H = 16;

function drawHeading(doc, label, y) {
  setFill(doc, PRIMARY_BLUE);
  doc.rect(MARGIN, y, CONTENT_W, HEADING_H, 'F');
  setText(doc, WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(String(label).toUpperCase(), MARGIN + 8, y + HEADING_H - 4);
  return y + HEADING_H;
}

// ── Executive Summary (page 1) ────────────────────────────────
function drawExecutiveSummary(doc, summary, keyFacts, yStart) {
  let y = drawHeading(doc, 'Executive Summary', yStart);
  y += 10;

  if (summary) {
    setText(doc, BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const lines = wrap(doc, summary, CONTENT_W);
    doc.text(lines, MARGIN, y);
    y += lines.length * 12 + 10;
  }

  const facts = (keyFacts || []).filter(f => f?.label || f?.value);
  if (facts.length > 0) {
    const rowH = 20;
    for (let i = 0; i < facts.length; i++) {
      setFill(doc, i % 2 === 0 ? BG_LIGHT : WHITE);
      doc.rect(MARGIN, y, CONTENT_W, rowH, 'F');

      setText(doc, MUTED_TEXT);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.text(String(facts[i].label || ''), MARGIN + 6, y + 8);

      setText(doc, DARK_TEXT);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(String(facts[i].value || ''), MARGIN + 6, y + 16);

      y += rowH;
    }
    y += 6;
  }

  return y;
}

// ── Phase entries ─────────────────────────────────────────────
function drawPhaseEntries(doc, entries, yStart) {
  let y = yStart;

  for (const entry of (entries || [])) {
    const bullets  = (entry.bullets || []).map(b => String(b || '').trim()).filter(Boolean);
    const outcome  = String(entry.outcome || '').trim();
    const headline = [entry.date, entry.title].filter(Boolean).join(' — ');

    // Estimate height to decide if we need a page break
    const headLines = wrap(doc, headline, CONTENT_W);
    const bulletH   = bullets.reduce((s, b) => s + wrap(doc, b, CONTENT_W - 22).length * 11, 0);
    const needed    = headLines.length * 13 + 8 + bulletH + (outcome ? 14 : 0) + 12;
    y = pageBreakIfNeeded(doc, y, needed);

    // Bold headline
    setText(doc, DARK_TEXT);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(headLines, MARGIN, y);
    y += headLines.length * 13 + 4;

    // Bullets
    setText(doc, BODY_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    for (const b of bullets) {
      const bLines = wrap(doc, b, CONTENT_W - 22);
      doc.text('•', MARGIN + 6, y);
      doc.text(bLines, MARGIN + 16, y);
      y += bLines.length * 11 + 2;
    }

    // Outcome in green
    if (outcome) {
      setText(doc, CHECK_GREEN);
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9.5);
      const oLines = wrap(doc, `→ ${outcome}`, CONTENT_W - 16);
      doc.text(oLines, MARGIN + 8, y + 4);
      y += oLines.length * 11 + 6;
    }

    y += 10;
  }

  return y;
}

// ── Status tracker table ──────────────────────────────────────
function drawStatusTracker(doc, items, yStart) {
  if (!items || items.length === 0) return yStart;

  let y = pageBreakIfNeeded(doc, yStart + 8, 80);
  y = drawHeading(doc, 'Current Status Tracker', y);

  const body = items.map(item => {
    const s = String(item.status || '').toLowerCase();
    const marker = s === 'completed'
      ? '✔  completed'
      : (s === 'in_progress' || s === 'next')
          ? `■  ${item.status}`
          : `■  ${item.status}`;
    return [String(item.item || ''), marker, String(item.detail || '')];
  });

  doc.autoTable({
    startY: y + 4,
    head: [['Item', 'Status', 'Detail']],
    body,
    theme: 'grid',
    margin: { left: MARGIN, right: MARGIN },
    styles: {
      font: 'helvetica', fontSize: 9,
      cellPadding: { top: 4, right: 6, bottom: 4, left: 6 },
      textColor: DARK_TEXT, lineColor: LIGHT_BORDER, lineWidth: 0.3,
    },
    headStyles: { fillColor: PRIMARY_BLUE, textColor: WHITE, fontStyle: 'bold', fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 150 },
      1: { cellWidth: 110 },
      2: { cellWidth: CONTENT_W - 260 },
    },
    didParseCell(data) {
      if (data.section !== 'body' || data.column.index !== 1) return;
      const raw = String(data.cell.raw || '').toLowerCase();
      if (raw.includes('completed')) {
        data.cell.styles.textColor = CHECK_GREEN;
        data.cell.styles.fontStyle = 'bold';
      } else if (raw.includes('in_progress') || raw.includes('next')) {
        data.cell.styles.textColor = PRIMARY_BLUE;
        data.cell.styles.fontStyle = 'bold';
      } else {
        data.cell.styles.textColor = MUTED_TEXT;
      }
    },
  });

  return doc.lastAutoTable?.finalY || y + 80;
}

// ── Stakeholders table ────────────────────────────────────────
function drawStakeholders(doc, stakeholders, yStart) {
  if (!stakeholders || stakeholders.length === 0) return yStart;

  let y = pageBreakIfNeeded(doc, yStart + 12, 80);
  y = drawHeading(doc, 'Key Stakeholders', y);

  const body = stakeholders.map(s => [
    String(s.name || ''), String(s.title || ''),
    String(s.company || ''), String(s.role || ''),
  ]);

  doc.autoTable({
    startY: y + 4,
    head: [['Name', 'Title', 'Company', 'Role']],
    body,
    theme: 'grid',
    margin: { left: MARGIN, right: MARGIN },
    styles: {
      font: 'helvetica', fontSize: 9,
      cellPadding: { top: 4, right: 6, bottom: 4, left: 6 },
      textColor: DARK_TEXT, lineColor: LIGHT_BORDER, lineWidth: 0.3,
    },
    headStyles: { fillColor: PRIMARY_BLUE, textColor: WHITE, fontStyle: 'bold', fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 100 },
      1: { cellWidth: 140 },
      2: { cellWidth: 110 },
      3: { cellWidth: CONTENT_W - 350 },
    },
  });

  return doc.lastAutoTable?.finalY || y + 60;
}

// ── Closing summary ───────────────────────────────────────────
function drawClosingSummary(doc, text, yStart) {
  if (!text) return yStart;
  const y = pageBreakIfNeeded(doc, yStart + 14, 30);
  setText(doc, MUTED_TEXT);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9.5);
  doc.text(wrap(doc, text, CONTENT_W), MARGIN, y);
  return y;
}

// ── Two-pass footers ──────────────────────────────────────────
function drawFooters(doc, title) {
  const total   = doc.internal.getNumberOfPages();
  const genDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const left    = `Recast Software | ${String(title || 'Timeline')} | Generated ${genDate}`;
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    setText(doc, MUTED_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(left, MARGIN, PAGE_H - 18);
    doc.text(`Page ${p} of ${total}`, PAGE_W - MARGIN, PAGE_H - 18, { align: 'right' });
  }
}

// ── Public entry point ────────────────────────────────────────
/**
 * Build a Recast-branded Timeline PDF from the structured JSON payload.
 * Returns a Blob with type "application/pdf".
 *
 * @param {object} json          Parsed JSON from requestTimelineJsonPdf().
 * @param {object} [opportunity] Optional extras { customerName, ... }.
 */
export async function buildTimelinePdf(json, opportunity) {
  if (!json || typeof json !== 'object') {
    throw new Error('buildTimelinePdf: expected a parsed JSON object');
  }

  const JsPDF = await waitForJsPdf();
  const doc   = new JsPDF({ unit: 'pt', format: 'letter', compress: true });

  const title    = json.title    || `${json.customer_name || opportunity?.customerName || 'Opportunity'} Timeline`;
  const subtitle = json.subtitle || '';
  const dateRange = json.date_range || '';
  const phases   = Array.isArray(json.phases) ? json.phases.filter(p => p) : [];

  // ── Page 1 ──
  drawPage1Header(doc, title, subtitle, dateRange);
  let y = HEADER_H + 16;

  // TODO: Phase-dot visual timeline (deferred — leave 40pt empty space)
  y += 40;

  y = drawExecutiveSummary(doc, json.executive_summary, json.key_facts, y);

  // ── Pages 2+ — one page per phase ──
  for (const phase of phases) {
    if (!phase.phase_name && (!phase.entries || phase.entries.length === 0)) continue;
    doc.addPage();
    drawPhaseHeader(doc, phase.phase_name, phase.date_range);
    y = PHASE_HEADER_H + 16;
    y = drawPhaseEntries(doc, phase.entries, y);
  }

  // ── Status tracker, stakeholders, closing — continue on current page ──
  y = drawStatusTracker(doc, json.status_tracker, y);
  y = drawStakeholders(doc, json.stakeholders, y);
  drawClosingSummary(doc, json.closing_summary, y);

  // ── Footers — two-pass after all pages are known ──
  drawFooters(doc, title);

  return doc.output('blob');
}
