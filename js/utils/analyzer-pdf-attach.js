// ============================================================
// Analyzer PDF auto-attach — one PDF → the right CRM record
// ============================================================
// Shared orchestrator that uploads an analyzer-generated PDF (the board /
// brief the user just built with "Create PDF") straight onto the record it
// describes, so the export is filed automatically instead of only landing
// in the browser's downloads folder.
//
// ENTITY-AGNOSTIC BY DESIGN. The Drive-backed file store (the Apps Script
// `Opportunity_Documents` sheet) keys every attachment by a single id string
// and never inspects its prefix — so opportunities (`opp_*`), events
// (`evt_*`), partners (`p_*`) and contacts (`pct_*`) all attach through the
// exact same call. This is the same wire contract the Documents panel and
// the MAP PDF flows already use (`action:'uploadFile'`, `opportunityId` =
// entity key, `customerName` = Drive folder name); no backend change is
// required to support a fourth entity type.
//
// SEPARATION COMES FROM THE KEY, NOT FROM THIS MODULE. Because the store keys
// on one untyped string (and `doListFiles` compares it with a loose `==`), two
// records of DIFFERENT types that share an id value would share a document
// list — which legacy partners and events, both numbered from 1, do. Callers
// therefore pass a key built by `fileStoreKey()`
// (js/utils/file-store-keys.js), which qualifies a bare id and leaves an
// already-prefixed one untouched. This module takes the key it is given.
//
// Reuses existing primitives only:
//   • blobToBase64()   — FileReader (js/utils/map-pdf-builder.js)
//   • fileApiRequest() — Apps Script upload, no headers (js/utils/file-api.js)
//   • resolveDriveUrl()— response-shape walker (js/utils/file-api.js)
// No new network endpoints, no new dependencies.
// ============================================================

import { blobToBase64 } from './map-pdf-builder.js';
import { fileApiRequest, resolveDriveUrl } from './file-api.js';

// Canonical entity-type → id-field mapping, documented so callers pass the
// right key. Not enforced (the backend is agnostic) — this is the contract
// the four Analyzer modes follow.
export const ANALYZER_ENTITY_KEYS = Object.freeze({
  opportunity: 'opportunity_id',
  event: 'event_id',
  partner: 'partner_id',
  contact: 'contact_id',
});

function invalid(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Upload an analyzer PDF and file it against a CRM record.
 *
 * @param {Object} opts
 * @param {string} opts.entityId    The record's id (opportunity_id / event_id /
 *   partner_id / contact_id). Used verbatim as the file store key, so the
 *   attachment lists under exactly this record.
 * @param {string} opts.contextName Human label used as the Drive folder name
 *   (customer name / event title / partner name / contact name). Falls back to
 *   the filename when blank so a file is never dropped into "Uncategorized".
 * @param {string} opts.filename    The PDF filename (already includes .pdf).
 * @param {Blob}   opts.blob        The built PDF blob.
 * @param {AbortSignal} [opts.signal] Optional cancellation for the upload.
 * @returns {Promise<{success:true, file:Object, driveUrl:string, filename:string}>}
 * @throws  {Error} with `.code` ANALYZER_ATTACH_INVALID_INPUT when entityId /
 *   filename / blob are missing — surfaced so the caller keeps the local
 *   download working and reports the attach failure honestly.
 */
export async function attachAnalyzerPdf({ entityId, contextName, filename, blob, signal } = {}) {
  const id = String(entityId == null ? '' : entityId).trim();
  const name = String(filename == null ? '' : filename).trim();
  if (!id) throw invalid('attachAnalyzerPdf: entityId is required', 'ANALYZER_ATTACH_INVALID_INPUT');
  if (!name) throw invalid('attachAnalyzerPdf: filename is required', 'ANALYZER_ATTACH_INVALID_INPUT');
  if (!blob || typeof blob !== 'object') {
    throw invalid('attachAnalyzerPdf: blob is required', 'ANALYZER_ATTACH_INVALID_INPUT');
  }

  const folder = String(contextName == null ? '' : contextName).trim() || name;
  const fileData = await blobToBase64(blob);

  const uploadResp = await fileApiRequest({
    action: 'uploadFile',
    opportunityId: id,   // entity-agnostic key (see module header)
    customerName: folder,
    fileName: name,
    mimeType: 'application/pdf',
    fileData,
  }, signal ? { signal } : {});

  const driveUrl = resolveDriveUrl(uploadResp);
  if (!driveUrl) {
    // Non-fatal: the row is written even without a resolvable link; the
    // Documents panel still lists it on the next open. Mirror the MAP flow's
    // diagnostic so both entry points read the same in the console.
    console.warn(
      '[Analyzer attach] No Drive URL in upload response — the file is attached but its link did not resolve. Response keys:',
      Object.keys(uploadResp || {}), 'file keys:', Object.keys(uploadResp?.file || {}),
    );
  }

  // Normalized to exactly what the Documents panel's addFile()/list expects,
  // so a currently-open modal could inject it without a round-trip.
  const file = {
    doc_id:     uploadResp?.file?.doc_id     || uploadResp?.doc_id,
    file_name:  uploadResp?.file?.file_name  || uploadResp?.file_name || name,
    drive_url:  driveUrl,
    date_added: uploadResp?.file?.date_added || uploadResp?.date_added || new Date().toISOString(),
  };

  return { success: true, file, driveUrl, filename: file.file_name };
}
