/**
 * Partner Portal — Event Workspace backend (Google Apps Script web app)
 * ---------------------------------------------------------------------
 * COMPLETE SCRIPT — replaces the whole file. Paste over everything in
 * the Apps Script editor, then deploy a NEW VERSION (see bottom note).
 *
 * Actions served:
 *   Portal + playbook shared:
 *     uploadFile / listFiles / deleteFile / analyzeDocument /
 *     updateDescription / getConfig
 *   Playbook (Event Workspace):
 *     categorizeLeads / listEvents / openEvent / saveEventContacts /
 *     listEventContacts
 *   Portal (event modal "Analyze" on attached documents):
 *     analyzeDocument with analysisType:'attendee_list' — extracts the
 *     attendee list deterministically, classifies titles with the SAME
 *     "Event Lead Categorizer" persona the playbook uses, and returns
 *     HTML card(s) + a structured contacts array. The portal writes the
 *     contact rows to Event_Contacts itself.
 *
 *     NEW: contacts still missing fields the file didn't contain (job
 *     title, company, ICP classification) are researched ONLINE via
 *     Claude's web-search tool, using the info the file DID provide
 *     (name, email domain, company). Only verified findings are filled;
 *     anything unconfirmed stays blank rather than guessed. Web-sourced
 *     values carry an ai_rationale starting with "Web:".
 *
 * Deploy: Extensions > Apps Script > Deploy > Manage deployments >
 *   Edit (pencil) > Version: New version > Deploy.
 *   - Execute as:      Me
 *   - Who has access:  Anyone            <-- REQUIRED so the browser page can call it
 */

var SHEET_ID = '18Yhe3Yiq9_eI7kBxtFOzdu6Pb0_VUx730TYjq1xPjzI';
var DRIVE_FOLDER_ID = '1Jl86IHpClRaIFqM-RUQn-gzcCqYV9XTA';
var ANTHROPIC_API_KEY = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
// Optional secondary AI backend. A preset can be set to run on Kimi
// (Moonshot AI) instead of Anthropic; the portal proxies those chat
// requests through this web app (action: 'kimiChat') so the key stays
// server-side and the call is not blocked by browser CORS.
var KIMI_API_KEY = PropertiesService.getScriptProperties().getProperty('KIMI_API_KEY');

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    if (payload.action === 'uploadFile') {
      return doUploadFile(payload);
    }

    if (payload.action === 'listFiles') {
      return doListFiles(payload.opportunityId);
    }

    if (payload.action === 'deleteFile') {
      return doDeleteFile(payload.docId);
    }

    if (payload.action === 'analyzeDocument') {
      // The portal's event modal sends analysisType:'attendee_list'.
      // When absent (the Opportunities flow), behavior is exactly as before.
      if (payload.analysisType === 'attendee_list') {
        return doAnalyzeAttendeeList(payload);
      }
      return doAnalyzeDocument(payload.docId, payload.driveUrl);
    }

    if (payload.action === 'updateDescription') {
      return handleUpdateDescription(payload);
    }

    // Classify an uploaded lead list with the SaaS demand-gen persona.
    if (payload.action === 'categorizeLeads') {
      return doCategorizeLeads(payload);
    }

    // Return every row of the Events tab so the workspace can offer an
    // event picker on load and prepopulate itself from the selected event.
    if (payload.action === 'listEvents') {
      return doListEvents();
    }

    // Open one event by key, verifying its password (if the Events tab
    // has one for that row) before returning the full details.
    if (payload.action === 'openEvent') {
      return doOpenEvent(payload);
    }

    // Persist the uploaded (and AI-categorized) contact list for an event
    // into the Event_Contacts tab so it can be referenced on later opens.
    if (payload.action === 'saveEventContacts') {
      return doSaveEventContacts(payload);
    }

    // Read back the contacts previously saved for one event so the
    // workspace can prepopulate itself when the event is reopened.
    if (payload.action === 'listEventContacts') {
      return doListEventContacts(payload);
    }

    if (payload.action === 'getConfig') {
      return doGetConfig();
    }

    // Proxy a chat completion to Kimi (Moonshot AI) for presets configured
    // to run on Kimi instead of Anthropic. Keeps the key server-side.
    if (payload.action === 'kimiChat') {
      return doKimiChat(payload);
    }

    throw new Error('Unknown action: ' + payload.action);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// GET CONFIG — Return the Anthropic key so the portal can read it
// automatically instead of pasting it into the Setup page.
// ============================================================

function doGetConfig() {
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    anthropicApiKey: ANTHROPIC_API_KEY,
    // Whether a Kimi key is configured — reported as a boolean so the
    // portal can show a connection status without exposing the key
    // itself (Kimi requests are proxied through this web app, so the
    // browser never needs the raw key).
    hasKimiKey: !!KIMI_API_KEY
  })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// KIMI (Moonshot AI) chat proxy
// ------------------------------------------------------------
// The portal posts an OpenAI-style { model, messages, max_tokens } payload
// here. We PIN the model to Kimi's current flagship and forward the chat to
// Moonshot server-side (no browser CORS to worry about), returning the
// assistant text in the same { ok, text } envelope the rest of the app expects.
// ============================================================

function doKimiChat(payload) {
  if (!KIMI_API_KEY) throw new Error('KIMI_API_KEY is not set in this project’s Script Properties');

  // kimi-k3 (Kimi's current flagship) runs with thinking mode always on and
  // LOCKS its sampling parameters: temperature is fixed at 1.0 and, per
  // Moonshot's docs, must be OMITTED from the request. Any explicit temperature
  // returns HTTP 400 "invalid temperature: only 1 is allowed for this model".
  // So we PIN the model here (not just default it) and send NO temperature —
  // this switches the whole portal to the latest model on deploy and cannot
  // 400, even if an older cached page still asks for a previous model.
  // (The ×0.6 temperature mapping some guides mention is for Moonshot's
  // Anthropic-compatible endpoint, not this OpenAI /v1/chat/completions path.)
  var body = {
    model: 'kimi-k3',
    max_tokens: payload.max_tokens || 4096,
    messages: payload.messages || []
  };

  var response = UrlFetchApp.fetch('https://api.moonshot.ai/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + KIMI_API_KEY },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  var result;
  try {
    result = JSON.parse(response.getContentText());
  } catch (e) {
    throw new Error('Kimi API returned a non-JSON response (HTTP ' + response.getResponseCode() + ')');
  }
  if (result && result.error) {
    throw new Error('Kimi API error: ' + (result.error.message || JSON.stringify(result.error)));
  }

  var text = '';
  if (result.choices && result.choices[0] && result.choices[0].message) {
    text = result.choices[0].message.content || '';
  }
  return jsonOut({ ok: true, text: text });
}

// ============================================================
// FILE UPLOAD
// ============================================================

function doUploadFile(payload) {
  var rootFolder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  var customerName = payload.customerName || 'Uncategorized';
  var customerFolders = rootFolder.getFoldersByName(customerName);
  var customerFolder = customerFolders.hasNext() ? customerFolders.next() : rootFolder.createFolder(customerName);

  var fileData = Utilities.base64Decode(payload.fileData);
  var blob = Utilities.newBlob(fileData, payload.mimeType, payload.fileName);
  var file = customerFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Opportunity_Documents');
  if (!sheet) {
    sheet = ss.insertSheet('Opportunity_Documents');
    sheet.getRange(1, 1, 1, 8).setValues([['doc_id', 'opportunity_id', 'customer_name', 'file_name', 'mime_type', 'drive_url', 'date_added', 'analyzed']]);
  }

  var docId = 'DOC' + Date.now();
  var dateAdded = new Date().toISOString().slice(0, 10);
  sheet.appendRow([docId, payload.opportunityId, customerName, payload.fileName, payload.mimeType, file.getUrl(), dateAdded, 'FALSE']);

  // The `file` object matches what the portal's documents panel expects so a
  // freshly uploaded file's link works immediately. The old top-level keys
  // (doc_id / url / name) are kept for anything that already reads them.
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    doc_id: docId,
    url: file.getUrl(),
    name: payload.fileName,
    file: {
      doc_id: docId,
      opportunity_id: payload.opportunityId,
      customer_name: customerName,
      file_name: payload.fileName,
      mime_type: payload.mimeType,
      drive_url: file.getUrl(),
      date_added: dateAdded,
      analyzed: 'FALSE'
    }
  })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// LIST FILES
// ============================================================

function doListFiles(opportunityId) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Opportunity_Documents');
  if (!sheet) return ContentService.createTextOutput(JSON.stringify({ ok: true, files: [] })).setMimeType(ContentService.MimeType.JSON);

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return ContentService.createTextOutput(JSON.stringify({ ok: true, files: [] })).setMimeType(ContentService.MimeType.JSON);

  var numCols = sheet.getLastColumn();
  var data = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0];

  var files = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][1] == opportunityId) {
      var obj = {};
      for (var j = 0; j < headers.length; j++) obj[headers[j]] = data[i][j];
      files.push(obj);
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true, files: files })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// DELETE FILE
// ============================================================

function doDeleteFile(docId) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Opportunity_Documents');
  if (!sheet) throw new Error('No documents tab found');

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] == docId) {
      sheet.deleteRow(i + 2);
      return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  throw new Error('Document not found: ' + docId);
}

// ============================================================
// ANALYZE DOCUMENT — Extract text from Drive file, send to Claude
// (generic path — used by Opportunities, unchanged behavior)
// ============================================================

function doAnalyzeDocument(docId, driveUrl) {
  var file = resolveDriveFile_({ docId: docId, driveUrl: driveUrl });
  var fileId = file.getId();
  var mimeType = file.getMimeType();
  var fileName = file.getName();
  var extractedText = '';

  // Extract text based on file type
  if (mimeType === 'application/pdf') {
    // Convert PDF to Google Doc (uses Google's built-in OCR), extract text, delete temp doc
    var tempDoc = Drive.Files.copy(
      { title: 'TEMP_ANALYZE_' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
      fileId,
      { ocr: true, ocrLanguage: 'en' }
    );
    var doc = DocumentApp.openById(tempDoc.id);
    extractedText = doc.getBody().getText();
    DriveApp.getFileById(tempDoc.id).setTrashed(true);
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
             mimeType === 'application/msword') {
    // Word docs — convert to Google Doc, extract text
    var tempDoc = Drive.Files.copy(
      { title: 'TEMP_ANALYZE_' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
      fileId
    );
    var doc = DocumentApp.openById(tempDoc.id);
    extractedText = doc.getBody().getText();
    DriveApp.getFileById(tempDoc.id).setTrashed(true);
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
             mimeType === 'application/vnd.ms-excel' ||
             mimeType === 'application/vnd.ms-excel.sheet.macroEnabled.12') {
    // Excel (.xlsx / .xls / .xlsm) — convert to Google Sheet, extract text from
    // EVERY worksheet so a multi-tab workbook is analyzed in full.
    var tempSheet = Drive.Files.copy(
      { title: 'TEMP_ANALYZE_' + Date.now(), mimeType: 'application/vnd.google-apps.spreadsheet' },
      fileId
    );
    var ss = SpreadsheetApp.openById(tempSheet.id);
    var sheets = ss.getSheets();
    var parts = [];
    for (var s = 0; s < sheets.length; s++) {
      var data = sheets[s].getDataRange().getValues();
      var text = data.map(function(row) { return row.join(' | '); }).join('\n');
      if (text.replace(/[\s|]/g, '') === '') continue; // skip empty tabs
      parts.push((sheets.length > 1 ? '=== Sheet: ' + sheets[s].getName() + ' ===\n' : '') + text);
    }
    extractedText = parts.join('\n\n');
    DriveApp.getFileById(tempSheet.id).setTrashed(true);
  } else if (mimeType === 'text/csv' || /\.csv$/i.test(fileName)) {
    extractedText = file.getBlob().getDataAsString('UTF-8');
  } else if (mimeType === 'text/plain') {
    extractedText = file.getBlob().getDataAsString();
  } else {
    // Try to get as text
    try {
      extractedText = file.getBlob().getDataAsString();
    } catch (e) {
      throw new Error('Cannot extract text from file type: ' + mimeType);
    }
  }

  if (!extractedText || extractedText.trim().length < 20) {
    throw new Error('Could not extract meaningful text from this document');
  }

  // Truncate only when genuinely huge — the old 15,000-character cap cut off
  // most real lead lists after a few hundred rows.
  if (extractedText.length > 60000) {
    extractedText = extractedText.substring(0, 60000) + '\n\n[Document truncated — showing first 60,000 characters]';
  }

  // Send to Claude to format as a clean, structured description
  var prompt = 'You are a document formatting assistant. I have extracted text from a business document called "' + fileName + '". ' +
    'Your job is to format this text as clean, well-structured HTML that preserves the original layout and content as closely as possible.\n\n' +
    'RULES:\n' +
    '- Preserve the original text content exactly — do not summarize, shorten, or rewrite anything\n' +
    '- Use proper HTML formatting: <h3> for main section headers, <h4> for sub-headers, <p> for paragraphs\n' +
    '- Use <ul><li> for bullet points and <ol><li> for numbered lists\n' +
    '- Use <strong> for bold text and <em> for italic text\n' +
    '- Use <table> for any tabular data\n' +
    '- Use <a href="..."> for any URLs or email addresses found in the text\n' +
    '- Do NOT add any commentary, summary, or analysis — just format the existing text\n' +
    '- Do NOT wrap the output in markdown code fences or backticks\n' +
    '- Output ONLY the HTML content, nothing else\n' +
    '- If the document has a clear title or date, make that the first <h3>\n' +
    '- Preserve section structure: if the document has sections like "Key Takeaways", "People", "Next Steps", keep those as headers\n\n' +
    '=== EXTRACTED TEXT ===\n\n' +
    extractedText;

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());
  var formattedHtml = '';

  // Extract text from Claude response
  if (result.content && Array.isArray(result.content)) {
    for (var i = 0; i < result.content.length; i++) {
      if (result.content[i].type === 'text') {
        formattedHtml += result.content[i].text;
      }
    }
  }

  if (!formattedHtml) {
    throw new Error('Claude did not return formatted text');
  }

  // Strip any markdown fences if present
  formattedHtml = formattedHtml.replace(/```html\s*/gi, '').replace(/```\s*/g, '').trim();

  // Mark document as analyzed in the sheet
  markDocumentAnalyzed_(docId);

  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    html: formattedHtml,
    fileName: fileName
  })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// UPDATE DESCRIPTION — Overwrite description text + set category
// Used by the Standardize button (Describe Intelligence V1)
// ============================================================

function handleUpdateDescription(payload) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Opportunity_Descriptions');
  if (!sheet) throw new Error('Opportunity_Descriptions tab not found');

  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var idCol = header.indexOf('description_id');
  var textCol = header.indexOf('description_text');
  var categoryCol = header.indexOf('category');

  if (idCol === -1) throw new Error('Column "description_id" not found in Opportunity_Descriptions');
  if (textCol === -1) throw new Error('Column "description_text" not found in Opportunity_Descriptions');
  if (categoryCol === -1) throw new Error('Column "category" not found in Opportunity_Descriptions — add it as the next empty column');

  for (var i = 1; i < data.length; i++) {
    if (data[i][idCol] === payload.descriptionId) {
      sheet.getRange(i + 1, textCol + 1).setValue(payload.standardizedText);
      sheet.getRange(i + 1, categoryCol + 1).setValue(payload.category);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, descriptionId: payload.descriptionId }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'description not found: ' + payload.descriptionId }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// UTILITY — Extract file ID from Google Drive URL
// ============================================================

function extractFileId(url) {
  // Handle various Google Drive URL formats. Order matters: the path-based
  // /d/<id> patterns cover drive.google.com/file/d/... AND
  // docs.google.com/spreadsheets|document|presentation/d/... (the form Drive
  // uses for Office files it opens in Sheets/Docs), and they must run BEFORE
  // the query-param pattern. The id= pattern requires a ? or & directly
  // before it — a bare /id=/ also matches inside "&ouid=1052781702..."
  // (the viewer's ACCOUNT id that Drive appends to share links), which is
  // exactly the wrong value to feed to getFileById.
  var patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/
  ];
  for (var i = 0; i < patterns.length; i++) {
    var match = url.match(patterns[i]);
    if (match) return match[1];
  }
  return null;
}

// ============================================================
// UTILITY — Resolve the Drive file for an analyze request
// ============================================================
// Tries every plausible ID: the one embedded in the drive_url the portal
// sends, then the docId itself (only when it is actually shaped like a
// Drive file ID — portal doc_ids like "DOC1739..." are skipped so they
// can never trigger DriveApp's cryptic "Unexpected error while getting
// the method or property getFileById on object DriveApp" failure).
// Fails with a readable error naming both values when nothing opens.

function resolveDriveFile_(payload) {
  var candidates = [];
  var fromUrl = extractFileId(String(payload.driveUrl || ''));
  if (fromUrl) candidates.push(fromUrl);
  if (payload.docId) candidates.push(String(payload.docId));

  var lastErr = null;
  for (var i = 0; i < candidates.length; i++) {
    var id = candidates[i];
    // Drive file IDs are long [-_A-Za-z0-9] strings that always contain
    // letters; skip obvious non-IDs (short portal keys, all-digit account
    // ids from &ouid= params) instead of letting getFileById throw.
    if (!/^[-\w]{20,}$/.test(id) || /^\d+$/.test(id)) continue;
    try {
      return DriveApp.getFileById(id);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error('Could not open the attached file in Drive (docId: '
    + (payload.docId || 'none') + ', driveUrl: ' + (payload.driveUrl || 'none') + ')'
    + (lastErr ? ' — last Drive error: ' + lastErr : '')
    + '. Check that the document row has a valid drive_url.');
}

// ============================================================
// UTILITY — Mark a document row as analyzed in Opportunity_Documents
// (shared by the generic and attendee-list analyze paths)
// ============================================================

function markDocumentAnalyzed_(docId) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Opportunity_Documents');
  if (!sheet || sheet.getLastRow() < 2) return;

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var analyzedIdx = headers.indexOf('analyzed');

  // Add 'analyzed' column if it doesn't exist
  if (analyzedIdx === -1) {
    var newCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, newCol).setValue('analyzed');
    analyzedIdx = newCol - 1;
  }

  for (var j = 0; j < data.length; j++) {
    if (data[j][0] == docId) {
      sheet.getRange(j + 2, analyzedIdx + 1).setValue('TRUE');
      break;
    }
  }
}

// ============================================================
// ============================================================
// LEAD CATEGORIZATION (SaaS demand-gen persona)
// ============================================================
// ============================================================

// The persona is stored in the Custom_Prompts tab under this label so it can be
// tuned without editing code. If the row is missing, the embedded default below
// is used, so the action always works.
var CATEGORIZER_LABEL = 'Event Lead Categorizer';

/**
 * doCategorizeLeads
 * Input payload: { action:'categorizeLeads', leads:[{ index, name, company, title, email, extra? }] }
 *   `extra` is an optional object carrying EVERY additional column from the
 *   uploaded file (e.g. Department, Job Level, Job Function, Industry) so the
 *   persona can weigh the whole row, not just the four mapped fields.
 * Output JSON:   { ok:true, results:[{ index, icp_role, seniority_tier, normalized_company, confidence, rationale }] }
 *
 * The client sends the list in small batches (~20). This function classifies one
 * batch per call and echoes each lead's `index` back so the client can match
 * results to rows regardless of order.
 */
function doCategorizeLeads(payload) {
  var leads = payload.leads || [];
  if (!leads.length) return jsonOut({ ok: true, results: [] });

  // Safety cap so a single request can never blow the model context / timeout.
  if (leads.length > 60) leads = leads.slice(0, 60);

  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in this project’s Script Properties');

  var instructions = getCategorizerInstructions();

  var leadJson = JSON.stringify(leads.map(function (l, i) {
    var obj = {
      index: (l.index != null ? l.index : i),
      name: (l.name || ''),
      company: (l.company || ''),
      title: (l.title || ''),
      email: (l.email || '')
    };
    // Forward the unmapped spreadsheet columns, bounded so a single wide row
    // can never blow up the request.
    if (l.extra && typeof l.extra === 'object') {
      var extra = {}, n = 0;
      for (var k in l.extra) {
        if (!Object.prototype.hasOwnProperty.call(l.extra, k)) continue;
        var v = String(l.extra[k] == null ? '' : l.extra[k]).trim();
        if (!v) continue;
        extra[String(k).substring(0, 60)] = v.substring(0, 200);
        if (++n >= 20) break;
      }
      if (n) obj.extra = extra;
    }
    return obj;
  }));

  var prompt = instructions +
    '\n\n=== LEADS TO CATEGORIZE (JSON) ===\n' + leadJson +
    '\n\nReturn ONLY the JSON array described above — one object per lead, in the same order, ' +
    'echoing each "index" value exactly as given. No prose, no markdown code fences.';

  var text = callClaudeText_(prompt, 8000, 'claude-sonnet-5');
  if (!text) throw new Error('Categorizer returned no output');

  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  var results;
  try {
    var parsed = JSON.parse(text);
    results = Array.isArray(parsed) ? parsed : (parsed.results || []);
  } catch (e) {
    // tolerate stray prose around the array
    var m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('Could not parse categorizer output as JSON');
    results = JSON.parse(m[0]);
  }

  return jsonOut({ ok: true, results: results });
}

/**
 * getCategorizerInstructions
 * Loads the persona from the Custom_Prompts tab (label = CATEGORIZER_LABEL),
 * cached for 5 minutes. Falls back to the embedded default if the row is
 * missing or the sheet can't be read — so the feature never hard-fails.
 */
function getCategorizerInstructions() {
  try {
    var cached = CacheService.getScriptCache().get('categorizer_instructions');
    if (cached) return cached;
  } catch (e) { /* cache unavailable — continue */ }

  var instructions = DEFAULT_CATEGORIZER_INSTRUCTIONS;
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName('Custom_Prompts');
    if (sheet && sheet.getLastRow() > 1) {
      var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var labelIdx = headers.indexOf('label');
      var instrIdx = headers.indexOf('instructions');
      if (labelIdx !== -1 && instrIdx !== -1) {
        for (var i = 0; i < data.length; i++) {
          if (String(data[i][labelIdx]).trim().toLowerCase() === CATEGORIZER_LABEL.toLowerCase() &&
              String(data[i][instrIdx]).trim().length > 40) {
            instructions = String(data[i][instrIdx]);
            break;
          }
        }
      }
    }
  } catch (e) { /* fall back to embedded default */ }

  try { CacheService.getScriptCache().put('categorizer_instructions', instructions, 300); } catch (e) {}
  return instructions;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * callClaudeText_
 * Shared Anthropic API caller: sends one prompt, returns the response text.
 * Throws a readable error on API failures or a safety refusal.
 */
function callClaudeText_(prompt, maxTokens, model) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in this project’s Script Properties');

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: model || 'claude-opus-4-8',
      max_tokens: maxTokens || 4096,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());
  if (result && result.error) throw new Error('Anthropic API error: ' + result.error.message);
  if (result && result.stop_reason === 'refusal') throw new Error('Claude declined to analyze this content');

  var text = '';
  if (result.content && Array.isArray(result.content)) {
    for (var i = 0; i < result.content.length; i++) {
      if (result.content[i].type === 'text') text += result.content[i].text;
    }
  }
  return text;
}

/**
 * callClaudeWithWebSearch_
 * Same API, but with Anthropic's server-side web-search tool enabled —
 * Anthropic runs the searches, so no extra Apps Script services or search
 * API keys are needed. The response interleaves search blocks with text
 * blocks; the strict-JSON answer is in the LAST text block (earlier ones
 * are pre-search narration). Long research turns can return stop_reason
 * "pause_turn" — the API asks us to send the partial content back and let
 * it continue, so we loop a few times.
 */
function callClaudeWithWebSearch_(prompt, maxTokens) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in this project’s Script Properties');

  var messages = [{ role: 'user', content: prompt }];

  for (var attempt = 0; attempt < 4; attempt++) {
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: maxTokens || 8000,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: WEB_ENRICH_MAX_SEARCHES
        }],
        messages: messages
      }),
      muteHttpExceptions: true
    });

    var result = JSON.parse(response.getContentText());
    if (result && result.error) throw new Error('Anthropic API error: ' + result.error.message);
    if (result && result.stop_reason === 'refusal') throw new Error('Claude declined to research these contacts');
    if (result && result.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: result.content });
      continue;
    }

    var text = '';
    if (result.content && Array.isArray(result.content)) {
      for (var i = 0; i < result.content.length; i++) {
        if (result.content[i].type === 'text') text = result.content[i].text;
      }
    }
    return text;
  }
  throw new Error('Web search research did not finish');
}

/**
 * parseJsonLoose_
 * Tolerant JSON parse: strips markdown fences and stray prose around the
 * JSON if the model ever wraps its answer despite the strict-JSON rules.
 */
function parseJsonLoose_(text) {
  if (!text) return null;
  var cleaned = String(text).trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  var start = cleaned.search(/[\[{]/);
  if (start > 0) cleaned = cleaned.slice(start);
  var end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (end >= 0) cleaned = cleaned.slice(0, end + 1);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
}

/**
 * readEventRows
 * Shared reader for the Events tab. Returns each row as an object keyed by the
 * header row (event_id, title, description, event_date, end_date, event_type,
 * location, url, created_by, created_at, status, partner_id, checklist,
 * lead_count, event_password). Values are passed through verbatim — nothing is
 * inferred or rewritten. Dates that Sheets stores as real Date values are
 * serialized as yyyy-MM-dd in the spreadsheet's own time zone; text dates
 * (e.g. "11/19/2025") are returned as-is. Fully blank rows and rows without a
 * title are skipped. Each row also carries `_row` (its sheet row number) so a
 * row without an event_id can still be addressed unambiguously.
 */
function readEventRows() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Events');
  if (!sheet || sheet.getLastRow() < 2) return [];

  var numCols = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  var tz = ss.getSpreadsheetTimeZone();

  var rows = [];
  for (var i = 0; i < data.length; i++) {
    var obj = {};
    var empty = true;
    for (var j = 0; j < headers.length; j++) {
      var h = String(headers[j] || '').trim();
      if (!h) continue;
      var v = data[i][j];
      if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      if (v !== '' && v != null) empty = false;
      obj[h] = v;
    }
    if (empty || !String(obj.title || '').trim()) continue;
    obj._row = i + 2;
    rows.push(obj);
  }
  return rows;
}

// Completed events are never offered or served — the workspace is for events
// that are still live, upcoming, or otherwise workable.
function isCompletedEvent(row) {
  return /complete/i.test(String(row.status || ''));
}

// Stable selector for a row: its event_id when present, else its sheet row.
function eventKeyOf(row) {
  var id = String(row.event_id == null ? '' : row.event_id).trim();
  return id !== '' ? id : ('row-' + row._row);
}

// The Events tab's password column is named `event_password` (column O in the
// live sheet). Some older copies used a plain `password` header, so check that as
// a fallback. This value is the hinge of the whole gate: if the header lookup
// misses, password protection silently switches OFF for every event AND the
// secret would ride along in the openEvent payload — so read it defensively.
function eventPasswordOf(row) {
  var primary = String(row.event_password == null ? '' : row.event_password).trim();
  if (primary !== '') return primary;
  return String(row.password == null ? '' : row.password).trim();
}

/**
 * doListEvents
 * Returns ONLY what the event picker needs: key, title, dates, type, location,
 * status, and whether the event is password-protected. Descriptions, lead
 * counts, checklists — and above all the password itself — are deliberately
 * NOT included: full details are only released by `openEvent` after the
 * password (when one is set on the row) has been verified server-side.
 * Completed events are excluded entirely.
 */
function doListEvents() {
  var rows = readEventRows();
  var events = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (isCompletedEvent(r)) continue;
    events.push({
      key: eventKeyOf(r),
      title: r.title,
      event_date: r.event_date || '',
      end_date: r.end_date || '',
      event_type: r.event_type || '',
      location: r.location || '',
      status: r.status || '',
      has_password: eventPasswordOf(r) !== ''
    });
  }
  return jsonOut({ ok: true, events: events });
}

/**
 * doOpenEvent
 * Input payload: { action:'openEvent', eventKey:'<key from listEvents>', password:'<user input>' }
 * Verifies the password against the row's password cell (exact match after
 * trimming; rows with an empty password cell are open to everyone) and only
 * then returns the full event row — minus the password itself. The check runs
 * here, server-side, so the password never travels to the browser. Completed
 * events are refused even if addressed directly. Very long descriptions are
 * capped to keep the payload light.
 */
function doOpenEvent(payload) {
  var key = String(payload.eventKey == null ? '' : payload.eventKey).trim();
  if (!key) return jsonOut({ ok: false, code: 'bad_request', error: 'No event selected' });

  var rows = readEventRows();
  var found = null;
  for (var i = 0; i < rows.length; i++) {
    if (eventKeyOf(rows[i]) === key) { found = rows[i]; break; }
  }
  if (!found) {
    return jsonOut({ ok: false, code: 'not_found', error: 'Event not found — it may have been removed from the sheet' });
  }
  if (isCompletedEvent(found)) {
    return jsonOut({ ok: false, code: 'completed', error: 'This event is completed and can no longer be opened' });
  }

  var pw = eventPasswordOf(found);
  if (pw !== '') {
    var given = String(payload.password == null ? '' : payload.password).trim();
    if (given !== pw) {
      return jsonOut({ ok: false, code: 'bad_password', error: 'Incorrect password for this event' });
    }
  }

  var out = {};
  for (var k in found) {
    if (!Object.prototype.hasOwnProperty.call(found, k)) continue;
    if (k === 'password' || k === 'event_password' || k === '_row') continue;
    out[k] = found[k];
  }
  if (typeof out.description === 'string' && out.description.length > 4000) {
    out.description = out.description.substring(0, 4000) + '…';
  }
  out.key = eventKeyOf(found);
  return jsonOut({ ok: true, event: out });
}

/**
 * DEFAULT_CATEGORIZER_INSTRUCTIONS
 * The embedded copy of the "Event Lead Categorizer" persona. Keep this in sync
 * with the Custom_Prompts row of the same label (Custom_Prompts wins at runtime).
 * The category vocabulary here (Decision Maker / Champion / Influencer + the five
 * seniority tiers) matches exactly what index.html renders, so results slot
 * straight into the UI.
 */
var DEFAULT_CATEGORIZER_INSTRUCTIONS = [
'Role',
'You are an accuracy-obsessed SaaS marketing demand-generation expert and lead analyst working an event target list for a B2B go-to-market team. Your single, overriding objective is factual accuracy. Speed, completeness, and polish are all subordinate to accuracy. An incomplete classification that is fully accurate is a success. A complete classification with one guessed or fabricated detail is a failure.',
'',
'Task',
'For each lead you receive (name, company, job title, email, plus an optional "extra" object carrying every other column from the uploaded file — e.g. Department, Job Level, Job Function, Seniority, Industry), determine three things and nothing more:',
'1. icp_role  — the lead’s role in the B2B buying group, judged primarily from the job title, corroborated by any "extra" columns that explicitly describe the person’s role, level, function or department.',
'2. seniority_tier — the lead’s organizational seniority, judged the same way: job title first, role/level/function/department columns in "extra" as supporting signal.',
'3. normalized_company — the company name cleaned for consistent display. Formatting only. Never invent or change the company’s identity.',
'',
'icp_role — choose EXACTLY one of these four values:',
'- "Decision Maker" — holds budget authority or final sign-off. Executive and senior leadership: C-level (CIO, CISO, CTO, CEO, CFO, COO, Chief*), President, Owner, Founder, Partner, and VP/SVP/EVP. These people can say yes and fund it.',
'- "Champion" — an internal owner/driver who advances the initiative and influences the decision from the inside, but usually needs sign-off from above. Function/team leaders: Director, Senior Director, Head of (team), Manager, Team Lead, Supervisor.',
'- "Influencer" — an individual contributor or practitioner who evaluates, uses, or recommends the product but does not own the decision: Engineer, Administrator, Analyst, Architect, Specialist, Coordinator, Consultant, and similar non-management roles.',
'- "Unknown" — the title is blank, a placeholder ("-", "—", "N/A", "TBD"), or genuinely ambiguous, AND no "extra" column explicitly describing role/level/function resolves it. Use this rather than guessing.',
'',
'seniority_tier — choose EXACTLY one of these five values (these are the only allowed strings):',
'- "C-Suite" — Chief*, CxO (CIO/CISO/CTO/CEO/CFO/COO), President, Owner, Founder, Partner.',
'- "VP" — VP, SVP, EVP, Vice President, Head of (department-wide).',
'- "Director" — Director, Senior/Sr. Director, Head of (a team).',
'- "Manager" — Manager, Team Lead, Lead, Supervisor.',
'- "Individual" — Engineer, Administrator, Analyst, Architect, Specialist, Coordinator, Consultant, and any other non-management individual-contributor role.',
'- If the title is missing or ambiguous, do not force a tier: use "Individual" only when there is at least weak signal, and reflect the uncertainty by setting icp_role to "Unknown" and confidence to "low".',
'',
'Accuracy rules (non-negotiable):',
'- Judge role and seniority from the job-title text first. When the title is blank, a placeholder, or ambiguous, you MAY use "extra" columns that explicitly describe the person’s role, level, function or department (e.g. "Job Level", "Seniority", "Department", "Job Function", "Management Level") to classify. Do NOT infer role or seniority from the company name, the email address, the person’s name, or unrelated extra columns (industry, city, revenue, phone, notes, …).',
'- If neither the title nor a role-describing extra column gives clear signal, return icp_role "Unknown" and confidence "low". Never guess to look complete.',
'- normalized_company: fix ONLY capitalization, stray spacing, and obvious legal-suffix casing (e.g. "acme corp" → "Acme Corp", "INSIGHT ENTERPRISES" → "Insight Enterprises"). Do NOT expand abbreviations you are unsure about, invent a longer name, merge two companies, or change the identity. If company is blank or a placeholder, return an empty string "".',
'- Never invent titles, roles, seniority, or company facts that are not supported by the input.',
'- confidence reflects how clearly the title maps to the role/tier: "high", "medium", or "low".',
'',
'Output format:',
'Return ONLY a JSON array — no prose, no explanation, no markdown code fences. One object per input lead, in the SAME order as the input, echoing the given "index" exactly. Each object has EXACTLY these fields:',
'[',
'  {',
'    "index": <the index value from the input, echoed unchanged>,',
'    "icp_role": "Decision Maker" | "Champion" | "Influencer" | "Unknown",',
'    "seniority_tier": "C-Suite" | "VP" | "Director" | "Manager" | "Individual",',
'    "normalized_company": "<cleaned company name, or empty string>",',
'    "confidence": "high" | "medium" | "low",',
'    "rationale": "<one short phrase citing the title signal, e.g. \'CISO = C-level budget owner\'>"',
'  }',
']'
].join('\n');

// ============================================================
// ============================================================
// EVENT CONTACTS (per-event target list, saved back to the sheet)
// ============================================================
// ============================================================

// The Event_Contacts tab is keyed by `event_id` — the SAME key `listEvents` /
// `openEvent` hand to the browser (the row's event_id, or `row-N` for rows
// without one, via eventKeyOf). One shared tab, many events, exactly like
// Opportunity_Documents is one tab keyed by opportunity_id.
var EVENT_CONTACTS_TAB = 'Event_Contacts';
var EVENT_CONTACT_HEADERS = [
  'event_id', 'event_title', 'contact_id', 'name', 'title', 'company', 'email',
  'owner', 'status', 'icp_role', 'seniority_tier', 'ai_confidence',
  'ai_rationale', 'source_file', 'saved_at'
];

/**
 * getEventContactsSheet
 * Returns the Event_Contacts sheet, creating it with the header row on first
 * use. If an older copy exists with a shorter header, any missing columns are
 * appended so name-based indexing always works.
 */
function getEventContactsSheet(ss) {
  var sheet = ss.getSheetByName(EVENT_CONTACTS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(EVENT_CONTACTS_TAB);
    sheet.getRange(1, 1, 1, EVENT_CONTACT_HEADERS.length).setValues([EVENT_CONTACT_HEADERS]);
    return sheet;
  }
  // Ensure every expected header exists (future-proofing an older tab).
  var lastCol = Math.max(1, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var missing = EVENT_CONTACT_HEADERS.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

/**
 * eventContactRowFor
 * Builds one Event_Contacts row aligned to the sheet's actual header order.
 * Accepts either the client field names (icpRole/tier/confidence/rationale) or
 * the stored ones (icp_role/seniority_tier/ai_confidence/ai_rationale).
 */
function eventContactRowFor(headers, eventKey, eventTitle, fileName, stamp, c) {
  c = c || {};
  var map = {
    event_id: eventKey,
    event_title: eventTitle,
    contact_id: String(c.id != null ? c.id : (c.contact_id != null ? c.contact_id : '')),
    name: String(c.name == null ? '' : c.name),
    title: String(c.title == null ? '' : c.title),
    company: String(c.company == null ? '' : c.company),
    email: String(c.email == null ? '' : c.email),
    owner: String(c.owner == null ? '' : c.owner),
    status: String(c.status == null ? '' : c.status),
    icp_role: String(c.icp_role != null ? c.icp_role : (c.icpRole != null ? c.icpRole : '')),
    seniority_tier: String(c.seniority_tier != null ? c.seniority_tier : (c.tier != null ? c.tier : '')),
    ai_confidence: String(c.ai_confidence != null ? c.ai_confidence : (c.confidence != null ? c.confidence : '')),
    ai_rationale: String(c.ai_rationale != null ? c.ai_rationale : (c.rationale != null ? c.rationale : '')),
    source_file: String(fileName == null ? '' : fileName),
    saved_at: stamp
  };
  return headers.map(function (h) {
    return Object.prototype.hasOwnProperty.call(map, h) ? map[h] : '';
  });
}

/**
 * doSaveEventContacts
 * Input payload: { action:'saveEventContacts', eventKey, eventTitle, fileName,
 *                  contacts:[{ id, name, title, company, email, owner, status,
 *                              icp_role, seniority_tier, confidence, rationale }] }
 *
 * Replace-by-event: every existing Event_Contacts row for `eventKey` is removed
 * and the supplied list is written in its place, so the tab always mirrors the
 * current target list for that event (re-uploads and status changes never pile
 * up duplicates). Rows belonging to OTHER events are left untouched. As a
 * convenience the matching Events row's `lead_count` cell is refreshed to the
 * saved count (best-effort — never fatal).
 *
 * A script lock guards the read-clear-rewrite so two simultaneous saves can
 * never interleave and corrupt the tab.
 *
 * Output: { ok:true, saved:<n>, event_id:<key> }
 */
function doSaveEventContacts(payload) {
  var key = String(payload.eventKey == null ? '' : payload.eventKey).trim();
  if (!key) return jsonOut({ ok: false, code: 'bad_request', error: 'No event specified' });

  var contacts = (payload.contacts && payload.contacts.length) ? payload.contacts : [];
  // Safety cap: a single save can never write an unbounded number of rows.
  if (contacts.length > 5000) contacts = contacts.slice(0, 5000);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = getEventContactsSheet(ss);
    var numCols = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0].map(function (h) { return String(h || '').trim(); });
    var idIdx = headers.indexOf('event_id');
    if (idIdx === -1) throw new Error('Event_Contacts is missing its event_id column');

    // Keep every existing row that belongs to a DIFFERENT event.
    var kept = [];
    if (sheet.getLastRow() > 1) {
      var existing = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
      for (var i = 0; i < existing.length; i++) {
        var rowKey = String(existing[i][idIdx] == null ? '' : existing[i][idIdx]).trim();
        if (rowKey === '') continue;          // drop stray blank rows
        if (rowKey !== key) kept.push(existing[i]);
      }
    }

    var eventTitle = String(payload.eventTitle == null ? '' : payload.eventTitle);
    var fileName = String(payload.fileName == null ? '' : payload.fileName);
    var stamp = new Date().toISOString();
    var fresh = contacts.map(function (c) {
      return eventContactRowFor(headers, key, eventTitle, fileName, stamp, c);
    });

    var all = kept.concat(fresh);

    // Rewrite the whole data area in one batched write, then clear any leftover
    // trailing rows (when the new total is shorter than what was there before).
    var prevRows = sheet.getLastRow() - 1;
    if (prevRows > 0) sheet.getRange(2, 1, prevRows, numCols).clearContent();
    if (all.length) sheet.getRange(2, 1, all.length, numCols).setValues(all);

    // Best-effort: keep the Events tab's lead_count in step with what we saved.
    try { updateEventLeadCount(ss, key, fresh.length); } catch (e) { /* non-fatal */ }

    return jsonOut({ ok: true, saved: fresh.length, event_id: key });
  } finally {
    lock.releaseLock();
  }
}

/**
 * doListEventContacts
 * Input payload: { action:'listEventContacts', eventKey }
 * Returns every Event_Contacts row for that event as an object keyed by header.
 * Missing tab / no rows → an empty list (never an error), so a first-time event
 * simply opens with no contacts.
 *
 * Output: { ok:true, contacts:[ { event_id, name, title, company, email, owner,
 *           status, icp_role, seniority_tier, ai_confidence, ai_rationale,
 *           contact_id, source_file, saved_at } ] }
 */
function doListEventContacts(payload) {
  var key = String(payload.eventKey == null ? '' : payload.eventKey).trim();
  if (!key) return jsonOut({ ok: true, contacts: [] });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(EVENT_CONTACTS_TAB);
  if (!sheet || sheet.getLastRow() < 2) return jsonOut({ ok: true, contacts: [] });

  var numCols = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var idIdx = headers.indexOf('event_id');
  if (idIdx === -1) return jsonOut({ ok: true, contacts: [] });

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  var out = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][idIdx] == null ? '' : data[i][idIdx]).trim() !== key) continue;
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var h = headers[j];
      if (!h) continue;
      var v = data[i][j];
      obj[h] = (v instanceof Date) ? v.toISOString() : v;
    }
    out.push(obj);
  }
  return jsonOut({ ok: true, contacts: out });
}

/**
 * updateEventLeadCount
 * Writes `count` into the `lead_count` cell of the Events row whose key matches
 * `eventKey`. Uses the shared readEventRows()/eventKeyOf() so the join is byte-
 * identical to how the picker addressed the event. No-op when the column or the
 * row can't be found.
 */
function updateEventLeadCount(ss, eventKey, count) {
  var sheet = ss.getSheetByName('Events');
  if (!sheet || sheet.getLastRow() < 2) return;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var lcIdx = -1;
  for (var j = 0; j < headers.length; j++) {
    if (String(headers[j] || '').trim() === 'lead_count') { lcIdx = j; break; }
  }
  if (lcIdx === -1) return;

  var rows = readEventRows();
  for (var i = 0; i < rows.length; i++) {
    if (eventKeyOf(rows[i]) === eventKey) {
      sheet.getRange(rows[i]._row, lcIdx + 1).setValue(count);
      return;
    }
  }
}

// ============================================================
// ============================================================
// ATTENDEE-LIST ANALYSIS (portal event modal "Analyze")
// Called via analyzeDocument + analysisType:'attendee_list'.
// Spreadsheets are read deterministically across EVERY tab of the
// workbook — Claude only decides, per tab, whether it holds an
// attendee table, where the header row sits, and which column is
// which, so names/emails can never be hallucinated. Job
// titles are classified with the SAME "Event Lead Categorizer"
// persona the playbook uses, so both flows write identical
// vocabulary into Event_Contacts. Contacts still missing fields the
// file didn't contain are then researched online via web search
// (verified findings only). The portal itself writes the contact
// rows; this handler only returns them.
// ============================================================
// ============================================================

var ATTENDEE_MAX_ROWS = 2000;         // hard cap on contacts read from a file (all tabs combined)
var ATTENDEE_MAX_TABS = 10;           // hard cap on workbook tabs analyzed per file
var ATTENDEE_HEADER_SCAN_ROWS = 25;   // rows per tab shown to Claude to find the header + map columns
var ATTENDEE_HTML_PART_LIMIT = 40000; // stay under the 50k Sheets cell cap
var ATTENDEE_MAX_DOC_CHARS = 60000;   // cap on extracted text for PDFs/Word
var ATTENDEE_TITLE_BATCH = 100;       // unique titles per classification call
var ATTENDEE_MAX_TITLE_BATCHES = 3;   // at most 300 unique titles classified
var WEB_ENRICH_MAX_CONTACTS = 15;     // cap on contacts researched online per run
var WEB_ENRICH_BATCH_SIZE = 5;        // contacts per web-search API call
var WEB_ENRICH_MAX_SEARCHES = 15;     // web_search max_uses per API call

function doAnalyzeAttendeeList(payload) {
  var file = resolveDriveFile_(payload);
  var fileId = file.getId();
  var fileName = file.getName();
  var lower = fileName.toLowerCase();

  var extraction;
  if (/\.(xlsx|xlsm|csv)$/.test(lower)) {
    extraction = extractAttendeesFromSpreadsheet_(file, lower);
  } else {
    extraction = extractAttendeesFromDocumentText_(file, fileId);
  }

  var contacts = extraction.contacts;

  // Best-effort: classify job titles with the shared categorizer persona so
  // icp_role / seniority_tier match what the playbook writes. If this fails,
  // contacts still return with those fields blank.
  try {
    classifyAttendeeTitles_(contacts);
  } catch (e) { /* non-fatal */ }

  // Best-effort: contacts still missing fields the file didn't contain
  // (job title, company, ICP classification) are researched ONLINE via
  // Claude's web-search tool, using the info the file DID provide (name,
  // email domain, company). Only verified findings are filled — anything
  // unconfirmed stays blank rather than guessed.
  try {
    enrichContactsByWebSearch_(contacts);
  } catch (e) { /* non-fatal */ }

  var parts = buildAttendeeHtmlParts_(contacts, extraction.note);

  // Persist the analyzed flag on the document row (same tab the generic
  // analyze path uses), so the portal shows "✓ Analyzed" on reload too.
  try { markDocumentAnalyzed_(payload.docId); } catch (e) { /* non-fatal */ }

  var out = { ok: true, fileName: fileName, contacts: contacts };
  if (parts.length > 1) {
    out.htmlParts = parts;
  } else {
    out.html = parts[0] || '<p>No contacts found.</p>';
  }
  return jsonOut(out);
}

// ── Structured files: deterministic read + column-mapping call ─────────
//
// EVERY tab of the workbook is analyzed — event lists routinely put the
// real attendee table on a later tab behind an instructions/cover sheet
// (e.g. "START HERE" / "1st Party" / "3rd Party"). For each tab, Claude
// first decides whether the tab contains an attendee table at all and
// where its header row sits (headers are often a few rows down, below
// titles and instruction rows); tabs with no attendee data are skipped
// and named in the summary note. Contacts from all tabs are combined,
// with exact duplicate emails across tabs removed.

function extractAttendeesFromSpreadsheet_(file, lowerName) {
  var tabs = [];
  if (/\.csv$/.test(lowerName)) {
    tabs.push({ name: '', rows: Utilities.parseCsv(file.getBlob().getDataAsString('UTF-8')) });
  } else {
    // .xlsx / .xlsm — convert to a temporary Google Sheet, read EVERY
    // tab's values, then trash the temp copy (same pattern as the generic
    // analyze path).
    var tempSheet = Drive.Files.copy(
      { title: 'TEMP_ANALYZE_' + Date.now(), mimeType: 'application/vnd.google-apps.spreadsheet' },
      file.getId()
    );
    try {
      var sheets = SpreadsheetApp.openById(tempSheet.id).getSheets();
      for (var s = 0; s < sheets.length; s++) {
        tabs.push({ name: sheets[s].getName(), rows: sheets[s].getDataRange().getValues() });
      }
    } finally {
      DriveApp.getFileById(tempSheet.id).setTrashed(true);
    }
  }

  var allContacts = [];
  var analyzed = [];
  var skipped = [];
  var emailSeen = {};
  var dupes = 0;
  var tabCount = Math.min(tabs.length, ATTENDEE_MAX_TABS);

  for (var t = 0; t < tabCount; t++) {
    if (allContacts.length >= ATTENDEE_MAX_ROWS) break;
    var tab = tabs[t];
    var label = tab.name ? '"' + tab.name + '"' : 'sheet';

    var res;
    try {
      res = extractContactsFromTabRows_(tab.rows, tab.name);
    } catch (e) {
      skipped.push(label + ' (error: ' + e.message + ')');
      continue;
    }
    if (!res.contacts.length) {
      skipped.push(label + ' (' + (res.skipReason || 'no attendee table') + ')');
      continue;
    }

    var added = 0;
    for (var i = 0; i < res.contacts.length && allContacts.length < ATTENDEE_MAX_ROWS; i++) {
      var c = res.contacts[i];
      var ekey = (c.email && c.email !== 'Not specified') ? c.email.toLowerCase() : '';
      if (ekey) {
        if (emailSeen[ekey]) { dupes++; continue; }
        emailSeen[ekey] = true;
      }
      allContacts.push(c);
      added++;
    }
    analyzed.push(label + ': ' + added + ' contacts' + (res.note ? ' (' + res.note + ')' : ''));
  }

  // The summary note names every tab and what happened to it, so a skipped
  // tab is always visible instead of silently missing from the results.
  var noteParts = [];
  if (analyzed.length) noteParts.push('Tabs analyzed — ' + analyzed.join('; ') + '.');
  if (skipped.length) noteParts.push('Tabs skipped — ' + skipped.join('; ') + '.');
  if (dupes) noteParts.push(dupes + ' duplicate email' + (dupes === 1 ? '' : 's') + ' across tabs removed.');
  if (tabs.length > tabCount) noteParts.push('Only the first ' + ATTENDEE_MAX_TABS + ' of ' + tabs.length + ' tabs were analyzed.');
  if (allContacts.length >= ATTENDEE_MAX_ROWS) noteParts.push('Contact list capped at ' + ATTENDEE_MAX_ROWS + ' rows.');
  if (!allContacts.length && !noteParts.length) noteParts.push('File contained no data rows.');

  return { contacts: allContacts, note: noteParts.join(' ') };
}

/**
 * extractContactsFromTabRows_
 * Analyzes ONE tab's raw values. Claude looks at the first rows and
 * decides (a) whether this tab holds an attendee/contact table at all,
 * (b) which row is the header row (often not row 1 — event templates put
 * titles and instructions above the table), and (c) which column is
 * which. The contacts themselves are then built deterministically in
 * code from ALL rows below the header, so names/emails can never be
 * hallucinated. Tabs with no attendee table return an empty list with a
 * skipReason instead of throwing, so one instructions tab never aborts
 * the other tabs.
 */
function extractContactsFromTabRows_(rows, tabName) {
  if (!rows || rows.length < 2) return { contacts: [], skipReason: 'empty tab' };

  // Bound what we show Claude: enough rows to find a late header row,
  // with wide/verbose cells trimmed so one instructions tab can't blow
  // up the request. Column indexes stay true to the full row.
  var scan = rows.slice(0, ATTENDEE_HEADER_SCAN_ROWS).map(function (row) {
    return row.slice(0, 60).map(function (cell) {
      var v = (cell === null || cell === undefined) ? '' : String(cell);
      return v.length > 200 ? v.substring(0, 200) : v;
    });
  });

  var prompt =
    'You are mapping spreadsheet columns for a CRM import. Below are the ' +
    'first rows of one tab' + (tabName ? ' (named "' + tabName + '")' : '') +
    ' of an event attendee workbook.\n\n' +
    'This tab may be an attendee/lead/contact table, OR it may be an ' +
    'instructions, cover, notes, or configuration tab with no attendee data.\n\n' +
    'Step 1 — decide whether this tab contains a table of people (event ' +
    'attendees, leads, or contacts). If it does NOT, return null for ' +
    'header_row and every column.\n\n' +
    'Step 2 — if it does, identify:\n' +
    '- header_row: the ZERO-BASED index, within the rows shown, of the row ' +
    'containing the column headers. Tables often start a few rows down, ' +
    'below a title row and instruction rows.\n' +
    '- The ZERO-BASED column index for each of the following (null when no ' +
    'column matches):\n' +
    '  - company: the attendee\'s company or organization\n' +
    '  - contact_name: the attendee\'s full name in a single column\n' +
    '  - first_name / last_name: separate name columns, if the sheet splits ' +
    'them (when a full-name column exists, prefer contact_name and set ' +
    'these to null)\n' +
    '  - email: the attendee\'s email address\n' +
    '  - role_title: the attendee\'s job title or role\n\n' +
    'Rules:\n' +
    '- Be concise. Base everything only on what is present in the rows shown.\n' +
    '- Never guess or fabricate: if you are not confident, use null.\n' +
    '- Respond in strict JSON only — no prose, no markdown fences.\n\n' +
    'Respond with exactly this JSON shape:\n' +
    '{"header_row": <index|null>, "company": <index|null>, ' +
    '"contact_name": <index|null>, "first_name": <index|null>, ' +
    '"last_name": <index|null>, "email": <index|null>, ' +
    '"role_title": <index|null>, ' +
    '"data_quality_note": "<one short sentence about data quality, or an empty string>"}\n\n' +
    'ROWS (first ' + scan.length + ' rows of this tab):\n' + JSON.stringify(scan);

  var mapping = parseJsonLoose_(callClaudeText_(prompt, 1024, 'claude-opus-4-8'));
  if (!mapping || typeof mapping !== 'object') {
    return { contacts: [], skipReason: 'could not map columns' };
  }

  var headerRow = mapping.header_row;
  var hasNameCol = mapping.contact_name != null || mapping.first_name != null || mapping.last_name != null;
  if (typeof headerRow !== 'number' || headerRow < 0 || (!hasNameCol && mapping.email == null)) {
    return { contacts: [], skipReason: 'no attendee table' };
  }

  var dataRows = rows.slice(headerRow + 1, headerRow + 1 + ATTENDEE_MAX_ROWS);
  var contacts = [];
  for (var i = 0; i < dataRows.length; i++) {
    var row = dataRows[i];
    var name = pickAttendeeCell_(row, mapping.contact_name);
    if (!name) {
      var first = pickAttendeeCell_(row, mapping.first_name);
      var last = pickAttendeeCell_(row, mapping.last_name);
      name = (first + ' ' + last).trim();
    }
    var company = pickAttendeeCell_(row, mapping.company);
    var email = pickAttendeeCell_(row, mapping.email);
    var role = pickAttendeeCell_(row, mapping.role_title);
    // Skip fully-empty rows (common at the bottom of exports).
    if (!name && !company && !email && !role) continue;
    contacts.push({
      name: name || 'Not specified',
      company: company || 'Not specified',
      email: email || 'Not specified',
      role: role || 'Not specified',
      icp_role: '', seniority_tier: '', ai_confidence: '', ai_rationale: ''
    });
  }

  return { contacts: contacts, note: String(mapping.data_quality_note || '') };
}

function pickAttendeeCell_(row, index) {
  if (index === null || index === undefined || index < 0) return '';
  var v = row[index];
  return (v === null || v === undefined) ? '' : String(v).trim();
}

// ── Unstructured files (PDF / Word): extraction fallback ───────────────

function extractAttendeesFromDocumentText_(file, fileId) {
  // Convert to a temporary Google Doc (OCR for PDFs), read the text, trash
  // the temp copy — same pattern as the generic analyze path.
  var tempDoc = Drive.Files.copy(
    { title: 'TEMP_ANALYZE_' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
    fileId,
    { ocr: true, ocrLanguage: 'en' }
  );
  var text;
  try {
    text = DocumentApp.openById(tempDoc.id).getBody().getText();
  } finally {
    DriveApp.getFileById(tempDoc.id).setTrashed(true);
  }

  if (!text || text.trim().length < 20) {
    return { contacts: [], note: 'No text could be extracted from this file.' };
  }
  if (text.length > ATTENDEE_MAX_DOC_CHARS) {
    text = text.substring(0, ATTENDEE_MAX_DOC_CHARS);
  }

  var prompt =
    'Extract the list of event attendees/contacts from the document text below.\n\n' +
    'Rules:\n' +
    '- Be concise. Extract only people actually present in the text.\n' +
    '- Never guess or fabricate names, emails, companies, or titles. Do not ' +
    'invent or "complete" partial email addresses.\n' +
    '- If a field is not present for a person, use "Not specified".\n' +
    '- Respond in strict JSON only — no prose, no markdown fences.\n\n' +
    'Respond with exactly this JSON shape:\n' +
    '{"contacts": [{"name": "...", "company": "...", "email": "...", "role": "..."}], ' +
    '"note": "<one short sentence about data quality, or an empty string>"}\n\n' +
    'DOCUMENT TEXT:\n' + text;

  var parsed = parseJsonLoose_(callClaudeText_(prompt, 16000, 'claude-opus-4-8'));
  var raw = (parsed && Array.isArray(parsed.contacts)) ? parsed.contacts : [];
  var contacts = raw.map(function (c) {
    return {
      name: String(c.name || 'Not specified'),
      company: String(c.company || 'Not specified'),
      email: String(c.email || 'Not specified'),
      role: String(c.role || 'Not specified'),
      icp_role: '', seniority_tier: '', ai_confidence: '', ai_rationale: ''
    };
  });
  return { contacts: contacts, note: String((parsed && parsed.note) || '') };
}

// ── Title classification via the shared categorizer persona ────────────

/**
 * classifyAttendeeTitles_
 * Classifies the UNIQUE job titles (not every contact — a 1,000-person list
 * usually has far fewer distinct titles) using the same "Event Lead
 * Categorizer" persona and model as doCategorizeLeads, then maps the results
 * back onto every contact. This keeps icp_role / seniority_tier values in
 * Event_Contacts identical no matter which flow wrote them.
 */
function classifyAttendeeTitles_(contacts) {
  var seen = {};
  var unique = [];
  for (var i = 0; i < contacts.length; i++) {
    var t = contacts[i].role;
    if (!t || t === 'Not specified' || seen[t]) continue;
    seen[t] = true;
    unique.push(t);
  }
  if (!unique.length) return;

  var instructions = getCategorizerInstructions();
  var byTitle = {};
  var maxTitles = Math.min(unique.length, ATTENDEE_TITLE_BATCH * ATTENDEE_MAX_TITLE_BATCHES);

  for (var start = 0; start < maxTitles; start += ATTENDEE_TITLE_BATCH) {
    var batch = unique.slice(start, start + ATTENDEE_TITLE_BATCH);
    var leads = batch.map(function (title, idx) {
      return { index: idx, name: '', company: '', title: title, email: '' };
    });

    var prompt = instructions +
      '\n\n=== LEADS TO CATEGORIZE (JSON) ===\n' + JSON.stringify(leads) +
      '\n\nReturn ONLY the JSON array described above — one object per lead, in the same order, ' +
      'echoing each "index" value exactly as given. No prose, no markdown code fences.';

    var parsed = parseJsonLoose_(callClaudeText_(prompt, 8000, 'claude-sonnet-5'));
    var results = Array.isArray(parsed) ? parsed : (parsed && parsed.results) || [];
    for (var r = 0; r < results.length; r++) {
      var res = results[r];
      if (!res || res.index == null || !batch[res.index]) continue;
      byTitle[batch[res.index]] = res;
    }
  }

  for (var c = 0; c < contacts.length; c++) {
    var hit = byTitle[contacts[c].role];
    if (!hit) continue;
    contacts[c].icp_role = String(hit.icp_role || '');
    contacts[c].seniority_tier = String(hit.seniority_tier || '');
    contacts[c].ai_confidence = String(hit.confidence || '');
    contacts[c].ai_rationale = String(hit.rationale || '');
  }
}

// ── Fallback enrichment: web search for fields the file didn't have ────
//
// Runs AFTER the title pass and touches ONLY contacts that are still
// incomplete. Accuracy contract: a field may be filled only when a search
// result confirms it for that specific person or company — anything
// unverified stays blank. Wrong-but-filled is worse than empty.

function contactNeedsWebEnrichment_(c) {
  var noRole = !c.role || c.role === 'Not specified';
  var noCompany = !c.company || c.company === 'Not specified';
  var noIcp = !c.icp_role || c.icp_role === 'Unknown' || !c.seniority_tier;
  if (!noRole && !noCompany && !noIcp) return false;
  // There must be something to search WITH: a name plus either an email
  // (whose domain can identify the employer) or a known company.
  var hasName = c.name && c.name !== 'Not specified';
  var hasEmail = c.email && c.email !== 'Not specified'
    && String(c.email).indexOf('@') > 0;
  return !!(hasName && (hasEmail || !noCompany));
}

function enrichContactsByWebSearch_(contacts) {
  var pending = [];
  for (var i = 0; i < contacts.length; i++) {
    if (contactNeedsWebEnrichment_(contacts[i])) pending.push(i);
    if (pending.length >= WEB_ENRICH_MAX_CONTACTS) break;
  }
  if (!pending.length) return;

  // Small batches keep each API call fast enough to fit several inside
  // the Apps Script execution limit; one failed batch never blocks the rest.
  for (var b = 0; b < pending.length; b += WEB_ENRICH_BATCH_SIZE) {
    var batch = pending.slice(b, b + WEB_ENRICH_BATCH_SIZE);
    try {
      enrichBatchByWebSearch_(contacts, batch);
    } catch (e) { /* non-fatal — this batch keeps its blanks */ }
  }
}

function enrichBatchByWebSearch_(contacts, indexes) {
  var payloadContacts = indexes.map(function (i) {
    var c = contacts[i];
    return {
      id: i,
      name: c.name === 'Not specified' ? '' : c.name,
      email: c.email === 'Not specified' ? '' : c.email,
      company: c.company === 'Not specified' ? '' : c.company,
      title: c.role === 'Not specified' ? '' : c.role
    };
  });

  var prompt =
    'You are an accuracy-obsessed SaaS marketing demand-generation expert ' +
    'enriching event-attendee records for a B2B go-to-market team.\n\n' +
    'Each contact below is missing one or more fields. Use the contact ' +
    'information provided (name, email domain, company) plus WEB SEARCH to ' +
    'fill in what is missing:\n' +
    '- company: if blank, identify the employer — a corporate email domain ' +
    'is usually the company\'s website domain; verify with a search\n' +
    '- title: if blank, find the person\'s current job title (LinkedIn, ' +
    'company team pages, conference speaker bios, press releases)\n' +
    '- icp_role: classify the VERIFIED title as EXACTLY one of:\n' +
    '  "Decision Maker" — C-level (CIO, CISO, CTO, CEO, CFO, COO, Chief*), ' +
    'President, Owner, Founder, Partner, VP/SVP/EVP — budget authority or ' +
    'final sign-off\n' +
    '  "Champion" — Director, Senior Director, Head of (team), Manager, ' +
    'Team Lead, Supervisor — internal owner/driver who needs sign-off\n' +
    '  "Influencer" — Engineer, Administrator, Analyst, Architect, ' +
    'Specialist, Coordinator, Consultant, and similar non-management roles\n' +
    '  "Unknown" — when no title could be verified\n' +
    '- seniority_tier: EXACTLY one of "C-Suite", "VP", "Director", ' +
    '"Manager", "Individual" — or an empty string when no title could be ' +
    'verified\n' +
    '- confidence: one of "high", "medium", "low"\n' +
    '- rationale: one short phrase naming the evidence (e.g. "LinkedIn ' +
    'profile matching name + email domain", "company site team page")\n\n' +
    'ACCURACY IS THE TOP PRIORITY — above completeness:\n' +
    '- Fill a field ONLY when a search result confirms it for THIS person ' +
    'or company specifically (the name AND the employer/email domain must ' +
    'match). A common name without a confirming employer match is NOT a ' +
    'match — return an empty string for that field instead of guessing.\n' +
    '- Never invent titles, companies, or profiles. An empty field is ' +
    'correct; a wrong field is a failure.\n' +
    '- Generic email domains (gmail.com, outlook.com, yahoo.com, etc.) do ' +
    'not identify a company.\n' +
    '- If search results are outdated or conflicting, prefer the most ' +
    'recent and lower the confidence accordingly.\n\n' +
    'When done searching, respond with strict JSON only — no prose, no ' +
    'markdown fences — in exactly this shape:\n' +
    '{"contacts": [{"id": <id exactly as given>, "company": "<found or ' +
    'empty>", "title": "<found or empty>", "icp_role": "<or empty>", ' +
    '"seniority_tier": "<or empty>", "confidence": "...", ' +
    '"rationale": "..."}]}\n\n' +
    'CONTACTS:\n' + JSON.stringify(payloadContacts);

  var parsed = parseJsonLoose_(callClaudeWithWebSearch_(prompt, 8000));
  if (!parsed || !Array.isArray(parsed.contacts)) return;

  parsed.contacts.forEach(function (r) {
    if (!r || typeof r.id !== 'number') return;
    if (indexes.indexOf(r.id) < 0) return; // only touch contacts we sent
    var c = contacts[r.id];
    var filled = false;
    if ((!c.company || c.company === 'Not specified') && r.company) {
      c.company = String(r.company);
      filled = true;
    }
    if ((!c.role || c.role === 'Not specified') && r.title) {
      c.role = String(r.title);
      filled = true;
    }
    if ((!c.icp_role || c.icp_role === 'Unknown') && r.icp_role && r.icp_role !== 'Unknown') {
      c.icp_role = String(r.icp_role);
      filled = true;
    }
    if (!c.seniority_tier && r.seniority_tier) {
      c.seniority_tier = String(r.seniority_tier);
      filled = true;
    }
    if (!filled) return;
    if (r.confidence) c.ai_confidence = String(r.confidence);
    if (r.rationale) {
      c.ai_rationale = (c.ai_rationale ? c.ai_rationale + ' · ' : '')
        + 'Web: ' + String(r.rationale);
    }
  });
}

// ── HTML output + chunking ─────────────────────────────────────────────

function buildAttendeeHtmlParts_(contacts, note) {
  var companies = {};
  var roleCounts = {};
  for (var i = 0; i < contacts.length; i++) {
    var c = contacts[i];
    if (c.company && c.company !== 'Not specified') companies[c.company] = true;
    if (c.role && c.role !== 'Not specified') {
      roleCounts[c.role] = (roleCounts[c.role] || 0) + 1;
    }
  }
  var topRoles = Object.keys(roleCounts)
    .sort(function (a, b) { return roleCounts[b] - roleCounts[a]; })
    .slice(0, 3)
    .map(function (r) { return attendeeEscapeHtml_(r) + ' (' + roleCounts[r] + ')'; });

  var summary = '<p><strong>' + contacts.length + ' contacts · '
    + Object.keys(companies).length + ' unique companies.</strong>'
    + (topRoles.length ? ' Top roles: ' + topRoles.join(', ') + '.' : '')
    + (note ? ' ' + attendeeEscapeHtml_(note) : '')
    + '</p>';

  var lines = contacts.map(function (c) {
    return attendeeEscapeHtml_(c.company) + ' — ' + attendeeEscapeHtml_(c.name)
      + ' — ' + attendeeEscapeHtml_(c.email) + ' — ' + attendeeEscapeHtml_(c.role);
  });

  // Chunk the line list into <p> blocks, keeping every part (including the
  // first, which also carries the summary) under the per-cell limit.
  var parts = [];
  var current = summary;
  var block = [];

  function flushBlock() {
    if (block.length) { current += '<p>' + block.join('<br>') + '</p>'; block = []; }
  }

  for (var i = 0; i < lines.length; i++) {
    var pending = block.join('<br>').length + lines[i].length + 16;
    if (current.length + pending > ATTENDEE_HTML_PART_LIMIT) {
      flushBlock();
      parts.push(current);
      current = '';
    }
    block.push(lines[i]);
    if (block.length >= 50) flushBlock();
  }
  flushBlock();
  if (current) parts.push(current);
  return parts.length ? parts : [summary];
}

function attendeeEscapeHtml_(str) {
  return String(str === undefined || str === null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
