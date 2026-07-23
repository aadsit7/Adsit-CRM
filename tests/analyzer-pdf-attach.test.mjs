// ============================================================
// Tests for the Analyzer PDF auto-attach helper
// ============================================================
// attachAnalyzerPdf() files a freshly built "Create PDF" export onto its CRM
// record via the shared Drive-backed file store. These tests stub fetch and
// FileReader so nothing hits Anthropic or Google Drive, and prove:
//   • input validation (missing id / filename / blob)
//   • the exact upload wire shape (entity-agnostic key, pdf mime, folder)
//   • the entity-agnostic contract across opp_/evt_/p_/pct_ ids
//   • Drive-URL resolution + a graceful no-URL response
//   • the documented entity → id-field mapping
// ============================================================

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({
  FILE_API_URL: 'https://example.invalid/file-api',
}));

// ── FileReader shim so blobToBase64() runs under Node ──
class FakeFileReader {
  onload = null;
  onerror = null;
  readAsDataURL(blob) {
    setTimeout(() => {
      this.result = `data:${blob._type || 'application/pdf'};base64,${blob._b64 || 'UEQ='}`;
      if (this.onload) this.onload();
    }, 0);
  }
}
globalThis.FileReader = FakeFileReader;

const { attachAnalyzerPdf, ANALYZER_ENTITY_KEYS } =
  await import('../js/utils/analyzer-pdf-attach.js');

// A stand-in PDF blob the FileReader shim understands.
const fakeBlob = () => ({ _isBlob: true, _type: 'application/pdf', _b64: 'UEQ=', size: 42 });

// Capture the single upload call and answer with a standard Apps Script reply.
function stubUpload(fileFields = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        file: {
          doc_id: 'DOC123',
          file_name: JSON.parse(opts.body).fileName,
          drive_url: 'https://drive.google.com/file/d/abc/view',
          date_added: '2026-07-23T12:00:00Z',
          ...fileFields,
        },
      }),
    };
  };
  return calls;
}

// ── Validation ──────────────────────────────────────────────

test('attachAnalyzerPdf rejects when entityId is missing', async () => {
  await assert.rejects(
    () => attachAnalyzerPdf({ entityId: '', filename: 'x.pdf', blob: fakeBlob() }),
    (err) => err.code === 'ANALYZER_ATTACH_INVALID_INPUT',
  );
});

test('attachAnalyzerPdf rejects when filename is missing', async () => {
  await assert.rejects(
    () => attachAnalyzerPdf({ entityId: 'opp_1', filename: '  ', blob: fakeBlob() }),
    (err) => err.code === 'ANALYZER_ATTACH_INVALID_INPUT',
  );
});

test('attachAnalyzerPdf rejects when blob is missing', async () => {
  await assert.rejects(
    () => attachAnalyzerPdf({ entityId: 'opp_1', filename: 'x.pdf', blob: null }),
    (err) => err.code === 'ANALYZER_ATTACH_INVALID_INPUT',
  );
});

// ── Happy path wire shape ───────────────────────────────────

test('attachAnalyzerPdf uploads with the exact entity-agnostic payload', async () => {
  const calls = stubUpload();
  const result = await attachAnalyzerPdf({
    entityId: 'opp_42',
    contextName: 'ANICO',
    filename: 'Forecast_ANICO_2026-07-23.pdf',
    blob: fakeBlob(),
  });

  assert.equal(calls.length, 1, 'exactly one Drive upload');
  const body = calls[0].body;
  assert.equal(body.action, 'uploadFile');
  // The entity id is passed verbatim as the `opportunityId` key the Apps
  // Script uses for EVERY entity type.
  assert.equal(body.opportunityId, 'opp_42');
  assert.equal(body.customerName, 'ANICO');
  assert.equal(body.fileName, 'Forecast_ANICO_2026-07-23.pdf');
  assert.equal(body.mimeType, 'application/pdf');
  assert.equal(body.fileData, 'UEQ=');

  assert.equal(result.success, true);
  assert.equal(result.driveUrl, 'https://drive.google.com/file/d/abc/view');
  assert.equal(result.file.doc_id, 'DOC123');
  assert.equal(result.file.file_name, 'Forecast_ANICO_2026-07-23.pdf');
  assert.equal(result.filename, 'Forecast_ANICO_2026-07-23.pdf');
});

test('attachAnalyzerPdf falls back to the filename as the Drive folder when contextName is blank', async () => {
  const calls = stubUpload();
  await attachAnalyzerPdf({
    entityId: 'p_9',
    contextName: '   ',
    filename: 'Partner_Analysis.pdf',
    blob: fakeBlob(),
  });
  assert.equal(calls[0].body.customerName, 'Partner_Analysis.pdf',
    'a blank folder name must never leave the file in "Uncategorized"');
});

test('attachAnalyzerPdf trims a stray-whitespace entityId before keying on it', async () => {
  const calls = stubUpload();
  await attachAnalyzerPdf({
    entityId: '  evt_7  ',
    contextName: 'Kickoff',
    filename: 'Event.pdf',
    blob: fakeBlob(),
  });
  assert.equal(calls[0].body.opportunityId, 'evt_7');
});

// ── Entity-agnostic contract ────────────────────────────────

test('attachAnalyzerPdf keys on whatever record id it is given (opp/evt/p/pct)', async () => {
  for (const id of ['opp_1', 'evt_2', 'p_3', 'pct_4']) {
    const calls = stubUpload();
    await attachAnalyzerPdf({ entityId: id, contextName: 'X', filename: 'f.pdf', blob: fakeBlob() });
    assert.equal(calls[0].body.opportunityId, id,
      `the ${id} record must key its own attachment — no cross-listing`);
    assert.equal(calls[0].body.mimeType, 'application/pdf');
  }
});

// ── Response resolution ─────────────────────────────────────

test('attachAnalyzerPdf still resolves a file when the response omits a Drive URL', async () => {
  globalThis.fetch = async (url, opts) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, doc_id: 'DOC_NO_URL', file_name: JSON.parse(opts.body).fileName }),
  });
  const result = await attachAnalyzerPdf({
    entityId: 'pct_1', contextName: 'Jane Doe', filename: 'Brief.pdf', blob: fakeBlob(),
  });
  assert.equal(result.success, true);
  assert.equal(result.driveUrl, '', 'no link resolved, but the attach still succeeds');
  assert.equal(result.file.doc_id, 'DOC_NO_URL');
  assert.equal(result.file.file_name, 'Brief.pdf');
});

test('attachAnalyzerPdf surfaces a failed upload as a thrown error', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) });
  await assert.rejects(
    () => attachAnalyzerPdf({ entityId: 'opp_1', contextName: 'X', filename: 'f.pdf', blob: fakeBlob() }),
  );
});

// ── Documented mapping ──────────────────────────────────────

test('ANALYZER_ENTITY_KEYS maps each analyzer mode to its id field', () => {
  assert.deepEqual(ANALYZER_ENTITY_KEYS, {
    opportunity: 'opportunity_id',
    event: 'event_id',
    partner: 'partner_id',
    contact: 'contact_id',
  });
});
