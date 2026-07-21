/**
 * Partner Portal — Event Workspace backend (Google Apps Script web app)
 * ---------------------------------------------------------------------
 * ⚠️ REFERENCE COPY — this file lives in the repo for versioning only.
 * The live script runs in Google Apps Script (script.google.com), NOT from
 * this repo. To ship a change: edit here, paste the WHOLE file over the
 * Apps Script project's code, then redeploy:
 *   Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy
 *   - Execute as:      Me
 *   - Who has access:  Anyone            <-- REQUIRED so the browser page can call it
 *
 * Actions served:
 *   Portal + playbook shared:
 *     uploadFile / listFiles / deleteFile / analyzeDocument /
 *     updateDescription / getConfig
 *   Playbook (Event Workspace):
 *     categorizeLeads / listEvents / openEvent / saveEventContacts /
 *     listEventContacts / savePlaybook / loadPlaybook / analyzePlaybookNotes
 *   Portal (event modal "Analyze" on attached documents):
 *     analyzeDocument with analysisType:'attendee_list' — extracts the
 *     attendee list deterministically, classifies titles with the SAME
 *     "Event Lead Categorizer" persona the playbook uses, and returns
 *     HTML card(s) + a structured contacts array. The portal writes the
 *     contact rows to Event_Contacts itself.
 */

var SHEET_ID = '18Yhe3Yiq9_eI7kBxtFOzdu6Pb0_VUx730TYjq1xPjzI';
var DRIVE_FOLDER_ID = '1Jl86IHpClRaIFqM-RUQn-gzcCqYV9XTA';
var ANTHROPIC_API_KEY = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');

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

    // Persist the per-event playbook state (7 stages × 3 activities) to the
    // Event_Playbook tab. Written by the standalone Event Workspace's
    // debounced save; read back by loadPlaybook and by the CRM Event Analyzer.
    if (payload.action === 'savePlaybook') {
      return doSavePlaybook(payload);
    }

    // Read one event's saved playbook state back as the keyed shape the
    // standalone's pbMergeSaved expects.
    if (payload.action === 'loadPlaybook') {
      return doLoadPlaybook(payload);
    }

    // AI pass: given this event's saved description notes, return which
    // playbook activities those notes show as ALREADY COMPLETED. Only ever
    // suggests checks — never unchecks.
    if (payload.action === 'analyzePlaybookNotes') {
      return doAnalyzePlaybookNotes(payload);
    }

    if (payload.action === 'getConfig') {
      return doGetConfig();
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
    anthropicApiKey: ANTHROPIC_API_KEY
  })).setMimeType(ContentService.MimeType.JSON);
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
  // Extract file ID from the Drive URL
  var fileId = extractFileId(driveUrl);
  if (!fileId) throw new Error('Could not extract file ID from URL: ' + driveUrl);

  var file = DriveApp.getFileById(fileId);
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
  // Handle various Google Drive URL formats
  var patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
    /open\?id=([a-zA-Z0-9_-]+)/
  ];
  for (var i = 0; i < patterns.length; i++) {
    var match = url.match(patterns[i]);
    if (match) return match[1];
  }
  return null;
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
// EVENT PLAYBOOK (Event Workspace 7-stage partner playbook)
// ------------------------------------------------------------
// The standalone Event Workspace persists each event's playbook state to the
// Event_Playbook tab and reads it back on open. One row per event:
//
//   event_id | event_title | stages_json | updated_at
//
// `stages_json` is the serialized playbook — a JSON array of
//   { key, gate, note, acts:[{ x, o, dt, d }] }
// exactly as the workspace's pbSerialize() produces it. Storing the whole
// board as one JSON cell (rather than a row per activity) keeps the tab small
// and makes the save an atomic upsert, mirroring how Event_Contacts is owned
// entirely by this backend. The CRM Event Analyzer reads the same tab via the
// authenticated Sheets client as an OPTIONAL evidence source.
// ============================================================
// ============================================================

var EVENT_PLAYBOOK_TAB = 'Event_Playbook';
var EVENT_PLAYBOOK_HEADERS = ['event_id', 'event_title', 'stages_json', 'updated_at'];

/**
 * getEventPlaybookSheet
 * Returns the Event_Playbook sheet, creating it with the header row on first
 * use. Missing columns on an older tab are appended so name-based indexing
 * always works.
 */
function getEventPlaybookSheet(ss) {
  var sheet = ss.getSheetByName(EVENT_PLAYBOOK_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(EVENT_PLAYBOOK_TAB);
    sheet.getRange(1, 1, 1, EVENT_PLAYBOOK_HEADERS.length).setValues([EVENT_PLAYBOOK_HEADERS]);
    return sheet;
  }
  var lastCol = Math.max(1, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var missing = EVENT_PLAYBOOK_HEADERS.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

/**
 * doSavePlaybook
 * Input payload: { action:'savePlaybook', eventKey, eventTitle,
 *                  stages:[{ key, gate, note, acts:[{ x, o, dt, d }] }] }
 *
 * Upsert-by-event: the event's existing Event_Playbook row is replaced with a
 * fresh one carrying the serialized board. Rows for OTHER events are left
 * untouched. A script lock guards the read-clear-rewrite so two saves can't
 * interleave. Output: { ok:true, event_id:<key> }
 */
function doSavePlaybook(payload) {
  var key = String(payload.eventKey == null ? '' : payload.eventKey).trim();
  if (!key) return jsonOut({ ok: false, code: 'bad_request', error: 'No event specified' });

  var stages = (payload.stages && payload.stages.length) ? payload.stages : [];
  var stagesJson = JSON.stringify(stages);
  // Safety cap: keep a single cell well under the 50k Sheets limit.
  if (stagesJson.length > 45000) {
    return jsonOut({ ok: false, code: 'too_large', error: 'Playbook state is too large to save' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = getEventPlaybookSheet(ss);
    var numCols = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0].map(function (h) { return String(h || '').trim(); });
    var idIdx = headers.indexOf('event_id');
    if (idIdx === -1) throw new Error('Event_Playbook is missing its event_id column');

    var map = {
      event_id: key,
      event_title: String(payload.eventTitle == null ? '' : payload.eventTitle),
      stages_json: stagesJson,
      updated_at: new Date().toISOString()
    };
    var freshRow = headers.map(function (h) {
      return Object.prototype.hasOwnProperty.call(map, h) ? map[h] : '';
    });

    // Find an existing row for this event and overwrite it in place; otherwise
    // append. Keeps every other event's row exactly where it was.
    var existingRow = -1;
    if (sheet.getLastRow() > 1) {
      var existing = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
      for (var i = 0; i < existing.length; i++) {
        if (String(existing[i][idIdx] == null ? '' : existing[i][idIdx]).trim() === key) { existingRow = i + 2; break; }
      }
    }
    if (existingRow > 0) {
      sheet.getRange(existingRow, 1, 1, numCols).setValues([freshRow]);
    } else {
      sheet.appendRow(freshRow);
    }

    return jsonOut({ ok: true, event_id: key });
  } finally {
    lock.releaseLock();
  }
}

/**
 * doLoadPlaybook
 * Input payload: { action:'loadPlaybook', eventKey }
 * Returns the saved board as the keyed shape the workspace's pbMergeSaved
 * expects: { ok:true, stages:{ <stageKey>:{ note, acts:[{ i, o, dt, d }] } } }.
 * Missing tab / no row → { ok:true, stages:{} } (never an error).
 */
function doLoadPlaybook(payload) {
  var key = String(payload.eventKey == null ? '' : payload.eventKey).trim();
  if (!key) return jsonOut({ ok: true, stages: {} });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(EVENT_PLAYBOOK_TAB);
  if (!sheet || sheet.getLastRow() < 2) return jsonOut({ ok: true, stages: {} });

  var numCols = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var idIdx = headers.indexOf('event_id');
  var jsonIdx = headers.indexOf('stages_json');
  if (idIdx === -1 || jsonIdx === -1) return jsonOut({ ok: true, stages: {} });

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][idIdx] == null ? '' : data[i][idIdx]).trim() !== key) continue;
    var arr = parseJsonLoose_(String(data[i][jsonIdx] == null ? '' : data[i][jsonIdx]));
    if (!arr || !arr.length) return jsonOut({ ok: true, stages: {} });
    var stages = {};
    for (var s = 0; s < arr.length; s++) {
      var st = arr[s] || {};
      var sk = String(st.key == null ? '' : st.key).trim();
      if (!sk) continue;
      var acts = (st.acts || []).map(function (a, j) {
        a = a || {};
        return { i: j, o: a.o || '', dt: String(a.dt || ''), d: !!a.d };
      });
      stages[sk] = { note: String(st.note || ''), acts: acts };
    }
    return jsonOut({ ok: true, stages: stages });
  }
  return jsonOut({ ok: true, stages: {} });
}

/**
 * doAnalyzePlaybookNotes
 * Input payload: { action:'analyzePlaybookNotes', eventKey,
 *                  stages:[{ key, name, acts:[{ i, x, d }] }] }
 *
 * Reads every saved Event_Descriptions note for the event, then asks Claude
 * which of the still-UNCHECKED activities those notes clearly show as ALREADY
 * COMPLETED — returning the evidencing note's date when it can. Accuracy-first:
 * it only ever suggests CHECKS, and only for activities a note genuinely
 * supports. Missing key / no notes / no API key → { ok:true, checks:[] }.
 *
 * Output: { ok:true, checks:[{ stage:<key>, i:<index>, date:'YYYY-MM-DD' }] }
 */
function doAnalyzePlaybookNotes(payload) {
  var key = String(payload.eventKey == null ? '' : payload.eventKey).trim();
  if (!key) return jsonOut({ ok: true, checks: [] });

  var stages = (payload.stages && payload.stages.length) ? payload.stages : [];
  if (!stages.length) return jsonOut({ ok: true, checks: [] });
  if (!ANTHROPIC_API_KEY) return jsonOut({ ok: true, checks: [] });

  var notes = readEventDescriptionNotes_(key);
  if (!notes.length) return jsonOut({ ok: true, checks: [] });

  // Only ask about activities that are not already checked — the analysis
  // never unchecks, so a checked activity needs no re-evaluation.
  var openActs = [];
  for (var i = 0; i < stages.length; i++) {
    var st = stages[i] || {};
    var acts = st.acts || [];
    for (var j = 0; j < acts.length; j++) {
      if (acts[j] && !acts[j].d) {
        openActs.push({ stage: String(st.key || ''), i: Number(acts[j].i != null ? acts[j].i : j), x: String(acts[j].x || '') });
      }
    }
  }
  if (!openActs.length) return jsonOut({ ok: true, checks: [] });

  var notesBlock = notes.map(function (n) {
    return '--- NOTE date: ' + (n.date || 'Undated') + ' ---\n' + n.text;
  }).join('\n\n');

  var actsBlock = openActs.map(function (a) {
    return '- stage "' + a.stage + '" activity ' + a.i + ': ' + a.x;
  }).join('\n');

  var prompt = 'You are auditing an EVENT execution playbook against the event\'s saved notes.\n\n'
    + 'GOLDEN RULE: only mark an activity complete when a specific sentence in the NOTES clearly shows it was DONE. '
    + 'Never infer completion from timing, the event date, or because other activities are done. When in doubt, leave it out.\n\n'
    + 'NOTES (the ONLY evidence — oldest first):\n\n' + notesBlock + '\n\n'
    + 'CANDIDATE ACTIVITIES (only these; each is currently unchecked):\n' + actsBlock + '\n\n'
    + 'Return ONLY a JSON array of the activities the notes show as ALREADY COMPLETED, each as '
    + '{"stage":"<stage key>","i":<activity index>,"date":"YYYY-MM-DD"} where date is the date of the note that '
    + 'evidences completion (omit or use "" if unknown). Return [] if none. No prose, no code fences.';

  var text = '';
  try {
    text = callClaudeText_(prompt, 2000, 'claude-opus-4-7');
  } catch (e) {
    return jsonOut({ ok: true, checks: [] }); // silent — checking stays manual until the next run
  }

  var parsed = parseJsonLoose_(text);
  if (!parsed || !parsed.length) return jsonOut({ ok: true, checks: [] });

  // Validate every suggestion against the candidate set — the model can only
  // check an activity we actually asked about, in a stage/index that exists.
  var allowed = {};
  openActs.forEach(function (a) { allowed[a.stage + '|' + a.i] = true; });
  var checks = [];
  for (var k = 0; k < parsed.length; k++) {
    var c = parsed[k] || {};
    var stage = String(c.stage == null ? '' : c.stage).trim();
    var idx = Number(c.i);
    if (isNaN(idx)) continue;
    if (!allowed[stage + '|' + idx]) continue;
    var date = String(c.date == null ? '' : c.date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = '';
    checks.push({ stage: stage, i: idx, date: date });
  }
  return jsonOut({ ok: true, checks: checks });
}

/**
 * readEventDescriptionNotes_
 * Reads the Event_Descriptions rows for one event, strips HTML to plain prose,
 * drops empties and sorts OLDEST FIRST. Returns [{ date, text }].
 */
function readEventDescriptionNotes_(eventKey) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Event_Descriptions');
  if (!sheet || sheet.getLastRow() < 2) return [];

  var numCols = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var idIdx = headers.indexOf('event_id');
  var textIdx = headers.indexOf('description_text');
  var dateIdx = headers.indexOf('description_date');
  var createdIdx = headers.indexOf('created_at');
  if (idIdx === -1 || textIdx === -1) return [];

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  var out = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][idIdx] == null ? '' : data[i][idIdx]).trim() !== eventKey) continue;
    var text = stripHtmlToText_(data[i][textIdx]);
    if (!text) continue;
    var date = '';
    if (dateIdx !== -1 && data[i][dateIdx]) date = normalizeDateCell_(data[i][dateIdx]);
    if (!date && createdIdx !== -1 && data[i][createdIdx]) date = normalizeDateCell_(data[i][createdIdx]);
    out.push({ date: date, text: text });
  }
  out.sort(function (a, b) {
    return (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0);
  });
  return out;
}

// A Sheets cell may hold a real Date or a text date; normalize to YYYY-MM-DD.
function normalizeDateCell_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd');
  }
  var s = String(v == null ? '' : v).trim();
  var m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : s;
}

// Minimal HTML → text for note prose (Quill markup) — mirrors the client's
// stripHtml so the model sees the same clean prose a human reads.
function stripHtmlToText_(html) {
  return String(html == null ? '' : html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

// ============================================================
// ============================================================
// ATTENDEE-LIST ANALYSIS (portal event modal "Analyze")
// Called via analyzeDocument + analysisType:'attendee_list'.
// Spreadsheets are read deterministically — Claude only maps which
// column is which, so names/emails can never be hallucinated. Job
// titles are classified with the SAME "Event Lead Categorizer"
// persona the playbook uses, so both flows write identical
// vocabulary into Event_Contacts. The portal itself writes the
// contact rows; this handler only returns them.
// ============================================================
// ============================================================

var ATTENDEE_MAX_ROWS = 2000;         // hard cap on data rows read from a file
var ATTENDEE_SAMPLE_ROWS = 15;        // data rows shown to Claude for mapping
var ATTENDEE_HTML_PART_LIMIT = 40000; // stay under the 50k Sheets cell cap
var ATTENDEE_MAX_DOC_CHARS = 60000;   // cap on extracted text for PDFs/Word
var ATTENDEE_TITLE_BATCH = 100;       // unique titles per classification call
var ATTENDEE_MAX_TITLE_BATCHES = 3;   // at most 300 unique titles classified

function doAnalyzeAttendeeList(payload) {
  var fileId = extractFileId(payload.driveUrl);
  if (!fileId) throw new Error('Could not extract file ID from URL: ' + payload.driveUrl);

  var file = DriveApp.getFileById(fileId);
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

function extractAttendeesFromSpreadsheet_(file, lowerName) {
  var rows;
  if (/\.csv$/.test(lowerName)) {
    rows = Utilities.parseCsv(file.getBlob().getDataAsString('UTF-8'));
  } else {
    // .xlsx / .xlsm — convert to a temporary Google Sheet, read the first
    // tab's values, then trash the temp copy (same pattern as the generic
    // analyze path).
    var tempSheet = Drive.Files.copy(
      { title: 'TEMP_ANALYZE_' + Date.now(), mimeType: 'application/vnd.google-apps.spreadsheet' },
      file.getId()
    );
    try {
      rows = SpreadsheetApp.openById(tempSheet.id).getSheets()[0].getDataRange().getValues();
    } finally {
      DriveApp.getFileById(tempSheet.id).setTrashed(true);
    }
  }

  if (!rows || rows.length < 2) {
    return { contacts: [], note: 'File contained no data rows.' };
  }

  var header = rows[0];
  var dataRows = rows.slice(1, 1 + ATTENDEE_MAX_ROWS);
  var sample = dataRows.slice(0, ATTENDEE_SAMPLE_ROWS);

  var prompt =
    'You are mapping spreadsheet columns for a CRM import. Below are the ' +
    'header row and the first few data rows of an event attendee spreadsheet.\n\n' +
    'Identify which column (by zero-based index) contains each of the ' +
    'following. Use null when no column matches.\n\n' +
    '- company: the attendee\'s company or organization\n' +
    '- contact_name: the attendee\'s full name in a single column\n' +
    '- first_name / last_name: separate name columns, if the sheet splits them ' +
    '(when a full-name column exists, prefer contact_name and set these to null)\n' +
    '- email: the attendee\'s email address\n' +
    '- role_title: the attendee\'s job title or role\n\n' +
    'Rules:\n' +
    '- Be concise. Base the mapping only on what is present in the data shown.\n' +
    '- Never guess or fabricate: if you are not confident a column matches, use null.\n' +
    '- Respond in strict JSON only — no prose, no markdown fences.\n\n' +
    'Respond with exactly this JSON shape:\n' +
    '{"company": <index|null>, "contact_name": <index|null>, ' +
    '"first_name": <index|null>, "last_name": <index|null>, ' +
    '"email": <index|null>, "role_title": <index|null>, ' +
    '"data_quality_note": "<one short sentence about data quality, or an empty string>"}\n\n' +
    'HEADER:\n' + JSON.stringify(header) + '\n\n' +
    'SAMPLE ROWS:\n' + JSON.stringify(sample);

  var mapping = parseJsonLoose_(callClaudeText_(prompt, 1024, 'claude-opus-4-8'));
  if (!mapping || typeof mapping !== 'object') {
    throw new Error('Could not determine the column mapping for this file');
  }

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

  var note = String(mapping.data_quality_note || '');
  if (rows.length - 1 > ATTENDEE_MAX_ROWS) {
    note += (note ? ' ' : '') + 'Note: file truncated to first ' + ATTENDEE_MAX_ROWS + ' rows.';
  }
  return { contacts: contacts, note: note };
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
