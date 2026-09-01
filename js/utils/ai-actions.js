// ============================================
// Shared AI Action Execution — Write Operations
// ============================================
// Used by both the AI Assistant chat view and the Randy voice assistant

import { loadSheetData, invalidateSheetCache } from './ai.js';
import { appendRow, updateRowById, deleteRowById, keyFieldFor, readSheetAsObjects, SHEET_HEADERS as ALL_SHEET_HEADERS } from '../sheets.js';

// ── Sheets the AI may write to ─────────────────────────────────────
// The allowlist is the sheet NAMES; the column order comes from sheets.js, so
// this file cannot drift from the schema the write helpers resolve rows
// against.
//
// Deriving it did change one thing, and not for the better: this file's Events
// row used to stop at `lead_count`, one short of `event_password`, so an AI
// update wrote the range A:N and simply could not reach that column. That was
// protection by accident, but it was real protection — `event_password` is the
// Event Workspace access gate, and the confirmation card an admin approves
// shows the sheet, the action type and the row match, never `action.changes`.
// So it is blocked explicitly below instead.
export const AI_WRITABLE_SHEETS = [
  'Partners', 'Opportunities', 'Events', 'Transcripts', 'Meeting_Index', 'AI_Conversations',
];

export const SHEET_HEADERS = Object.fromEntries(
  AI_WRITABLE_SHEETS
    .map(name => [name, ALL_SHEET_HEADERS[name]])
    .filter(([, headers]) => Array.isArray(headers)),
);

// Columns no AI action may set, whatever it asks for. These are credentials
// and privilege flags: a change to one is never what the summary on the
// confirmation card says it is.
export const BLOCKED_FIELDS = ['password_hash', 'is_admin', 'event_password'];

// ── Action Parser ──────────────────────────────────────────────────
export function parseActions(responseText) {
  const actions = [];
  let parseError = false;
  const cleanText = responseText.replace(/:::ACTION\n([\s\S]*?)\n:::/g, (_, json) => {
    try { actions.push(JSON.parse(json)); } catch (e) { console.error('Failed to parse action:', e); parseError = true; }
    return '';
  }).trim();
  // If action JSON was malformed, surface it so the user knows
  if (parseError && actions.length === 0) {
    return { cleanText: cleanText || "I tried to set up that change but hit a formatting issue. Can you try again?", actions: [] };
  }
  return { cleanText, actions };
}

// ── Row Matching ───────────────────────────────────────────────────
// ID fields use exact match only; name fields allow partial match
const ID_FIELDS = ['partner_id', 'opportunity_id', 'event_id', 'transcript_id', 'meeting_id', 'conversation_id'];

export function findMatchingRow(rows, match) {
  // First pass: exact match on all fields
  const exact = rows.find(row => {
    return Object.entries(match).every(([field, value]) => {
      return String(row[field] || '').toLowerCase() === String(value).toLowerCase();
    });
  });
  if (exact) return exact;

  // Second pass: exact on IDs, partial on names — but only if no ambiguity
  const partial = rows.filter(row => {
    return Object.entries(match).every(([field, value]) => {
      const rowVal = String(row[field] || '').toLowerCase();
      const matchVal = String(value).toLowerCase();
      if (ID_FIELDS.includes(field)) return rowVal === matchVal;
      return rowVal === matchVal || rowVal.includes(matchVal);
    });
  });
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    console.warn('findMatchingRow: ambiguous match — multiple rows found, using first', match);
    return partial[0];
  }
  return undefined;
}

// ── Action Execution ───────────────────────────────────────────────
export async function executeAction(action) {
  // Safety checks
  if (!action.sheet || !SHEET_HEADERS[action.sheet]) throw new Error(`Unknown sheet: ${action.sheet}`);
  if (action.type === 'delete' && action.sheet === 'Partners') throw new Error('Cannot delete Partners — use status change');
  if (action.changes) {
    for (const f of BLOCKED_FIELDS) {
      if (f in action.changes) throw new Error(`Cannot modify field: ${f}`);
    }
  }

  // Always load fresh data for write operations to avoid stale row references
  const sheetData = await loadSheetData(true);
  const headers = SHEET_HEADERS[action.sheet];
  const sheetKey = { Partners: 'partners', Opportunities: 'opportunities', Events: 'events', Transcripts: 'fullTranscripts', Meeting_Index: 'meetingIndex' }[action.sheet];
  // Writable sheets that are not part of the AI's loaded context —
  // AI_Conversations, whose rows are whole conversations and far too big to
  // feed the model — are resolved with a direct fresh read instead. Without
  // this, `rows` was always [] for them and every advertised update/delete
  // failed with "No matching row found".
  const rows = sheetKey
    ? (sheetData[sheetKey] || [])
    : await readSheetAsObjects(action.sheet, { forceRefresh: true });

  console.log(`[AI Action] ${new Date().toISOString()} — ${action.type} on ${action.sheet}`, action);

  if (action.type === 'update') {
    if (!action.row_match || Object.keys(action.row_match).length === 0) throw new Error('No row_match specified');
    const row = findMatchingRow(rows, action.row_match);
    if (!row) throw new Error('No matching row found');
    // Same identification as the delete branch below: row_match may key off
    // any columns, so resolve the matched row by its own id before writing.
    // The unchanged columns are taken from the sheet rather than from `rows`,
    // which comes from a cache — an update touching one field must not revert
    // another that changed since that cache was filled.
    const keyField = keyFieldFor(action.sheet);
    const keyValue = keyField ? row[keyField] : null;
    if (!keyValue) throw new Error(`Cannot safely update ${action.sheet}: the matched row has no identifier.`);
    await updateRowById(action.sheet, keyField, keyValue, (fresh) => headers.map(h => {
      if (action.changes && h in action.changes) return action.changes[h];
      return fresh[h] || '';
    }));
  } else if (action.type === 'create') {
    const values = headers.map(h => (action.changes && action.changes[h]) || '');
    await appendRow(action.sheet, values);
  } else if (action.type === 'delete') {
    if (!action.row_match || Object.keys(action.row_match).length === 0) throw new Error('No row_match specified');
    const row = findMatchingRow(rows, action.row_match);
    if (!row) throw new Error('No matching row found');
    // row_match may name any columns, so the matched row is identified here by
    // its own key before deleting — `rows` comes from a cache that a concurrent
    // write can age out from under us, and a stale index deletes a bystander.
    const keyField = keyFieldFor(action.sheet);
    const keyValue = keyField ? row[keyField] : null;
    if (!keyValue) throw new Error(`Cannot safely delete from ${action.sheet}: the matched row has no identifier.`);
    await deleteRowById(action.sheet, keyField, keyValue);
  }

  invalidateSheetCache();
}
