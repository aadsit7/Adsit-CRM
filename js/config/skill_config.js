// ============================================================
// DEPRECATED — kept for backwards compatibility.
// ============================================================
// The MAP PDF feature no longer uses Anthropic's Skills API. PR #45's
// skills-based flow couldn't complete because Anthropic's Files API
// blocks browser CORS, which made sandbox-generated PDFs undownloadable
// from a static GitHub Pages host.
//
// The current flow (see js/utils/ai.js → requestMapPdfJson) uses the
// regular Messages API to get structured JSON, builds the PDF locally
// via jsPDF, and uploads it to Drive via the existing Apps Script
// endpoint. No skill ID required.
//
// This file is retained only so any external code that still happens
// to import from it doesn't crash. Safe to delete once no imports
// remain.
// ============================================================

export const RECAST_MAP_SKILL_ID = '';
export const RECAST_MAP_SKILL_ID_PLACEHOLDER = '';
