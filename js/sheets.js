// ============================================
// Google Sheets API Integration
// ============================================

import { CONFIG, getRuntimeConfig } from './config.js';
import { getAccessToken, getCurrentUser, clearAccessToken } from './auth.js';

/**
 * Get the effective Spreadsheet ID (runtime override or hardcoded).
 */
function getSpreadsheetId() {
  return getRuntimeConfig('SPREADSHEET_ID') || CONFIG.SPREADSHEET_ID;
}

/**
 * Get the effective API key (runtime override or hardcoded).
 */
function getApiKey() {
  return getRuntimeConfig('API_KEY') || CONFIG.API_KEY;
}

/**
 * Build the base URL for Sheets API calls.
 */
function getBaseUrl() {
  return `${CONFIG.SHEETS_BASE_URL}/${getSpreadsheetId()}`;
}

/**
 * Convert a 1-based column count to A1 notation (1→A, 26→Z, 27→AA, …).
 * Required because String.fromCharCode(64 + n) only works for n ≤ 26.
 */
function columnLetter(count) {
  let n = count;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

/**
 * Build the auth query parameter — use API key when no Bearer token is available.
 */
function getAuthParam() {
  const token = getAccessToken();
  if (token) return '';
  const apiKey = getApiKey();
  return (apiKey && apiKey !== 'YOUR_GOOGLE_API_KEY_HERE') ? `key=${apiKey}` : '';
}

/**
 * Check if Google Sheets is configured.
 * Requires a real Spreadsheet ID. API key is optional if OAuth token is available.
 */
export function isConfigured() {
  const spreadsheetId = getSpreadsheetId();
  if (!spreadsheetId || spreadsheetId === 'YOUR_SPREADSHEET_ID_HERE') return false;
  // Need either an API key or an OAuth token
  const apiKey = getApiKey();
  const token = getAccessToken();
  return !!token || (!!apiKey && apiKey !== 'YOUR_GOOGLE_API_KEY_HERE');
}

// ============================================
// Read cache (TTL + write-invalidation)
// ============================================
// The portal does the same readSheetAsObjects() round-trip many times
// per session: once on view render, again when an event/opp modal opens
// to refresh the linked-rollups, again when the user switches tabs and
// returns. Each one is a Google Sheets API hop costing 100-500ms.
//
// This in-memory cache short-circuits repeat reads inside a TTL window
// and de-dupes concurrent in-flight reads. Any write through this
// module's appendRow / updateRow / deleteRow (and demo equivalents)
// invalidates the affected sheet's cache entry, so the next reader
// re-fetches fresh data. Callers that need fresh-no-matter-what can
// pass `{ forceRefresh: true }` to readSheetAsObjects().

const SHEET_CACHE_TTL_MS = 30_000;
const _sheetCache = new Map();   // sheetName -> { ts, rows }
const _inflight = new Map();     // sheetName -> Promise<rows>

function getCachedRows(sheetName) {
  const entry = _sheetCache.get(sheetName);
  if (!entry) return null;
  if (Date.now() - entry.ts > SHEET_CACHE_TTL_MS) return null;
  return entry.rows;
}

function setCachedRows(sheetName, rows) {
  _sheetCache.set(sheetName, { ts: Date.now(), rows });
}

/**
 * Drop one or all sheet cache entries. Called automatically after writes;
 * exported so callers can force a refresh after batch operations.
 */
export function invalidateSheetCache(sheetName) {
  if (sheetName) {
    _sheetCache.delete(sheetName);
  } else {
    _sheetCache.clear();
  }
}

/**
 * Try to refresh the OAuth token via the GIS popup client. Works on desktop
 * browsers (third-party cookie path); on iPhone it always resolves null —
 * WebKit blocks it — and renewal happens via the silent full-page redirect
 * on the next cold load instead (see auth.js attemptSilentReauth and the
 * DOMContentLoaded handler in app.js). Returns the new token or null; never
 * throws.
 */
async function tryPopupTokenRefresh() {
  try {
    const { refreshAccessToken } = await import('./views/login.js');
    return await refreshAccessToken();
  } catch {
    return null;
  }
}

/**
 * Read all rows from a sheet.
 * Returns array of row arrays (first row = headers).
 */
export async function readSheet(sheetName) {
  if (!isConfigured()) return getDemoData(sheetName);

  const base = getBaseUrl();
  const valuesUrl = (auth) => `${base}/values/${encodeURIComponent(sheetName)}${auth ? '?' + auth : ''}`;
  const token = getAccessToken();
  const url = valuesUrl(getAuthParam());
  const res = await fetch(url, token ? { headers: { 'Authorization': `Bearer ${token}` } } : undefined);

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      // 1. Try a popup token refresh then retry the request once.
      try {
        const newToken = await tryPopupTokenRefresh();
        if (newToken) {
          const retryRes = await fetch(url, { headers: { 'Authorization': `Bearer ${newToken}` } });
          if (retryRes.ok) {
            const retryData = await retryRes.json();
            return retryData.values || [];
          }
        }
      } catch {}
      if (getCurrentUser()?.is_admin) {
        // 2. The Bearer token itself was rejected (revoked / expired early).
        // Drop it and retry this read with the plain API key: the admin
        // keeps a fully working read view while the next app-open or
        // tab-return renews the token via the silent redirect. Only if even
        // the key-based read fails do we surface an error — swallowing it
        // into demo data would mask the real problem.
        if (token) {
          clearAccessToken();
          const keyParam = getAuthParam(); // token gone → falls back to API key
          if (keyParam) {
            try {
              const keyRes = await fetch(valuesUrl(keyParam));
              if (keyRes.ok) {
                const keyData = await keyRes.json();
                return keyData.values || [];
              }
            } catch {}
          }
        }
        const err = await res.clone().json().catch(() => ({}));
        throw new Error(err.error?.message
          || `Sheets API auth failed (${res.status}). Please refresh the page or sign in again.`);
      }
      console.warn(`Sheets API auth failed (${res.status}), using demo data for ${sheetName}`);
      return getDemoData(sheetName);
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Failed to read ${sheetName}`);
  }

  const data = await res.json();
  return data.values || [];
}

function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((row, idx) => {
    const obj = { _rowIndex: idx + 2 }; // 1-indexed, skip header
    headers.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    return obj;
  });
}

/**
 * Read rows and parse into objects using header row.
 *
 * Results are cached for SHEET_CACHE_TTL_MS and shared across concurrent
 * callers. Pass { forceRefresh: true } to bypass the cache (e.g. after a
 * write the caller already knows about, or for cross-window freshness).
 *
 * Returns a fresh top-level array on every call so callers can sort/splice
 * without polluting the cache; the row objects themselves are shared
 * references — treat as read-only or shallow-clone before mutating.
 */
export async function readSheetAsObjects(sheetName, options = {}) {
  const { forceRefresh = false } = options;

  if (!forceRefresh) {
    const cached = getCachedRows(sheetName);
    if (cached) return cached.slice();

    // Coalesce concurrent reads of the same sheet into a single network hop.
    const pending = _inflight.get(sheetName);
    if (pending) {
      const rows = await pending;
      return rows.slice();
    }
  }

  const promise = (async () => {
    const raw = await readSheet(sheetName);
    const objects = rowsToObjects(raw);
    setCachedRows(sheetName, objects);
    return objects;
  })();

  _inflight.set(sheetName, promise);
  try {
    const rows = await promise;
    return rows.slice();
  } finally {
    _inflight.delete(sheetName);
  }
}

/**
 * Build write headers for a specific token (or none).
 */
function writeHeaders(token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/**
 * Run a Sheets write; on 401/403 refresh the token once (popup path) and
 * retry. Returns the final Response — ok or not — for the caller to handle.
 */
async function writeWithAuthRetry(doFetch) {
  let res = await doFetch(getAccessToken());
  if (!res.ok && (res.status === 401 || res.status === 403) && getCurrentUser()?.is_admin) {
    const fresh = await tryPopupTokenRefresh();
    if (fresh) res = await doFetch(fresh);
  }
  return res;
}

/**
 * Turn a failed write into a helpful error. A 401 on an admin session means
 * the Google token died mid-session and could not be renewed in-place: drop
 * it (reads then fall back to the API key) and explain the recovery, instead
 * of surfacing Google's raw "invalid credentials" text. A 403 is a real
 * permissions problem (account can't edit the spreadsheet / missing scope) —
 * reloading won't fix that, so say what's actually wrong.
 */
async function throwWriteError(res, fallbackMessage) {
  const err = await res.json().catch(() => ({}));
  if (getCurrentUser()?.is_admin) {
    if (res.status === 401) {
      clearAccessToken();
      throw new Error('Your Google sign-in needs a refresh, so this change was NOT saved. '
        + 'Reload the page — it reconnects automatically — then try again. '
        + 'If it still fails, log out and sign in with Google again.');
    }
    if (res.status === 403) {
      throw new Error(err.error?.message
        || 'Google denied access to the spreadsheet — check that your account can edit it.');
    }
  }
  throw new Error(err.error?.message || fallbackMessage);
}

/**
 * Append a row to a sheet.
 */
export async function appendRow(sheetName, values) {
  if (!isConfigured()) {
    addDemoRow(sheetName, values);
    return { updates: { updatedRows: 1 } };
  }

  const base = getBaseUrl();
  const authParam = getAuthParam();
  const url = `${base}/values/${encodeURIComponent(sheetName)}:append`
    + `?valueInputOption=USER_ENTERED${authParam ? '&' + authParam : ''}`;

  const res = await writeWithAuthRetry((token) => fetch(url, {
    method: 'POST',
    headers: writeHeaders(token),
    body: JSON.stringify({ values: [values] }),
  }));

  if (!res.ok) await throwWriteError(res, `Failed to append to ${sheetName}`);

  invalidateSheetCache(sheetName);
  return res.json();
}

/**
 * Update a specific row.
 * @param {string} sheetName
 * @param {number} rowIndex - 1-based row number
 * @param {Array} values
 */
export async function updateRow(sheetName, rowIndex, values) {
  if (!isConfigured()) {
    updateDemoRow(sheetName, rowIndex, values);
    return {};
  }

  const base = getBaseUrl();
  const range = `${sheetName}!A${rowIndex}:${columnLetter(values.length)}${rowIndex}`;
  const authParam = getAuthParam();
  const url = `${base}/values/${encodeURIComponent(range)}`
    + `?valueInputOption=USER_ENTERED${authParam ? '&' + authParam : ''}`;

  const res = await writeWithAuthRetry((token) => fetch(url, {
    method: 'PUT',
    headers: writeHeaders(token),
    body: JSON.stringify({ values: [values] }),
  }));

  if (!res.ok) await throwWriteError(res, `Failed to update ${sheetName}`);

  invalidateSheetCache(sheetName);
  return res.json();
}

/**
 * Delete a row by index.
 * Requires knowing the numeric sheet ID (gid).
 */
export async function deleteRow(sheetName, rowIndex) {
  if (!isConfigured()) {
    deleteDemoRow(sheetName, rowIndex);
    return {};
  }

  const base = getBaseUrl();
  const authParam = getAuthParam();

  // First, get the sheet's numeric gid
  const metaUrl = `${base}?fields=sheets.properties${authParam ? '&' + authParam : ''}`;
  const metaRes = await writeWithAuthRetry((token) => fetch(
    metaUrl,
    token ? { headers: { 'Authorization': `Bearer ${token}` } } : undefined,
  ));
  if (!metaRes.ok) await throwWriteError(metaRes, `Failed to read spreadsheet metadata`);
  const meta = await metaRes.json();
  const sheet = meta.sheets?.find(s => s.properties.title === sheetName);

  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  const sheetId = sheet.properties.sheetId;
  const url = `${base}:batchUpdate${authParam ? '?' + authParam : ''}`;

  const res = await writeWithAuthRetry((token) => fetch(url, {
    method: 'POST',
    headers: writeHeaders(token),
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex - 1, // 0-based
            endIndex: rowIndex,
          }
        }
      }]
    }),
  }));

  if (!res.ok) await throwWriteError(res, `Failed to delete from ${sheetName}`);

  invalidateSheetCache(sheetName);
  return res.json();
}

// ============================================
// Sheet Initialization & Seeding
// ============================================

const SHEET_HEADERS = {
  [CONFIG.SHEET_PARTNERS]: ['partner_id', 'username', 'display_name', 'partner_type', 'tier', 'region', 'created_at', 'is_admin', 'password_hash', 'status', 'hq_location'],
  [CONFIG.SHEET_OPPORTUNITIES]: ['opportunity_id', 'partner_id', 'deal_name', 'customer_name', 'deal_value', 'status', 'stage', 'expected_close', 'description', 'created_at', 'updated_at', 'notes', 'lead_source'],
  [CONFIG.SHEET_EVENTS]: ['event_id', 'title', 'description', 'event_date', 'end_date', 'event_type', 'location', 'url', 'created_by', 'created_at', 'status', 'partner_id', 'checklist', 'lead_count'],
  [CONFIG.SHEET_TRANSCRIPTS]: ['transcript_id', 'partner_id', 'partner_name', 'conversation_date', 'transcript_text', 'created_at'],
  [CONFIG.SHEET_OPP_DESCRIPTIONS]: ['description_id', 'opportunity_id', 'deal_name', 'description_date', 'description_text', 'created_at', 'category'],
  [CONFIG.SHEET_EVENT_DESCRIPTIONS]: ['description_id', 'event_id', 'title', 'description_date', 'description_text', 'created_at'],
  [CONFIG.SHEET_PARTNER_DOCUMENTS]: ['document_id', 'partner_id', 'partner_name', 'title', 'doc_type', 'html_content', 'status', 'created_at', 'updated_at'],
  [CONFIG.SHEET_CUSTOM_PROMPTS]: ['prompt_id', 'label', 'icon', 'instructions', 'created_at'],
  [CONFIG.SHEET_AI_CONVERSATIONS]: ['conversation_id', 'username', 'started_at', 'title', 'messages', 'status'],
  [CONFIG.SHEET_MEETING_INDEX]: ['meeting_id', 'transcript_id', 'partner_id', 'partner_name', 'meeting_date', 'meeting_title', 'attendees', 'summary', 'key_decisions', 'topics_discussed'],
};

/**
 * Initialize the Google Sheet with the 3 required tabs and header rows.
 * Requires an OAuth token (admin must be logged in).
 */
export async function initializeSheet() {
  const base = getBaseUrl();
  const token = getAccessToken();
  if (!token) throw new Error('OAuth token required — please log in with Google SSO first.');

  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  // 1. Get existing sheet metadata
  const metaRes = await fetch(`${base}?fields=sheets.properties`, { headers });
  if (!metaRes.ok) {
    const err = await metaRes.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Failed to read spreadsheet metadata');
  }
  const meta = await metaRes.json();
  const existingSheets = meta.sheets?.map(s => s.properties.title) || [];

  // 2. Build batchUpdate requests to add missing tabs
  const requests = [];
  const tabsToCreate = [CONFIG.SHEET_PARTNERS, CONFIG.SHEET_OPPORTUNITIES, CONFIG.SHEET_EVENTS, CONFIG.SHEET_TRANSCRIPTS, CONFIG.SHEET_OPP_DESCRIPTIONS, CONFIG.SHEET_EVENT_DESCRIPTIONS, CONFIG.SHEET_PARTNER_DOCUMENTS, CONFIG.SHEET_CUSTOM_PROMPTS, CONFIG.SHEET_AI_CONVERSATIONS, CONFIG.SHEET_MEETING_INDEX];

  for (const tabName of tabsToCreate) {
    if (!existingSheets.includes(tabName)) {
      requests.push({ addSheet: { properties: { title: tabName } } });
    }
  }

  if (requests.length > 0) {
    const batchRes = await fetch(`${base}:batchUpdate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requests }),
    });
    if (!batchRes.ok) {
      const err = await batchRes.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Failed to create sheet tabs');
    }
  }

  // 3. Always overwrite header rows to keep them in sync with code schema
  for (const tabName of tabsToCreate) {
    const headerRow = SHEET_HEADERS[tabName];
    const writeUrl = `${base}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=RAW`;
    await fetch(writeUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ values: [headerRow] }),
    });
  }

  return { success: true, tabsCreated: requests.length };
}

/**
 * Sync header rows in all tabs to match current code schema.
 * Overwrites row 1 in each tab. Does NOT affect data rows.
 */
export async function syncHeaders() {
  const base = getBaseUrl();
  const token = getAccessToken();
  if (!token) throw new Error('OAuth token required — please log in with Google SSO first.');

  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  const tabs = [CONFIG.SHEET_PARTNERS, CONFIG.SHEET_OPPORTUNITIES, CONFIG.SHEET_EVENTS, CONFIG.SHEET_TRANSCRIPTS, CONFIG.SHEET_OPP_DESCRIPTIONS, CONFIG.SHEET_EVENT_DESCRIPTIONS, CONFIG.SHEET_PARTNER_DOCUMENTS, CONFIG.SHEET_CUSTOM_PROMPTS, CONFIG.SHEET_AI_CONVERSATIONS, CONFIG.SHEET_MEETING_INDEX];

  for (const tabName of tabs) {
    const headerRow = SHEET_HEADERS[tabName];
    const url = `${base}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=RAW`;
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ values: [headerRow] }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Failed to sync headers for ${tabName}`);
    }
  }

  return { success: true };
}

/**
 * Seed the Google Sheet with demo data.
 * Appends demo rows to each tab (does NOT clear existing data).
 */
export async function seedSheetData() {
  const token = getAccessToken();
  if (!token) throw new Error('OAuth token required — please log in with Google SSO first.');

  const base = getBaseUrl();
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  // Skip header row (index 0) from demo arrays — headers are already written by initializeSheet
  const datasets = [
    { sheet: CONFIG.SHEET_PARTNERS, rows: demoPartners.slice(1) },
    { sheet: CONFIG.SHEET_OPPORTUNITIES, rows: demoOpportunities.slice(1) },
    { sheet: CONFIG.SHEET_EVENTS, rows: demoEvents.slice(1) },
    { sheet: CONFIG.SHEET_TRANSCRIPTS, rows: demoTranscripts.slice(1) },
  ];

  for (const { sheet, rows } of datasets) {
    if (rows.length === 0) continue;
    const url = `${base}/values/${encodeURIComponent(sheet)}:append?valueInputOption=USER_ENTERED`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ values: rows }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Failed to seed ${sheet}`);
    }
    invalidateSheetCache(sheet);
  }

  return { success: true };
}

// ============================================
// Custom Prompts (AI Assistant Presets)
// ============================================

export async function loadCustomPrompts() {
  try {
    return await readSheetAsObjects(CONFIG.SHEET_CUSTOM_PROMPTS);
  } catch {
    return [];
  }
}

export async function saveCustomPrompt(promptId, label, icon, instructions, rowIndex) {
  const now = new Date().toISOString();
  const id = promptId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `p_${Date.now()}`);
  const row = [id, label, icon, instructions, now];
  if (rowIndex) {
    return updateRow(CONFIG.SHEET_CUSTOM_PROMPTS, rowIndex, row);
  }
  return appendRow(CONFIG.SHEET_CUSTOM_PROMPTS, row);
}

export async function deleteCustomPrompt(rowIndex) {
  return deleteRow(CONFIG.SHEET_CUSTOM_PROMPTS, rowIndex);
}

export async function saveReorderedPrompts(orderedPresets) {
  for (let i = 0; i < orderedPresets.length; i++) {
    const p = orderedPresets[i];
    const row = [p.prompt_id, p.label, p.icon, p.instructions, p.created_at];
    await updateRow(CONFIG.SHEET_CUSTOM_PROMPTS, i + 2, row);
  }
}

/**
 * Test the connection by reading spreadsheet metadata.
 */
export async function testConnection() {
  const base = getBaseUrl();
  const token = getAccessToken();
  const apiKey = getApiKey();

  let url = `${base}?fields=sheets.properties`;
  const opts = {};
  if (token) {
    opts.headers = { 'Authorization': `Bearer ${token}` };
  } else if (apiKey && apiKey !== 'YOUR_GOOGLE_API_KEY_HERE') {
    url += `&key=${apiKey}`;
  } else {
    throw new Error('No authentication available. Log in with Google SSO or set an API key.');
  }

  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Connection failed');
  }

  const data = await res.json();
  const tabs = data.sheets?.map(s => s.properties.title) || [];
  return { connected: true, tabs };
}


// ============================================
// Demo data for when Google Sheets isn't configured
// ============================================

let demoPartners = [
  ['partner_id', 'username', 'display_name', 'partner_type', 'tier', 'region', 'created_at', 'is_admin', 'password_hash', 'status', 'hq_location'],
  ['p_admin001', 'admin', 'Portal Admin', '', '', 'Global', '2026-01-01', 'TRUE', '', 'active', ''],
  ['p_elant1', 'elantis', 'Elantis', 'MSP/SI', 'Value/Preferred', 'North America', '2026-01-10', 'FALSE', '', 'active', 'Edmonton, Alberta, Canada'],
  ['p_getrb1', 'getrubix', 'GetRubix', 'MSP/SI', 'Value/Preferred', 'North America', '2026-01-15', 'FALSE', '', 'active', 'New Jersey, USA'],
  ['p_infos1', 'infosys', 'InfoSys', 'MSP/SI', 'Premier/Strategic', 'North America', '2026-01-20', 'FALSE', '', 'active', 'Bengaluru, India'],
  ['p_insigh1', 'insight', 'Insight', 'MSP/SI', 'Premier/Strategic', 'North America', '2026-02-10', 'FALSE', '', 'active', 'Chandler, Arizona, USA'],
  ['p_micro1', 'microsoft', 'Microsoft', 'OEM', 'Premier/Strategic', 'North America', '2026-02-15', 'FALSE', '', 'active', 'Redmond, Washington, USA'],
  ['p_nerdio1', 'nerdio', 'Nerdio', 'Technology', 'Premier/Strategic', 'North America', '2026-01-15', 'FALSE', '', 'active', 'Chicago, Illinois, USA'],
  ['p_qualc01', 'qualcomm', 'Qualcomm', 'Technology', 'Premier/Strategic', 'North America', '2026-03-10', 'FALSE', '', 'active', 'San Diego, California, USA'],
  ['p_ridgep1', 'ridgepoint', 'RidgePoint', 'MENA Regional Distributor', 'Value/Preferred', 'MENA', '2026-02-01', 'FALSE', '', 'active', 'Dubai, UAE'],
  ['p_syscd01', 'systemcenterdudes', 'System Center Dudes', 'MSP/SI', 'Value/Preferred', 'North America', '2026-02-20', 'FALSE', '', 'active', 'Montreal, Quebec, Canada'],
  ['p_acme01', 'acmecorp', 'Acme Corp', 'MSP/SI', 'Registered', 'North America', '2026-03-15', 'FALSE', '', 'active', 'Austin, Texas, USA'],
];

let demoOpportunities = [
  ['opportunity_id', 'partner_id', 'deal_name', 'customer_name', 'deal_value', 'status', 'stage', 'expected_close', 'description', 'created_at', 'updated_at', 'notes', 'lead_source'],
  ['opp_001', 'p_nerdio1', 'Azure Virtual Desktop Rollout', 'TechCorp Industries', '150000', 'In Progress', 'Proposal', '2026-06-15', 'AVD deployment for 500-seat enterprise', '2026-03-01', '2026-04-01', JSON.stringify([{date:'2026-04-01T10:30:00',text:'Submitted proposal to TechCorp. They want to start Phase 1 by end of Q2.'},{date:'2026-03-20T14:00:00',text:'Technical deep-dive with customer IT team. They have 500 seats across 3 offices.'},{date:'2026-03-01T09:00:00',text:'Initial discovery call. Customer interested in AVD for remote workforce.'}]), 'evt_002'],
  ['opp_002', 'p_nerdio1', 'Cloud Desktop Optimization', 'Metro Health Systems', '85000', 'Registered', 'Qualified', '2026-07-30', 'Cloud desktop optimization for healthcare provider', '2026-03-15', '2026-03-15', JSON.stringify([{date:'2026-03-15T11:00:00',text:'Registered deal. Healthcare provider looking to optimize cloud desktop costs.'}]), 'salesperson'],
  ['opp_003', 'p_ridgep1', 'Managed Services Engagement', 'Global Retail Co', '200000', 'In Progress', 'Negotiation', '2026-05-20', 'Full managed services for 200 retail locations', '2026-02-10', '2026-03-28', JSON.stringify([{date:'2026-03-28T16:00:00',text:'Pricing negotiation in progress. Customer wants to start with 50 locations pilot.'},{date:'2026-03-10T09:30:00',text:'SOW review meeting completed. Customer approved scope of work.'},{date:'2026-02-10T10:00:00',text:'Kicked off engagement discussion with Global Retail Co leadership team.'}]), 'evt_004'],
  ['opp_004', 'p_ridgep1', 'Network Infrastructure Refresh', 'EuroBank AG', '120000', 'Won', 'Closed', '2026-03-15', 'Complete network infrastructure refresh', '2026-01-20', '2026-03-15', JSON.stringify([{date:'2026-03-15T15:00:00',text:'Deal closed! PO received. Implementation starts April 1.'},{date:'2026-02-20T10:00:00',text:'Final presentation to CTO. Positive feedback received.'}]), 'salesperson'],
  ['opp_005', 'p_insigh1', 'Digital Workspace Transformation', 'Contoso Ltd', '275000', 'In Progress', 'Proposal', '2026-08-01', 'End-to-end digital workspace transformation', '2026-03-01', '2026-04-01', JSON.stringify([{date:'2026-04-01T13:00:00',text:'Proposal submitted. Awaiting feedback from Contoso procurement team.'},{date:'2026-03-15T11:00:00',text:'Requirements workshop completed with Contoso IT leadership.'}]), 'evt_005'],
  ['opp_006', 'p_insigh1', 'Hybrid Cloud Migration', 'Woodgrove Bank', '180000', 'Registered', 'Qualified', '2026-09-15', 'Hybrid cloud migration for financial services', '2026-03-20', '2026-03-20', '', 'salesperson'],
  ['opp_007', 'p_syscd01', 'SCCM to Intune Migration', 'Fabrikam Inc', '95000', 'In Progress', 'Negotiation', '2026-07-01', 'Migrate 10K endpoints from SCCM to Intune', '2026-02-15', '2026-03-28', JSON.stringify([{date:'2026-03-28T14:30:00',text:'Contract terms finalized. Legal review in progress on both sides.'},{date:'2026-03-01T10:00:00',text:'POC completed successfully. Customer moving forward with full migration.'}]), 'evt_006'],
  ['opp_008', 'p_getrb1', 'DevOps Pipeline Modernization', 'Northwind Traders', '110000', 'Registered', 'Prospect', '2026-08-15', 'CI/CD pipeline modernization with GitHub Actions', '2026-04-01', '2026-04-01', '', 'salesperson'],
  ['opp_009', 'p_qualc01', 'Edge Computing Platform', 'Adventure Works', '320000', 'In Progress', 'Proposal', '2026-09-30', 'Edge computing solution for manufacturing IoT', '2026-02-15', '2026-03-20', JSON.stringify([{date:'2026-03-20T09:00:00',text:'Revised proposal sent with updated pricing for 5 manufacturing sites.'},{date:'2026-03-05T15:00:00',text:'Site visit to Adventure Works main factory. Identified 5 deployment locations.'}]), 'evt_007'],
  ['opp_010', 'p_qualc01', 'AI Accelerator Deployment', 'Tailspin Toys', '75000', 'Won', 'Closed', '2026-03-01', 'AI inference accelerator deployment', '2026-01-10', '2026-03-01', JSON.stringify([{date:'2026-03-01T12:00:00',text:'Deal closed. Hardware shipped. On-site installation scheduled for March 15.'},{date:'2026-02-15T10:00:00',text:'Demo completed. Customer impressed with inference performance benchmarks.'}]), 'salesperson'],
  ['opp_011', 'p_nerdio1', 'Cost Optimization Assessment', 'Sunrise Media', '60000', 'Lost', 'Closed', '2026-02-28', 'Cloud cost optimization assessment', '2025-12-01', '2026-02-28', JSON.stringify([{date:'2026-02-28T11:00:00',text:'Lost to competitor. Customer went with a lower-cost alternative.'},{date:'2026-01-15T14:00:00',text:'Assessment findings presented. Identified $40K in annual savings potential.'}]), 'evt_001'],
];

let demoEvents = [
  ['event_id', 'title', 'description', 'event_date', 'end_date', 'event_type', 'location', 'url', 'created_by', 'created_at', 'status', 'partner_id', 'checklist', 'lead_count'],
  ['evt_001', 'Q2 Partner Kickoff Webinar', 'Quarterly partner kickoff covering new products, incentive programs, and roadmap updates.', '2026-04-10', '2026-04-10', 'Webinar', 'Virtual (Zoom)', 'https://zoom.us/example', 'p_admin001', '2026-03-01', 'Upcoming', '', JSON.stringify([{text:"Confirm speakers",done:true},{text:"Create registration page",done:true},{text:"Send invitations",done:false},{text:"Prepare slides",done:false},{text:"Test tech setup",done:false},{text:"Send reminder email",done:false},{text:"Host event",done:false},{text:"Send follow-up",done:false}]), 0],
  ['evt_002', 'Cloud Security Workshop', 'Hands-on workshop covering cloud security best practices and our security suite.', '2026-04-22', '2026-04-23', 'Workshop', 'San Francisco, CA', '', 'p_admin001', '2026-03-01', 'Upcoming', 'p_nerdio1', JSON.stringify([{text:"Book venue",done:true},{text:"Prepare materials",done:false},{text:"Confirm attendees",done:false},{text:"Setup equipment",done:false},{text:"Run workshop",done:false},{text:"Collect feedback",done:false}]), 0],
  ['evt_003', 'Partner Summit 2026', 'Annual partner summit with keynotes, breakouts, and networking.', '2026-05-15', '2026-05-17', 'Conference', 'Las Vegas, NV', '', 'p_admin001', '2026-03-15', 'Upcoming', '', JSON.stringify([{text:"Register booth",done:false},{text:"Prepare collateral",done:false},{text:"Book travel",done:false},{text:"Staff booth",done:false},{text:"Collect leads",done:false},{text:"Follow up",done:false}]), 0],
  ['evt_004', 'Spring Campaign Launch', 'Joint marketing campaign for spring demand generation push.', '2026-04-01', '2026-04-30', 'Campaign', 'Digital', '', 'p_admin001', '2026-03-20', 'In Progress', 'p_ridgep1', JSON.stringify([{text:"Define target audience",done:true},{text:"Create content",done:true},{text:"Setup tracking",done:true},{text:"Launch campaign",done:true},{text:"Monitor performance",done:false},{text:"Report results",done:false}]), 12],
  ['evt_005', 'Technical Certification Bootcamp', 'Two-day certification prep for partner technical staff.', '2026-05-05', '2026-05-06', 'Workshop', 'Virtual (Teams)', '', 'p_admin001', '2026-04-01', 'Upcoming', 'p_insigh1', JSON.stringify([{text:"Book venue",done:false},{text:"Prepare materials",done:false},{text:"Confirm attendees",done:false},{text:"Setup equipment",done:false},{text:"Run workshop",done:false},{text:"Collect feedback",done:false}]), 0],
  ['evt_006', 'EMEA Partner Roundtable', 'Regional partner discussion on EMEA market strategy.', '2026-04-18', '2026-04-18', 'Webinar', 'Virtual (Zoom)', '', 'p_admin001', '2026-04-01', 'Upcoming', 'p_syscd01', JSON.stringify([{text:"Confirm speakers",done:false},{text:"Create registration page",done:false},{text:"Send invitations",done:false},{text:"Prepare slides",done:false},{text:"Test tech setup",done:false},{text:"Send reminder email",done:false},{text:"Host event",done:false},{text:"Send follow-up",done:false}]), 0],
  ['evt_007', 'Summer Pipeline Blitz', 'Summer demand gen campaign focusing on pipeline acceleration.', '2026-06-01', '2026-06-30', 'Campaign', 'Digital', '', 'p_admin001', '2026-04-05', 'Upcoming', 'p_qualc01', JSON.stringify([{text:"Define target audience",done:false},{text:"Create content",done:false},{text:"Setup tracking",done:false},{text:"Launch campaign",done:false},{text:"Monitor performance",done:false},{text:"Report results",done:false}]), 0],
];

let demoTranscripts = [
  ['transcript_id', 'partner_id', 'partner_name', 'conversation_date', 'transcript_text', 'created_at'],
];

let demoOppDescriptions = [
  ['description_id', 'opportunity_id', 'deal_name', 'description_date', 'description_text', 'created_at'],
];

let demoEventDescriptions = [
  ['description_id', 'event_id', 'title', 'description_date', 'description_text', 'created_at'],
];

let demoPartnerDocuments = [
  ['document_id', 'partner_id', 'partner_name', 'title', 'doc_type', 'html_content', 'status', 'created_at', 'updated_at'],
];

// ============================================
// Demo data localStorage persistence
// ============================================

const DEMO_STORAGE_KEY = 'pp_demo_data';
const DEMO_SCHEMA_VERSION = 15; // Bump when demo data structure changes

function persistDemoData() {
  try {
    localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify({
      version: DEMO_SCHEMA_VERSION,
      partners: demoPartners,
      opportunities: demoOpportunities,
      events: demoEvents,
      transcripts: demoTranscripts,
      oppDescriptions: demoOppDescriptions,
      eventDescriptions: demoEventDescriptions,
      partnerDocuments: demoPartnerDocuments,
    }));
  } catch { /* quota exceeded — silently ignore */ }
}

function loadPersistedDemoData() {
  try {
    const raw = localStorage.getItem(DEMO_STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    // Reject stale schema
    if (data.version !== DEMO_SCHEMA_VERSION) {
      localStorage.removeItem(DEMO_STORAGE_KEY);
      return false;
    }
    if (data.partners) demoPartners = data.partners;
    if (data.opportunities) demoOpportunities = data.opportunities;
    if (data.events) demoEvents = data.events;
    if (data.transcripts) demoTranscripts = data.transcripts;
    if (data.oppDescriptions) demoOppDescriptions = data.oppDescriptions;
    if (data.eventDescriptions) demoEventDescriptions = data.eventDescriptions;
    if (data.partnerDocuments) demoPartnerDocuments = data.partnerDocuments;
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear persisted demo data (useful for resetting to defaults).
 */
export function clearDemoData() {
  localStorage.removeItem(DEMO_STORAGE_KEY);
  invalidateSheetCache();
}

// On module init, restore persisted demo data if available
loadPersistedDemoData();

function getDemoData(sheetName) {
  switch (sheetName) {
    case CONFIG.SHEET_PARTNERS: return [...demoPartners.map(r => [...r])];
    case CONFIG.SHEET_OPPORTUNITIES: return [...demoOpportunities.map(r => [...r])];
    case CONFIG.SHEET_EVENTS: return [...demoEvents.map(r => [...r])];
    case CONFIG.SHEET_TRANSCRIPTS: return [...demoTranscripts.map(r => [...r])];
    case CONFIG.SHEET_OPP_DESCRIPTIONS: return [...demoOppDescriptions.map(r => [...r])];
    case CONFIG.SHEET_EVENT_DESCRIPTIONS: return [...demoEventDescriptions.map(r => [...r])];
    case CONFIG.SHEET_PARTNER_DOCUMENTS: return [...demoPartnerDocuments.map(r => [...r])];
    default: return [];
  }
}

/**
 * Add a row to demo data (for demo mode writes).
 */
export function addDemoRow(sheetName, values) {
  switch (sheetName) {
    case CONFIG.SHEET_PARTNERS: demoPartners.push(values); break;
    case CONFIG.SHEET_OPPORTUNITIES: demoOpportunities.push(values); break;
    case CONFIG.SHEET_EVENTS: demoEvents.push(values); break;
    case CONFIG.SHEET_TRANSCRIPTS: demoTranscripts.push(values); break;
    case CONFIG.SHEET_OPP_DESCRIPTIONS: demoOppDescriptions.push(values); break;
    case CONFIG.SHEET_EVENT_DESCRIPTIONS: demoEventDescriptions.push(values); break;
    case CONFIG.SHEET_PARTNER_DOCUMENTS: demoPartnerDocuments.push(values); break;
  }
  invalidateSheetCache(sheetName);
  persistDemoData();
}

/**
 * Update a row in demo data.
 */
export function updateDemoRow(sheetName, rowIndex, values) {
  let data;
  switch (sheetName) {
    case CONFIG.SHEET_PARTNERS: data = demoPartners; break;
    case CONFIG.SHEET_OPPORTUNITIES: data = demoOpportunities; break;
    case CONFIG.SHEET_EVENTS: data = demoEvents; break;
    case CONFIG.SHEET_TRANSCRIPTS: data = demoTranscripts; break;
    case CONFIG.SHEET_OPP_DESCRIPTIONS: data = demoOppDescriptions; break;
    case CONFIG.SHEET_EVENT_DESCRIPTIONS: data = demoEventDescriptions; break;
    case CONFIG.SHEET_PARTNER_DOCUMENTS: data = demoPartnerDocuments; break;
    default: return;
  }
  if (data[rowIndex - 1]) {
    data[rowIndex - 1] = values;
  }
  invalidateSheetCache(sheetName);
  persistDemoData();
}

/**
 * Delete a row from demo data.
 */
export function deleteDemoRow(sheetName, rowIndex) {
  let data;
  switch (sheetName) {
    case CONFIG.SHEET_PARTNERS: data = demoPartners; break;
    case CONFIG.SHEET_OPPORTUNITIES: data = demoOpportunities; break;
    case CONFIG.SHEET_EVENTS: data = demoEvents; break;
    case CONFIG.SHEET_TRANSCRIPTS: data = demoTranscripts; break;
    case CONFIG.SHEET_OPP_DESCRIPTIONS: data = demoOppDescriptions; break;
    case CONFIG.SHEET_EVENT_DESCRIPTIONS: data = demoEventDescriptions; break;
    case CONFIG.SHEET_PARTNER_DOCUMENTS: data = demoPartnerDocuments; break;
    default: return;
  }
  data.splice(rowIndex - 1, 1);
  invalidateSheetCache(sheetName);
  persistDemoData();
}
