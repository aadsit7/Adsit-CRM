// ============================================================
// Partner Next Steps — sheet contract, strict parser, dedupe/sort helpers
// ============================================================
// Powers the "Next Steps" section on the Partner Detail page: the forward
// agenda distilled from the description notes the USER SELECTED, plus any
// steps they typed in by hand. Analysis rows and manual rows live side by
// side in one table, each carrying its own provenance.
//
// ACCURACY CONTRACT (the reason this module exists):
// The model only PROPOSES next steps; this module verifies every proposal
// before anything is saved:
//   • a proposed step survives only if its `evidence` — a verbatim snippet
//     the model must copy from the notes — is literally present in one of
//     the selected sources (normalized for case/whitespace/curly quotes,
//     boundary-clean, via the same tested matcher Partner Contacts uses).
//     The snippet must also clear a distinctiveness floor (MIN_EVIDENCE_*):
//     a generic two-word phrase occurs in almost any note, so matching one
//     proves nothing. A step whose evidence cannot be found word-for-word,
//     or is too generic to tie the step to a note, is dropped and reported,
//     never saved;
//   • an applicable date survives only as a well-formed real calendar date
//     (YYYY-MM-DD); anything else — "next week", "TBD", a malformed string
//     — is stored as empty, never guessed;
//   • cited source ids that don't exist are discarded; the ids kept for a
//     step are only those whose text actually contains its evidence, so
//     the provenance shown in the table can always be checked by opening
//     that very note.
//
// DUPLICATE RULE:
// A re-analysis APPENDS to the table (that is the feature: the agenda grows
// as new notes are analyzed), so the same step must not pile up. Proposals
// are deduped within one reply and against the rows already saved, matching
// on normalized step text.
//
// No DOM, no network — fully testable under Node.
// ============================================================

// The balanced-object extractor (fence stripping + truncation salvage) and
// the verbatim phrase matcher are shared with the sibling analyzers — one
// tested implementation, not two.
import { extractJsonObject } from './contact-analyzer-schema.js';
import { fieldFoundInText } from './partner-contacts.js';

// ── Sheet contract (the Partner_Next_Steps tab) ─────────────────────
// One row per next step. Flat columns so the spreadsheet reads on its own:
//   source        'analysis' (produced by the Analyze run) or 'manual'
//   source_dates  the dates of the description notes the step came from,
//                 semicolon-separated ('' for manual rows)
//   evidence      the verbatim note snippet that grounds the step ('' manual)
//   analyzed_at   ISO datetime of the Analyze run ('' for manual rows)
export const PARTNER_NEXT_STEP_HEADERS = [
  'step_id', 'partner_id', 'partner_name',
  'next_step', 'due_date', 'source', 'source_dates', 'evidence',
  'analyzed_at', 'created_at', 'updated_at',
];

export const NEXT_STEP_SOURCES = new Set(['analysis', 'manual']);

// Field bounds. Generous enough for a real action item, tight enough that a
// row stays a few hundred bytes and the table stays readable.
const MAX_STEP_LEN = 400;
const MAX_EVIDENCE_LEN = 240;
const MAX_STEPS = 40;
// Evidence is verified UNTRUNCATED (up to this sanity cap) and only then cut
// down for storage — a snippet clipped mid-word before verification would
// fail the boundary-clean matcher and wrongly drop a genuinely grounded step.
const EVIDENCE_VERIFY_CAP = 2000;
// The grounding floor: a snippet must be distinctive enough that finding it
// in a note genuinely ties the step to that note. Without it, a two-word
// generic phrase ("follow up") occurs in almost any note and would let a
// fabricated step through the gate.
const MIN_EVIDENCE_LEN = 20;
const MIN_EVIDENCE_WORDS = 3;

/** The JSON shape shown to the model, mirrored by the parser below. */
export const NEXT_STEPS_SCHEMA_EXAMPLE = `{
  "next_steps": [
    {
      "next_step": "string — ONE concrete, forward-looking action in plain language, specific enough that anyone reading the agenda knows what to do",
      "due_date": "YYYY-MM-DD — only when the notes state or unambiguously imply a calendar date for this action, else \\"NA\\"",
      "evidence": "string — an EXACT verbatim snippet (a full clause of at least a few words, 20-200 characters) copied character-for-character from ONE of the supplied notes, proving this step comes from the notes",
      "source_ids": ["string — the supplied source id(s) this step draws on"]
    }
  ],
  "note": "string — one short sentence on coverage or ambiguity, or \\"\\""
}`;

// Placeholder values that mean "nothing" wherever a real value is expected.
const PLACEHOLDER_RE = /^(na|n\/?a|none|null|undefined|unknown|not specified|not provided|tbd|-|—|–)$/i;

// Truncate on a word boundary, so a cut snippet is still a verbatim phrase
// the boundary-clean matcher can find in its source.
function truncateAtWordBoundary(s, cap) {
  if (s.length <= cap) return s;
  const cut = s.slice(0, cap + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : s.slice(0, cap)).trim();
}

function cleanText(value, cap) {
  let s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  s = s.replace(/^[-*•]\s+/, '').trim();
  if (PLACEHOLDER_RE.test(s)) return '';
  return truncateAtWordBoundary(s, cap);
}

/**
 * Neutralize the prompt's own structural markers inside note text: the
 * <<< / >>> source delimiters (a note must not be able to close its own
 * block and impersonate the instructions) and markdown fences (a copied
 * ``` inside an evidence string would defeat the reply's fence-stripping
 * JSON extraction). Applied where the sources are BUILT, so the model and
 * the verbatim evidence gate see the identical text.
 */
export function sanitizeNoteTextForAnalysis(text) {
  return String(text || '')
    .replace(/<<<+/g, '< < <')
    .replace(/>>>+/g, '> > >')
    .replace(/```+/g, "'''");
}

/**
 * A well-formed, real calendar date (YYYY-MM-DD) or ''. Anything the model
 * returns that is not one — "NA", prose, an impossible date — is stored as
 * empty rather than guessed at.
 */
export function isoDateOrEmpty(value) {
  // The WHOLE string must be a date (an ISO time suffix is tolerated) —
  // slicing ten characters off the front first would coerce a hedged or
  // malformed answer ("2026-08-05 or 2026-09-01") into a confident date.
  const s = String(value == null ? '' : value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}.*)?$/);
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  // Reject impossible day-of-month combinations (Feb 30, Apr 31, …).
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The dedupe identity of a step: its text, normalized. */
export function normalizeStepKey(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritics (José → jose)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/g, '')
    .trim();
}

/**
 * Parse and validate the model's raw text into verified next steps.
 * Every kept step is grounded in the supplied sources (see the module
 * header for the exact guarantees). Ungroundable steps are dropped and
 * reported in `dropped` — the caller surfaces the count, never saves them.
 *
 * @param {string} rawText The model's reply.
 * @param {object} options
 * @param {Array}  options.sources The exact sources given to the prompt:
 *   [{ source_id, date, text }] — text as the model saw it (HTML stripped).
 * @param {boolean} [options.truncated] Caller saw stop_reason "max_tokens";
 *   marks the result partial (the extractor salvages what it can).
 * @returns {{ steps: Array<{next_step, due_date, evidence, source_ids}>,
 *             note: string, dropped: Array<{next_step, reason}>, partial: boolean }}
 */
export function parsePartnerNextStepsResponse(rawText, { sources = [], truncated = false } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    const err = new Error('The next-steps analysis returned an empty response.');
    err.code = 'PARTNER_NEXT_STEPS_EMPTY';
    throw err;
  }

  const parsed = extractJsonObject(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const hint = truncated ? ' (the reply was cut off at the output-token limit)' : '';
    const err = new Error(`The next-steps analysis came back in a format the app could not read${hint} — try again.`);
    err.code = 'PARTNER_NEXT_STEPS_INVALID';
    throw err;
  }

  const sourceById = new Map();
  for (const s of sources) {
    if (s && s.source_id) sourceById.set(String(s.source_id), s);
  }

  const rawSteps = Array.isArray(parsed.next_steps) ? parsed.next_steps.slice(0, MAX_STEPS) : [];
  const steps = [];
  const dropped = [];
  const seen = new Set();

  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object') continue;

    // The step text IS the deliverable — a non-string here is a malformed
    // row, not something to stringify into "[object Object]".
    if (typeof raw.next_step !== 'string') continue;
    const nextStep = cleanText(raw.next_step, MAX_STEP_LEN);
    if (!nextStep) continue;

    const evidence = typeof raw.evidence === 'string' ? cleanText(raw.evidence, EVIDENCE_VERIFY_CAP) : '';
    if (!evidence) {
      dropped.push({ next_step: nextStep, reason: 'no evidence snippet supplied' });
      continue;
    }
    // A snippet below the floor ("follow up") occurs in almost any note, so
    // finding it proves nothing — the gate requires a distinctive phrase.
    if (evidence.length < MIN_EVIDENCE_LEN || evidence.split(' ').length < MIN_EVIDENCE_WORDS) {
      dropped.push({ next_step: nextStep, reason: 'evidence snippet too short to genuinely tie the step to a note' });
      continue;
    }

    // The grounding gate: the snippet must be literally present in one of
    // the selected notes. Checked against the CITED sources first, then —
    // strict on grounding, forgiving on citation — against every source.
    // Only ids whose text actually contains the evidence are kept.
    const citedIds = (Array.isArray(raw.source_ids) ? raw.source_ids : [])
      .map(id => String(id == null ? '' : id).trim())
      .filter(id => sourceById.has(id));
    const candidates = citedIds.length ? citedIds : [...sourceById.keys()];
    const verifiedIds = candidates.filter(id => fieldFoundInText(evidence, sourceById.get(id).text));
    if (!verifiedIds.length && citedIds.length) {
      // Cited sources don't contain it — check the rest before giving up.
      for (const id of sourceById.keys()) {
        if (!citedIds.includes(id) && fieldFoundInText(evidence, sourceById.get(id).text)) {
          verifiedIds.push(id);
        }
      }
    }
    if (!verifiedIds.length) {
      dropped.push({ next_step: nextStep, reason: 'evidence not found verbatim in the selected notes' });
      continue;
    }

    const key = normalizeStepKey(nextStep);
    if (seen.has(key)) continue;
    seen.add(key);

    steps.push({
      next_step: nextStep,
      due_date: isoDateOrEmpty(raw.due_date),
      // Stored bounded, cut on a word boundary AFTER verification so the
      // kept snippet is still a verbatim, findable phrase from the note.
      evidence: truncateAtWordBoundary(evidence, MAX_EVIDENCE_LEN),
      source_ids: verifiedIds,
    });
  }

  return {
    steps,
    note: cleanText(parsed.note, 300),
    dropped,
    partial: !!truncated,
  };
}

/**
 * Split freshly verified proposals into ones to append and ones already in
 * the table — a re-analysis of the same notes must not duplicate rows.
 * Matches on normalized step text.
 */
export function dedupeNextSteps(existingSteps, proposedSteps) {
  const known = new Set((existingSteps || []).map(s => normalizeStepKey(s && s.next_step)));
  const fresh = [];
  const skipped = [];
  for (const p of proposedSteps || []) {
    const key = normalizeStepKey(p && p.next_step);
    if (!key) continue;
    if (known.has(key)) { skipped.push(p); continue; }
    known.add(key);
    fresh.push(p);
  }
  return { fresh, skipped };
}

// ── Storage mapping ─────────────────────────────────────────────────

/** Flatten a step record into the sheet row, in header order. */
export function nextStepRowValues(record) {
  const r = record || {};
  const cells = {
    step_id: r.step_id || '',
    partner_id: r.partner_id || '',
    partner_name: r.partner_name || '',
    next_step: r.next_step || '',
    due_date: isoDateOrEmpty(r.due_date),
    source: NEXT_STEP_SOURCES.has(r.source) ? r.source : (r.analyzed_at ? 'analysis' : 'manual'),
    source_dates: r.source_dates || '',
    evidence: r.evidence || '',
    analyzed_at: r.analyzed_at || '',
    created_at: r.created_at || '',
    updated_at: r.updated_at || '',
  };
  return PARTNER_NEXT_STEP_HEADERS.map(h => String(cells[h] == null ? '' : cells[h]));
}

/** Rehydrate a sheet row into a step record. Malformed cells degrade to ''. */
export function nextStepFromRow(row) {
  const r = row || {};
  const cell = (k) => String(r[k] == null ? '' : r[k]).trim();
  const analyzedAt = cell('analyzed_at');
  const rawSource = cell('source').toLowerCase();
  return {
    _rowIndex: r._rowIndex,
    step_id: cell('step_id'),
    partner_id: cell('partner_id'),
    partner_name: cell('partner_name'),
    next_step: cell('next_step'),
    due_date: isoDateOrEmpty(cell('due_date')),
    source: NEXT_STEP_SOURCES.has(rawSource) ? rawSource : (analyzedAt ? 'analysis' : 'manual'),
    source_dates: cell('source_dates'),
    evidence: cell('evidence'),
    analyzed_at: analyzedAt,
    created_at: cell('created_at'),
    updated_at: cell('updated_at'),
  };
}

/**
 * This partner's saved steps, as an agenda: dated steps first in date order,
 * undated steps after in the order they were added. Strictly matched on
 * partner_id; rows without a step text are ignored.
 */
export function selectPartnerNextSteps(rows, partnerId) {
  const id = String(partnerId || '').trim();
  if (!id) return [];
  const steps = (rows || [])
    .filter(r => String(r && r.partner_id || '').trim() === id)
    .map(nextStepFromRow)
    .filter(s => s.next_step);
  steps.sort((a, b) => {
    if (a.due_date && b.due_date && a.due_date !== b.due_date) {
      return a.due_date < b.due_date ? -1 : 1;
    }
    if (a.due_date && !b.due_date) return -1;
    if (!a.due_date && b.due_date) return 1;
    return (Date.parse(a.created_at || '') || 0) - (Date.parse(b.created_at || '') || 0);
  });
  return steps;
}

/** The most recent Analyze run recorded in these steps, or ''. */
export function lastAnalyzedAt(steps) {
  let best = '';
  for (const s of steps || []) {
    const at = String(s && s.analyzed_at || '').trim();
    if (at && (!best || (Date.parse(at) || 0) > (Date.parse(best) || 0))) best = at;
  }
  return best;
}
