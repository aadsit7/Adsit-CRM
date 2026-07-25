// ============================================================
// Analyzer export files — recognizing the PDFs the Analyzer writes
// ============================================================
// Every Analyzer "Create PDF" export is filed onto the record it describes
// (js/utils/analyzer-pdf-attach.js), so the shared Drive-backed file store —
// the `Opportunity_Documents` sheet — now contains the Analyzer's OWN output
// alongside the real customer/partner documents a user uploaded.
//
// Two things need to tell those apart, and both live here so one filename
// convention is defined exactly once:
//
//   1. EVIDENCE HYGIENE. An Analyzer export must never be read back in as
//      source evidence. Without this the Analyzer would OCR its own last
//      board into a fresh note and score the next run partly on its own
//      output — a feedback loop that compounds an early misread instead of
//      correcting it. `isAnalyzerExportPdf()` is the guard.
//
//   2. THE CONTACT BRIEF LINK. A contact's Account Intelligence Brief is
//      keyed by that contact's `contact_id`, so a list view can link straight
//      to it. The sheet lives in the SAME spreadsheet the portal already
//      reads with readSheetAsObjects(), so ONE cached read covers every
//      contact on the page instead of one Apps Script round-trip per row.
//
// PURE + SYNCHRONOUS BY DESIGN: no DOM, no network, no dates from the
// environment — every ranking input comes from the rows themselves, so the
// same rows always produce the same answer (and the whole module is unit
// testable).
// ============================================================

// The filename prefix written by contactBriefFilename() in
// js/utils/contact-analyzer-pdf-builder.js (`Account_Brief_{slug}_{date}.pdf`).
// A test pins the two together so a rename there can never silently stop
// matching here.
export const CONTACT_ANALYZER_PDF_PREFIX = 'Account_Brief_';

// Every Analyzer mode's export prefix, in the order the mode bar shows them:
//   Opportunity → `Analysis_{slug}_{date}.pdf`        (forecastFilename)
//   Event       → `Event_Analysis_{slug}_{date}.pdf`  (eventAnalysisFilename)
//   Partner     → `Partner_Analysis_{slug}_{date}.pdf`(partnerAnalysisFilename)
//   Contact     → `Account_Brief_{slug}_{date}.pdf`   (contactBriefFilename)
// Tests pin each one against the builder that produces it.
export const ANALYZER_EXPORT_PREFIXES = Object.freeze([
  'Analysis_',
  'Event_Analysis_',
  'Partner_Analysis_',
  CONTACT_ANALYZER_PDF_PREFIX,
]);

// The FULL generated shape — prefix, slug, and the `_YYYY-MM-DD` stamp every
// one of the four builders appends unconditionally. Matching the prefix alone
// would be far too greedy: a rep's own "Analysis_Q3_2025.pdf" or a vendor's
// "Partner_Analysis_by_deloitte.pdf" starts the same way, and dropping one of
// those from the evidence base is a silent loss of real evidence — strictly
// worse than letting an export through, because nothing on screen would say
// the document had been skipped. Requiring the date stamp costs nothing (no
// builder can omit it) and rules those out.
const ANALYZER_EXPORT_RE =
  /^(?:analysis|event_analysis|partner_analysis|account_brief)_.+_\d{4}-\d{2}-\d{2}\.pdf$/;

function str(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * Is this filename an Analyzer-generated export (any of the four modes)?
 *
 * Used to keep the Analyzer's own output out of the evidence base: these
 * files are DERIVED from the record, never independent evidence about it.
 */
export function isAnalyzerExportPdf(fileName) {
  return ANALYZER_EXPORT_RE.test(str(fileName).toLowerCase());
}

/**
 * Drop every Analyzer export from a file-store listing, keeping the real
 * uploads. Returns a new array; a non-array input yields [].
 */
export function withoutAnalyzerExports(files) {
  return (files || []).filter(f => f && !isAnalyzerExportPdf(f.file_name || f.name));
}

// ── The contact brief index ─────────────────────────────────────────

// Matched case-insensitively against the whole filename, and — like
// ANALYZER_EXPORT_RE — against the FULL generated shape including the
// `_YYYY-MM-DD` stamp. Nothing in the file store records which rows the
// Analyzer wrote, so the filename is the only provenance signal available;
// requiring the complete shape is what keeps a hand-uploaded
// "Account_Brief_from_customer.pdf" from being presented to a rep as an
// Analyzer-generated brief.
const CONTACT_BRIEF_RE = /^account_brief_.+_\d{4}-\d{2}-\d{2}\.pdf$/;

// The trailing `_YYYY-MM-DD` stamped by contactBriefFilename(). Read from the
// filename rather than the sheet's `date_added` cell because Google Sheets can
// re-format a date cell per the spreadsheet's locale, while the filename is a
// literal string the analyzer wrote and nothing rewrites.
const BRIEF_DATE_RE = /_(\d{4}-\d{2}-\d{2})\.pdf$/i;

/** Is this filename an Analyzer-generated contact brief? */
export function isContactAnalyzerPdf(fileName) {
  return CONTACT_BRIEF_RE.test(str(fileName).toLowerCase());
}

/** The `YYYY-MM-DD` stamped into a brief filename, or '' when absent. */
export function analyzerPdfDateFromName(fileName) {
  const m = BRIEF_DATE_RE.exec(str(fileName));
  return m ? m[1] : '';
}

/**
 * Is `a` a newer brief than `b`? Filename date first (lexical compare is
 * chronological for `YYYY-MM-DD`), then sheet order — the file store appends,
 * so a higher row index was uploaded later. A dated brief always beats an
 * undated one.
 */
export function isNewerAnalyzerPdf(a, b) {
  if (!b) return true;
  if (!a) return false;
  const ad = a.brief_date || '';
  const bd = b.brief_date || '';
  if (ad !== bd) return ad > bd;
  return (a._rowIndex || 0) > (b._rowIndex || 0);
}

/**
 * Build `contact_id → newest brief` from `Opportunity_Documents` rows.
 *
 * Rows are the entity-agnostic file-store rows: the entity key is the
 * `opportunity_id` column (the backend never inspects its prefix — see
 * js/utils/analyzer-pdf-attach.js), so a contact's rows carry that contact's
 * `pct_*` id there. Keying the map on the raw column value means the caller
 * looks up by `contact.contact_id` and nothing else can collide: a brief filed
 * under an opportunity is indexed under the opportunity's id, which no contact
 * lookup ever asks for.
 *
 * @param {Array<Object>} rows Sheet rows (readSheetAsObjects output).
 * @returns {Map<string, {doc_id:string, file_name:string, drive_url:string,
 *   date_added:string, brief_date:string, _rowIndex:number}>}
 */
export function indexContactAnalyzerPdfs(rows) {
  const best = new Map();
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const entityId = str(row.opportunity_id);
    if (!entityId) continue;
    const fileName = str(row.file_name);
    if (!isContactAnalyzerPdf(fileName)) continue;

    const candidate = {
      doc_id: str(row.doc_id),
      file_name: fileName,
      drive_url: str(row.drive_url),
      date_added: str(row.date_added),
      brief_date: analyzerPdfDateFromName(fileName),
      _rowIndex: Number(row._rowIndex) || 0,
    };
    if (isNewerAnalyzerPdf(candidate, best.get(entityId))) best.set(entityId, candidate);
  }
  return best;
}

/**
 * Look one contact up in the index. Returns null when the contact has no
 * Analyzer brief on file — the honest "nothing to link to" answer.
 */
export function findContactAnalyzerPdf(index, contactId) {
  const id = str(contactId);
  if (!id || !index || typeof index.get !== 'function') return null;
  return index.get(id) || null;
}
