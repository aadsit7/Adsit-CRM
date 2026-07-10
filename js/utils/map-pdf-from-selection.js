// ============================================================
// MAP PDF from selection (V1.5 click-driven flow)
// ============================================================
// Shared orchestrator that turns a batch of description entries into
// a MAP PDF saved to Drive. The voice flow in randy.js does the same
// thing but wraps it in TTS + chat-card presentation; this path is
// deliberately silent — the caller provides the UI (pill + cards).
//
// Reuses the existing primitives:
//   • requestMapPdfJsonFromMultiple() — Anthropic Messages API
//   • buildMapPdf()                   — jsPDF + jspdf-autotable
//   • blobToBase64()                  — FileReader
//   • fileApiRequest()                — Apps Script upload (no headers!)
//
// No new network endpoints, no backend code, no new dependencies.
// ============================================================

import { requestMapPdfJsonFromMultiple } from './ai.js';
import { buildMapPdf, mapFilename, blobToBase64 } from './map-pdf-builder.js';
import { fileApiRequest } from './file-api.js';

// Same 8-path resolution the voice flow uses. Apps Script deployments
// have surfaced slight variations across environments — cover every
// observed shape and take the first non-empty string.
export function resolveDriveUrl(uploadResp) {
  return (
    uploadResp?.file?.drive_url ||
    uploadResp?.drive_url ||
    uploadResp?.file?.driveUrl ||
    uploadResp?.driveUrl ||
    uploadResp?.file?.webViewLink ||
    uploadResp?.webViewLink ||
    uploadResp?.file?.url ||
    uploadResp?.url ||
    ''
  );
}

function normalizeOpportunity(opportunity) {
  if (!opportunity || typeof opportunity !== 'object') {
    const err = new Error('generateMapPdfFromSelection: opportunity is required');
    err.code = 'MAP_SELECTION_INVALID_OPPORTUNITY';
    throw err;
  }
  const id = opportunity.id || opportunity.opportunityId || opportunity.opportunity_id;
  const customerName = opportunity.customerName || opportunity.customer_name || '';
  if (!id) {
    const err = new Error('generateMapPdfFromSelection: opportunity.id is required');
    err.code = 'MAP_SELECTION_INVALID_OPPORTUNITY';
    throw err;
  }
  if (!String(customerName).trim()) {
    const err = new Error('generateMapPdfFromSelection: opportunity.customerName is required');
    err.code = 'MAP_SELECTION_INVALID_OPPORTUNITY';
    throw err;
  }
  return {
    id,
    customerName: String(customerName).trim(),
    dealName: opportunity.dealName || opportunity.deal_name || '',
    // Kept on the object so requestMapPdfJsonFromMultiple can populate
    // its "extras" block the same way the voice flow does.
    name: opportunity.name || String(customerName).trim(),
    opportunityId: id,
    stage: opportunity.stage || '',
    dealValue: opportunity.dealValue || opportunity.deal_value || '',
    expectedClose: opportunity.expectedClose || opportunity.expected_close || '',
    partner: opportunity.partner || '',
  };
}

function normalizeSelectedDescriptions(selectedDescriptions) {
  if (!Array.isArray(selectedDescriptions) || selectedDescriptions.length === 0) {
    const err = new Error('generateMapPdfFromSelection: at least one description must be selected');
    err.code = 'MAP_SELECTION_EMPTY';
    throw err;
  }
  const normalized = selectedDescriptions
    .map(d => {
      const date = d?.date || d?.description_date || d?.created_at || '';
      const content = d?.content || d?.text || d?.description_text || '';
      const category = d?.category || '';
      return { date: String(date || ''), content: String(content || '').trim(), category: String(category) };
    })
    .filter(d => d.content.length > 0);
  if (normalized.length === 0) {
    const err = new Error('generateMapPdfFromSelection: selected descriptions are all empty');
    err.code = 'MAP_SELECTION_EMPTY';
    throw err;
  }
  return normalized;
}

/**
 * Generate a MAP PDF from a user-picked batch of description entries,
 * upload it to Drive, and return the resolved metadata. Callers are
 * responsible for surfacing progress (pill) and the success/failure
 * card — this function only does the plumbing.
 *
 * Stage callbacks fire as the flow advances:
 *   onStage('reading' | 'synthesizing', { count })
 *   onStage('building')
 *   onStage('saving')
 *
 * @param {object} opportunity          { id / opportunityId, customerName, dealName?, ... }
 * @param {Array}  selectedDescriptions Array of { date, content } (or description_date / description_text)
 * @param {object} [hooks]              { onStage, signal }
 * @returns {Promise<{ success: true, file: object, driveUrl: string, filename: string }>}
 */
export async function generateMapPdfFromSelection(opportunity, selectedDescriptions, hooks = {}) {
  const opp = normalizeOpportunity(opportunity);
  const entries = normalizeSelectedDescriptions(selectedDescriptions);
  const count = entries.length;
  const { onStage, signal } = hooks;

  const fire = (stage, extra) => {
    if (typeof onStage === 'function') {
      try { onStage(stage, extra || {}); }
      catch (e) { console.warn('[MAP PDF from selection] onStage handler threw', e); }
    }
  };

  fire(count > 1 ? 'synthesizing' : 'reading', { count });
  const json = await requestMapPdfJsonFromMultiple(opp, entries, signal);

  fire('building', { count });
  const pdfBlob = await buildMapPdf(json, opp);
  const filename = mapFilename(
    json.customer_name || opp.customerName,
    new Date().toISOString().slice(0, 10),
    count,
  );

  fire('saving', { count });
  const base64 = await blobToBase64(pdfBlob);
  const uploadResp = await fileApiRequest({
    action: 'uploadFile',
    opportunityId: opp.id,
    customerName: opp.customerName,
    fileName: filename,
    mimeType: 'application/pdf',
    fileData: base64,
  });

  // Mirrors the voice-flow log prefix so logs from the two entry
  // points stay distinguishable in the browser console.
  console.log('[MAP PDF from selection] Apps Script upload response:', JSON.stringify(uploadResp, null, 2));

  const driveUrl = resolveDriveUrl(uploadResp);
  if (!driveUrl) {
    console.warn(
      '[MAP PDF from selection] No Drive URL in upload response — success card will fall back to in-portal navigation. Response keys:',
      Object.keys(uploadResp || {}), 'file keys:', Object.keys(uploadResp?.file || {}),
    );
  }

  const file = {
    doc_id:     uploadResp?.file?.doc_id     || uploadResp?.doc_id,
    file_name:  uploadResp?.file?.file_name  || uploadResp?.file_name  || filename,
    drive_url:  driveUrl,
    date_added: uploadResp?.file?.date_added || uploadResp?.date_added || new Date().toISOString(),
  };

  return { success: true, file, driveUrl, filename: file.file_name };
}

// Exposed for tests. These are pure helpers with no network cost.
export const __mapFromSelectionInternals = {
  normalizeOpportunity,
  normalizeSelectedDescriptions,
  resolveDriveUrl,
};
