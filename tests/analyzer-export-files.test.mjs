// ============================================================
// Tests for the Analyzer export-file helpers
// ============================================================
// Two jobs, one filename convention:
//   1. Evidence hygiene — the Analyzer's own exports must never be read back
//      in as source evidence (they are derived from the record, not evidence
//      about it), so isAnalyzerExportPdf must match all four modes' output
//      and nothing a user uploaded.
//   2. The contact brief link — the partner Contacts table links each contact
//      to its Account Intelligence Brief, resolved from ONE cached read of the
//      shared file-store sheet (`Opportunity_Documents`).
// These tests pin both, plus: the entity key is the raw file-store key (so a
// brief filed under an opportunity/event/partner can never surface under a
// contact), newest-wins ranking is deterministic and locale-proof, and the
// matchers stay in sync with the four filename builders.
// ============================================================

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTACT_ANALYZER_PDF_PREFIX,
  ANALYZER_EXPORT_PREFIXES,
  isAnalyzerExportPdf,
  withoutAnalyzerExports,
  isContactAnalyzerPdf,
  analyzerPdfDateFromName,
  isNewerAnalyzerPdf,
  indexContactAnalyzerPdfs,
  findContactAnalyzerPdf,
} from '../js/utils/analyzer-export-files.js';
import { contactBriefFilename } from '../js/utils/contact-analyzer-pdf-builder.js';
import { forecastFilename } from '../js/utils/forecast-pdf-builder.js';
import { eventAnalysisFilename } from '../js/utils/event-analyzer-pdf-builder.js';
import { partnerAnalysisFilename } from '../js/utils/partner-analyzer-pdf-builder.js';

// One `Opportunity_Documents` row as readSheetAsObjects() returns it.
function row(fields) {
  return {
    _rowIndex: 2,
    doc_id: 'DOC1',
    opportunity_id: '',
    customer_name: '',
    file_name: '',
    mime_type: 'application/pdf',
    drive_url: '',
    date_added: '2026-07-25',
    analyzed: 'FALSE',
    ...fields,
  };
}

// ── Evidence hygiene: recognizing every Analyzer export ─────────────

test('isAnalyzerExportPdf matches what all four Analyzer modes produce', () => {
  const generated = [
    forecastFilename('Acme Corp', '2026-07-25'),
    eventAnalysisFilename('Denver Kickoff', '2026-07-25'),
    partnerAnalysisFilename('Insight Enterprises', '2026-07-25'),
    contactBriefFilename('Jane Q. Doe', '2026-07-25'),
  ];
  for (const name of generated) {
    assert.equal(isAnalyzerExportPdf(name), true, `should match: ${name}`);
    assert.ok(
      ANALYZER_EXPORT_PREFIXES.some(p => name.startsWith(p)),
      `${name} matches no documented prefix — ANALYZER_EXPORT_PREFIXES is stale`,
    );
  }
});

// A FALSE POSITIVE HERE IS THE DANGEROUS DIRECTION. A filtered file is dropped
// from the evidence base silently — it is not even named in the coverage banner,
// because an export is deliberately "not a document that could not be read".
// So a rep's own `Analysis_Q3_2025.pdf` must survive, which is why the matcher
// requires the full generated shape (prefix + slug + `_YYYY-MM-DD`), not just
// the prefix.
test('isAnalyzerExportPdf leaves a user-uploaded document alone', () => {
  for (const name of [
    'Acme MSA.pdf',
    'Q3 Analysis notes.pdf',          // a space, not the generated underscore
    'My_Analysis_of_Acme_2026-07-25.pdf', // prefix must be at the start
    'Attendee list.xlsx',
    'Analysis_Acme_2026-07-25.docx',  // not a PDF
    'MAP_Acme_2026-07-25.pdf',        // MAP + Timeline PDFs are deliverables,
    'Timeline_Acme_2026-07-25.pdf',   // not Analyzer boards — never filtered
    // Real-world uploads that share a prefix but not the generated shape:
    'Analysis_Q3_2025.pdf',
    'analysis_of_market.pdf',
    'Account_Brief_from_customer.pdf',
    'Partner_Analysis_by_deloitte.pdf',
    'Event_Analysis_vendor.pdf',
    'Analysis_2024.PDF',
    '', null, undefined,
  ]) {
    assert.equal(isAnalyzerExportPdf(name), false, `should not match: ${String(name)}`);
  }
});

test('the date stamp is checked structurally, not as a calendar date', () => {
  // Deliberate: the stamp is there to distinguish the generated shape from a
  // human filename, not to validate a date. A file named in the exact
  // generated shape is the Analyzer's, impossible month or not.
  assert.equal(isAnalyzerExportPdf('Account_Brief_Jane_2026-13-45.pdf'), true);
  assert.equal(isAnalyzerExportPdf('Account_Brief_Jane_2026-7-5.pdf'), false, 'unpadded is not the generated shape');
});

test('withoutAnalyzerExports strips only the Analyzer output', () => {
  const kept = withoutAnalyzerExports([
    { file_name: 'Acme MSA.pdf' },
    { file_name: 'Analysis_Acme_2026-07-25.pdf' },
    { file_name: 'Account_Brief_Jane_2026-07-25.pdf' },
    { name: 'Partner_Analysis_Insight_2026-07-25.pdf' }, // `name` alias
    { file_name: 'Attendees.xlsx' },
    null,
  ]);
  assert.deepEqual(kept.map(f => f.file_name), ['Acme MSA.pdf', 'Attendees.xlsx']);
});

test('withoutAnalyzerExports tolerates empty / missing input', () => {
  assert.deepEqual(withoutAnalyzerExports([]), []);
  assert.deepEqual(withoutAnalyzerExports(null), []);
  assert.deepEqual(withoutAnalyzerExports(undefined), []);
});

// ── The contact-brief matcher ───────────────────────────────────────

test('isContactAnalyzerPdf matches what contactBriefFilename() produces', () => {
  const generated = contactBriefFilename('Jane Q. Doe', '2026-07-25');
  assert.ok(generated.startsWith(CONTACT_ANALYZER_PDF_PREFIX),
    `contactBriefFilename() no longer starts with ${CONTACT_ANALYZER_PDF_PREFIX}: ${generated}`);
  assert.equal(isContactAnalyzerPdf(generated), true);
  assert.equal(analyzerPdfDateFromName(generated), '2026-07-25');
});

test('isContactAnalyzerPdf matches regardless of case', () => {
  assert.equal(isContactAnalyzerPdf('ACCOUNT_BRIEF_Jane_Doe_2026-07-25.PDF'), true);
  assert.equal(isContactAnalyzerPdf('account_brief_jane_2026-07-25.pdf'), true);
});

test('isContactAnalyzerPdf rejects anything the Analyzer did not generate', () => {
  for (const name of [
    'Jane Doe resume.pdf',            // a manual upload
    'Account_Brief.pdf',              // prefix with no body
    'Account_Brief_from_customer.pdf', // prefix, but not the generated shape
    'Partner_Analysis_Insight_2026-07-25.pdf',
    'Event_Analysis_Kickoff_2026-07-25.pdf',
    'Analysis_Acme_2026-07-25.pdf',
    'My_Account_Brief_Jane_2026-07-25.pdf', // prefix must be at the start
    'Account_Brief_Jane_2026-07-25.docx',   // not a PDF
    '', null, undefined, 42,
  ]) {
    assert.equal(isContactAnalyzerPdf(name), false, `should not match: ${String(name)}`);
  }
});

test('analyzerPdfDateFromName returns "" when there is no trailing date', () => {
  assert.equal(analyzerPdfDateFromName('Account_Brief_Jane.pdf'), '');
  assert.equal(analyzerPdfDateFromName(''), '');
});

// ── Indexing ────────────────────────────────────────────────────────

test('indexContactAnalyzerPdfs keys briefs by their file-store entity id', () => {
  const index = indexContactAnalyzerPdfs([
    row({ opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_Doe_2026-07-20.pdf', drive_url: 'https://drive/jane' }),
    row({ _rowIndex: 3, opportunity_id: 'pct_b', file_name: 'Account_Brief_Rob_Smith_2026-07-21.pdf', drive_url: 'https://drive/rob' }),
  ]);

  assert.equal(index.size, 2);
  assert.equal(findContactAnalyzerPdf(index, 'pct_a').drive_url, 'https://drive/jane');
  assert.equal(findContactAnalyzerPdf(index, 'pct_b').file_name, 'Account_Brief_Rob_Smith_2026-07-21.pdf');
});

test('a brief filed under another entity type never surfaces under a contact', () => {
  const index = indexContactAnalyzerPdfs([
    // Same filename shape, but filed against an opportunity / event / partner.
    row({ opportunity_id: 'opp_1', file_name: 'Account_Brief_Jane_Doe_2026-07-20.pdf' }),
    row({ _rowIndex: 3, opportunity_id: 'evt_1', file_name: 'Account_Brief_Jane_Doe_2026-07-20.pdf' }),
    row({ _rowIndex: 4, opportunity_id: 'p_1', file_name: 'Account_Brief_Jane_Doe_2026-07-20.pdf' }),
  ]);

  assert.equal(findContactAnalyzerPdf(index, 'pct_a'), null);
  // Looked up by their own ids they are still there — the map is keyed on the
  // raw file-store key, exactly like the backend's listFiles filter.
  assert.ok(findContactAnalyzerPdf(index, 'opp_1'));
});

test('non-brief attachments on a contact are ignored', () => {
  const index = indexContactAnalyzerPdfs([
    row({ opportunity_id: 'pct_a', file_name: 'Signed NDA.pdf' }),
    row({ _rowIndex: 3, opportunity_id: 'pct_a', file_name: 'notes.docx' }),
  ]);
  assert.equal(findContactAnalyzerPdf(index, 'pct_a'), null);
});

test('rows with a blank entity id or blank filename are skipped', () => {
  const index = indexContactAnalyzerPdfs([
    row({ opportunity_id: '   ', file_name: 'Account_Brief_Jane_2026-07-20.pdf' }),
    row({ _rowIndex: 3, opportunity_id: 'pct_a', file_name: '   ' }),
    null,
    'not a row',
  ]);
  assert.equal(index.size, 0);
});

test('indexContactAnalyzerPdfs trims whitespace on the entity id and link', () => {
  const index = indexContactAnalyzerPdfs([
    row({ opportunity_id: ' pct_a ', file_name: 'Account_Brief_Jane_2026-07-20.pdf', drive_url: ' https://drive/jane ' }),
  ]);
  assert.equal(findContactAnalyzerPdf(index, 'pct_a').drive_url, 'https://drive/jane');
});

test('indexContactAnalyzerPdfs tolerates empty / missing input', () => {
  assert.equal(indexContactAnalyzerPdfs([]).size, 0);
  assert.equal(indexContactAnalyzerPdfs(null).size, 0);
  assert.equal(indexContactAnalyzerPdfs(undefined).size, 0);
});

// ── Newest wins ─────────────────────────────────────────────────────

test('the newest brief wins when a contact has been analyzed more than once', () => {
  const index = indexContactAnalyzerPdfs([
    row({ _rowIndex: 2, opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-05-01.pdf', drive_url: 'https://drive/old' }),
    row({ _rowIndex: 3, opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-07-20.pdf', drive_url: 'https://drive/new' }),
    row({ _rowIndex: 4, opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-06-02.pdf', drive_url: 'https://drive/middle' }),
  ]);
  assert.equal(findContactAnalyzerPdf(index, 'pct_a').drive_url, 'https://drive/new');
});

test('same-day briefs fall back to sheet order (the later row is newer)', () => {
  const index = indexContactAnalyzerPdfs([
    row({ _rowIndex: 9, opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-07-20.pdf', drive_url: 'https://drive/first' }),
    row({ _rowIndex: 10, opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-07-20.pdf', drive_url: 'https://drive/second' }),
  ]);
  assert.equal(findContactAnalyzerPdf(index, 'pct_a').drive_url, 'https://drive/second');
});

test('a dated brief beats an undated one regardless of row order', () => {
  const dated = { brief_date: '2026-01-01', _rowIndex: 2 };
  const undated = { brief_date: '', _rowIndex: 99 };
  assert.equal(isNewerAnalyzerPdf(dated, undated), true);
  assert.equal(isNewerAnalyzerPdf(undated, dated), false);
});

test('isNewerAnalyzerPdf treats a missing incumbent as "anything is newer"', () => {
  assert.equal(isNewerAnalyzerPdf({ brief_date: '', _rowIndex: 0 }, undefined), true);
  assert.equal(isNewerAnalyzerPdf(null, { brief_date: '2026-01-01', _rowIndex: 2 }), false);
});

// ── Lookup guards ───────────────────────────────────────────────────

test('findContactAnalyzerPdf returns null for blank / unknown ids', () => {
  const index = indexContactAnalyzerPdfs([
    row({ opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-07-20.pdf' }),
  ]);
  assert.equal(findContactAnalyzerPdf(index, ''), null);
  assert.equal(findContactAnalyzerPdf(index, '   '), null);
  assert.equal(findContactAnalyzerPdf(index, null), null);
  assert.equal(findContactAnalyzerPdf(index, 'pct_missing'), null);
  assert.equal(findContactAnalyzerPdf(null, 'pct_a'), null);
});

test('findContactAnalyzerPdf trims the id it is given', () => {
  const index = indexContactAnalyzerPdfs([
    row({ opportunity_id: 'pct_a', file_name: 'Account_Brief_Jane_2026-07-20.pdf' }),
  ]);
  assert.ok(findContactAnalyzerPdf(index, '  pct_a  '));
});
