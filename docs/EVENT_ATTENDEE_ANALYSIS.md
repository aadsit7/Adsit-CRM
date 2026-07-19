# Event attendee-list analysis — Apps Script update

The Events view now has an **Analyze** action on attached documents (mirroring
the one on Opportunities). For events, the portal sends an extra
`analysisType: 'attendee_list'` so the Apps Script can extract a structured
attendee list instead of a generic summary. The portal then:

- renders the returned HTML as dated description card(s) in the event modal, and
- writes **one structured row per contact** to the `Event_Contacts` tab of the
  spreadsheet (the portal does this write itself via the Sheets API — the Apps
  Script only returns the `contacts` array).

The Apps Script lives outside this repo, so the updated handler below must be
pasted in manually. It is **fully backward compatible**: when `analysisType`
is absent (the Opportunities flow), your existing handler runs exactly as
before.

## What the portal sends

```json
{
  "action": "analyzeDocument",
  "docId": "<Drive file id>",
  "driveUrl": "<Drive url>",
  "analysisType": "attendee_list",
  "entityType": "event",
  "eventTitle": "<the event's title>"
}
```

## What the portal expects back

```json
{
  "ok": true,
  "fileName": "attendees.xlsx",
  "html": "<single HTML block>",          // when it fits in one Sheets cell
  "htmlParts": ["<part 1>", "<part 2>"],  // instead of html, when it doesn't
  "contacts": [
    {
      "name": "Jane Doe",
      "company": "Acme Corp",
      "email": "jane@acme.com",
      "role": "Director of IT",
      "icp_role": "IT Operations",
      "seniority_tier": "Director",
      "ai_confidence": "high",
      "ai_rationale": "Title explicitly names IT and Director level"
    }
  ]
}
```

Google Sheets cells cap at 50,000 characters, so the HTML is chunked into
parts under ~40,000 characters each. One part → `html`; multiple parts →
`htmlParts` (the portal creates one description card per part, titled
"(part 2 of N)" etc.).

## Design: why the LLM never reproduces rows

For spreadsheet-type files (`.xlsx`, `.xlsm`, `.csv`) the script reads the
data **deterministically** in Apps Script and sends Claude only the header row
plus the first ~15 data rows, asking it to return a **column mapping** (which
column is company / name / email / title) in strict JSON. The full attendee
list is then built **in code from ALL rows** using that mapping. This stays
accurate for files with up to ~1,000 people and cannot hallucinate emails.

A second, optional Claude call classifies the **unique job titles** (not the
contacts — a 1,000-person list usually has far fewer distinct titles) into
`icp_role` / `seniority_tier`, which fills the AI columns of `Event_Contacts`.
If that call fails, contacts are still returned with those fields blank.

Only for unstructured documents (PDF, Word) does the script fall back to
sending extracted text to Claude with an extraction prompt.

## Step 1 — enable the Advanced Drive Service

The spreadsheet/PDF conversion uses the Drive API. In the Apps Script editor:
**Editor → Services (+) → Drive API → Add.** The code below assumes the
default **v3** service. (If your project has the old v2 service, replace
`{ name: ... }` with `{ title: ... }` in the two `Drive.Files.copy` calls.)

## Step 2 — add one branch to your existing `handleAnalyzeDocument`

Do **not** delete or modify your current analyze logic. Add this at the very
top of your existing `handleAnalyzeDocument(payload)` function (or whatever
your `analyzeDocument` action routes to):

```javascript
// NEW: attendee-list analysis for Events. When analysisType is absent,
// fall through to the existing behavior unchanged.
if (payload.analysisType === 'attendee_list') {
  return handleAnalyzeAttendeeList(payload);
}
```

## Step 3 — paste the new functions

Paste all of the following anywhere in the script (e.g. at the bottom):

```javascript
// ======================================================================
// Attendee-list analysis (Events)
// ======================================================================

var ATTENDEE_MAX_ROWS = 2000;        // hard cap on rows read from a sheet
var ATTENDEE_SAMPLE_ROWS = 15;       // data rows shown to Claude for mapping
var ATTENDEE_MAX_UNIQUE_TITLES = 300; // cap for the title-classification call
var ATTENDEE_HTML_PART_LIMIT = 40000; // stay under the 50k Sheets cell cap
var ATTENDEE_MAX_DOC_CHARS = 100000; // cap on extracted text for PDFs/Word

function handleAnalyzeAttendeeList(payload) {
  var file = DriveApp.getFileById(payload.docId);
  var fileName = file.getName();
  var lower = fileName.toLowerCase();

  var extraction;
  if (/\.(xlsx|xlsm|csv)$/.test(lower)) {
    extraction = extractContactsFromSpreadsheet_(file, lower);
  } else {
    extraction = extractContactsFromDocumentText_(file);
  }

  var contacts = extraction.contacts;

  // Optional enrichment: classify unique titles into ICP role / seniority.
  try {
    enrichContactsByTitle_(contacts);
  } catch (err) {
    // Enrichment is best-effort — contacts still return without it.
    console.warn('Title enrichment skipped: ' + err);
  }

  var parts = buildAttendeeHtmlParts_(contacts, extraction.note);

  var result = { ok: true, fileName: fileName, contacts: contacts };
  if (parts.length > 1) {
    result.htmlParts = parts;
  } else {
    result.html = parts[0] || '<p>No contacts found.</p>';
  }
  return result;
}

// ── Structured files: deterministic read + column-mapping call ─────────

function extractContactsFromSpreadsheet_(file, lowerName) {
  var rows = readSpreadsheetValues_(file, lowerName);
  if (rows.length < 2) {
    return { contacts: [], note: 'File contained no data rows.' };
  }

  var header = rows[0];
  var dataRows = rows.slice(1, 1 + ATTENDEE_MAX_ROWS);
  var sample = dataRows.slice(0, ATTENDEE_SAMPLE_ROWS);

  var mapping = requestColumnMapping_(header, sample);

  var contacts = [];
  for (var i = 0; i < dataRows.length; i++) {
    var row = dataRows[i];
    var name = pickCell_(row, mapping.contact_name);
    if (!name) {
      var first = pickCell_(row, mapping.first_name);
      var last = pickCell_(row, mapping.last_name);
      name = (first + ' ' + last).trim();
    }
    var company = pickCell_(row, mapping.company);
    var email = pickCell_(row, mapping.email);
    var role = pickCell_(row, mapping.role_title);
    // Skip fully-empty rows (common at the bottom of exports).
    if (!name && !company && !email && !role) continue;
    contacts.push({
      name: name || 'Not specified',
      company: company || 'Not specified',
      email: email || 'Not specified',
      role: role || 'Not specified',
      icp_role: '', seniority_tier: '', ai_confidence: '', ai_rationale: '',
    });
  }

  var note = mapping.data_quality_note || '';
  if (rows.length - 1 > ATTENDEE_MAX_ROWS) {
    note += (note ? ' ' : '') + 'Note: file truncated to first '
      + ATTENDEE_MAX_ROWS + ' rows.';
  }
  return { contacts: contacts, note: note };
}

function pickCell_(row, index) {
  if (index === null || index === undefined || index < 0) return '';
  var v = row[index];
  return (v === null || v === undefined) ? '' : String(v).trim();
}

function readSpreadsheetValues_(file, lowerName) {
  if (/\.csv$/.test(lowerName)) {
    var text = file.getBlob().getDataAsString('UTF-8');
    return Utilities.parseCsv(text);
  }
  // .xlsx / .xlsm — convert to a temporary Google Sheet via the Drive API,
  // read the first tab's values, then trash the temp copy.
  var converted = Drive.Files.copy(
    { name: file.getName() + ' (temp analyze copy)',
      mimeType: MimeType.GOOGLE_SHEETS },
    file.getId()
  );
  try {
    var ss = SpreadsheetApp.openById(converted.id);
    return ss.getSheets()[0].getDataRange().getValues();
  } finally {
    DriveApp.getFileById(converted.id).setTrashed(true);
  }
}

function requestColumnMapping_(header, sampleRows) {
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
    'SAMPLE ROWS:\n' + JSON.stringify(sampleRows);

  var mapping = parseJsonLoose_(callClaude_(prompt, 1024));
  if (!mapping || typeof mapping !== 'object') {
    throw new Error('Could not determine the column mapping for this file');
  }
  return mapping;
}

// ── Unstructured files (PDF / Word): extraction fallback ───────────────

function extractContactsFromDocumentText_(file) {
  var text = extractDocumentText_(file);
  if (!text) {
    return { contacts: [], note: 'No text could be extracted from this file.' };
  }
  if (text.length > ATTENDEE_MAX_DOC_CHARS) {
    text = text.slice(0, ATTENDEE_MAX_DOC_CHARS);
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

  var parsed = parseJsonLoose_(callClaude_(prompt, 16000));
  var contacts = (parsed && Array.isArray(parsed.contacts)) ? parsed.contacts : [];
  contacts = contacts.map(function (c) {
    return {
      name: String(c.name || 'Not specified'),
      company: String(c.company || 'Not specified'),
      email: String(c.email || 'Not specified'),
      role: String(c.role || 'Not specified'),
      icp_role: '', seniority_tier: '', ai_confidence: '', ai_rationale: '',
    };
  });
  return { contacts: contacts, note: (parsed && parsed.note) || '' };
}

function extractDocumentText_(file) {
  // Convert PDF/Word to a temporary Google Doc (OCR for PDFs), read the
  // text, then trash the temp copy.
  var converted = Drive.Files.copy(
    { name: file.getName() + ' (temp analyze copy)',
      mimeType: MimeType.GOOGLE_DOCS },
    file.getId()
  );
  try {
    return DocumentApp.openById(converted.id).getBody().getText();
  } finally {
    DriveApp.getFileById(converted.id).setTrashed(true);
  }
}

// ── Optional enrichment: classify unique titles ────────────────────────

function enrichContactsByTitle_(contacts) {
  var titles = {};
  contacts.forEach(function (c) {
    if (c.role && c.role !== 'Not specified') titles[c.role] = true;
  });
  var unique = Object.keys(titles).slice(0, ATTENDEE_MAX_UNIQUE_TITLES);
  if (unique.length === 0) return;

  var prompt =
    'Classify each job title below for a B2B IT-software CRM.\n\n' +
    'For each title return:\n' +
    '- icp_role: one of "IT Operations", "Endpoint Management", "Security", ' +
    '"Leadership", "Procurement", "Other"\n' +
    '- seniority_tier: one of "C-Level", "VP", "Director", "Manager", ' +
    '"Individual Contributor", "Unknown"\n' +
    '- confidence: one of "high", "medium", "low"\n' +
    '- rationale: one short phrase explaining the classification\n\n' +
    'Rules:\n' +
    '- Be concise. Classify only from the words in the title itself.\n' +
    '- Never guess beyond what the title says: when unclear, use "Other" / ' +
    '"Unknown" with confidence "low".\n' +
    '- Respond in strict JSON only — no prose, no markdown fences.\n\n' +
    'Respond with exactly this JSON shape:\n' +
    '{"titles": [{"title": "<title exactly as given>", "icp_role": "...", ' +
    '"seniority_tier": "...", "confidence": "...", "rationale": "..."}]}\n\n' +
    'TITLES:\n' + JSON.stringify(unique);

  var parsed = parseJsonLoose_(callClaude_(prompt, 16000));
  if (!parsed || !Array.isArray(parsed.titles)) return;

  var byTitle = {};
  parsed.titles.forEach(function (t) { if (t && t.title) byTitle[t.title] = t; });

  contacts.forEach(function (c) {
    var t = byTitle[c.role];
    if (!t) return;
    c.icp_role = String(t.icp_role || '');
    c.seniority_tier = String(t.seniority_tier || '');
    c.ai_confidence = String(t.confidence || '');
    c.ai_rationale = String(t.rationale || '');
  });
}

// ── HTML output + chunking ─────────────────────────────────────────────

function buildAttendeeHtmlParts_(contacts, note) {
  var companies = {};
  var roleCounts = {};
  contacts.forEach(function (c) {
    if (c.company && c.company !== 'Not specified') companies[c.company] = true;
    if (c.role && c.role !== 'Not specified') {
      roleCounts[c.role] = (roleCounts[c.role] || 0) + 1;
    }
  });
  var topRoles = Object.keys(roleCounts)
    .sort(function (a, b) { return roleCounts[b] - roleCounts[a]; })
    .slice(0, 3)
    .map(function (r) { return escapeHtmlAS_(r) + ' (' + roleCounts[r] + ')'; });

  var summary = '<p><strong>' + contacts.length + ' contacts · '
    + Object.keys(companies).length + ' unique companies.</strong>'
    + (topRoles.length ? ' Top roles: ' + topRoles.join(', ') + '.' : '')
    + (note ? ' ' + escapeHtmlAS_(note) : '')
    + '</p>';

  var lines = contacts.map(function (c) {
    return escapeHtmlAS_(c.company) + ' — ' + escapeHtmlAS_(c.name)
      + ' — ' + escapeHtmlAS_(c.email) + ' — ' + escapeHtmlAS_(c.role);
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

function escapeHtmlAS_(str) {
  return String(str === undefined || str === null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Claude API helpers ─────────────────────────────────────────────────

function callClaude_(prompt, maxTokens) {
  var key = PropertiesService.getScriptProperties()
    .getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY Script Property is not set');

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: maxTokens || 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
    muteHttpExceptions: true,
  });

  var code = res.getResponseCode();
  var body = JSON.parse(res.getContentText());
  if (code !== 200) {
    throw new Error('Claude API error ' + code + ': '
      + (body.error ? body.error.message : res.getContentText()));
  }
  if (body.stop_reason === 'refusal') {
    throw new Error('Claude declined to analyze this document');
  }
  var text = '';
  (body.content || []).forEach(function (b) {
    if (b.type === 'text') text += b.text;
  });
  return text;
}

// Tolerant JSON parse: strips markdown fences and leading/trailing prose
// if the model ever wraps its answer despite the strict-JSON instruction.
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
```

Notes on the code:

- The model is `claude-opus-4-8`. Do not add `temperature` / `top_p` — the
  Opus 4.7+ API rejects them.
- The two conversion helpers create temporary Drive copies and always trash
  them in a `finally` block.
- The `Event_Contacts` tab must already exist in the portal spreadsheet with
  this header (it does): `event_id, event_title, contact_id, name, title,
  company, email, owner, status, icp_role, seniority_tier, ai_confidence,
  ai_rationale, source_file, saved_at`. The Apps Script never writes to it —
  the portal appends the rows itself from the returned `contacts` array.
- The ICP role and seniority lists in `enrichContactsByTitle_` are just
  prompt text — edit them to match your own ICP definitions.

## Step 4 — redeploy

**Deploy → Manage deployments → Edit (pencil) → Version: New version →
Deploy.** The web app URL stays the same, so no config change is needed in
the portal. Open an event in the portal, attach an `.xlsx`/`.csv` attendee
list, and click **Analyze** — you should get a summary card (or several
"part N of M" cards) in the event's descriptions plus one row per contact in
`Event_Contacts`.
