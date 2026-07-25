// ============================================
// Shared AI Action Execution — Write Operations
// ============================================
// Used by both the AI Assistant chat view and the Randy voice assistant

import { loadSheetData, invalidateSheetCache } from './ai.js';
import { appendRow, updateRowById, deleteRowById, keyFieldFor } from '../sheets.js';

// ── Sheet Headers (for write operations) ───────────────────────────
export const SHEET_HEADERS = {
  Partners: ['partner_id', 'username', 'display_name', 'partner_type', 'tier', 'region', 'created_at', 'is_admin', 'password_hash', 'status', 'hq_location'],
  Opportunities: ['opportunity_id', 'partner_id', 'deal_name', 'customer_name', 'deal_value', 'status', 'stage', 'expected_close', 'description', 'created_at', 'updated_at', 'notes', 'lead_source'],
  Events: ['event_id', 'title', 'description', 'event_date', 'end_date', 'event_type', 'location', 'url', 'created_by', 'created_at', 'status', 'partner_id', 'checklist', 'lead_count'],
  Transcripts: ['transcript_id', 'partner_id', 'partner_name', 'conversation_date', 'transcript_text', 'created_at'],
  Meeting_Index: ['meeting_id', 'transcript_id', 'partner_id', 'partner_name', 'meeting_date', 'meeting_title', 'attendees', 'summary', 'key_decisions', 'topics_discussed'],
  AI_Conversations: ['conversation_id', 'username', 'started_at', 'title', 'messages', 'status'],
};
export const BLOCKED_FIELDS = ['password_hash', 'is_admin'];

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
  const rows = (sheetKey && sheetData[sheetKey]) || [];

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
