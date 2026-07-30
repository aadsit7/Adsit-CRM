// ============================================================
// Partner Next Steps — sheet contract, strict parser, dedupe/merge helpers
// ============================================================
// Powers the "Next Steps" section on the Partner Detail page: a mutual
// action plan distilled from the description notes the USER SELECTED, plus
// any steps typed in by hand. Each row is a milestone of the plan — what
// must happen, who owns it (Recast / the partner / both teams), its target
// timing, and a one-word status — rendered top-to-bottom in plan order.
// Analysis rows and manual rows live side by side, each carrying its own
// provenance.
//
// ACCURACY CONTRACT (the reason this module exists):
// The model only PROPOSES next steps; this module verifies every proposal
// before anything is saved:
//   • a proposed step survives only if its `evidence` — a verbatim snippet
//     the model must copy from the notes — is literally present in one of
//     the selected sources (normalized for case/whitespace/curly quotes,
//     via the shared snippet matcher — no word-boundary guard, since the
//     distinctiveness floor below already rules out incidental matches).
//     The snippet must also clear a distinctiveness floor (MIN_EVIDENCE_*):
//     a generic two-word phrase occurs in almost any note, so matching one
//     proves nothing. A step whose evidence cannot be found word-for-word,
//     or is too generic to tie the step to a note, is dropped and reported,
//     never saved;
//   • an applicable date survives only as a well-formed real calendar date
//     (YYYY-MM-DD); anything else — "next week", "TBD", a malformed string
//     — is stored as empty, never guessed. Relative timing the notes state
//     ("Post-ARB approval") is carried separately in `timing`, as text;
//   • a status survives only as one of the fixed set (NEXT_STEP_STATUSES);
//     anything else is stored as empty rather than displayed as a made-up
//     state. Same for `kind` — 'gate' (major milestone) or 'step';
//   • cited source ids that don't exist are discarded; the ids kept for a
//     step are only those whose text actually contains its evidence, so
//     the provenance shown in the table can always be checked by opening
//     that very note.
//
// LIVING-PLAN RULE (dedupe + merge):
// A re-analysis APPENDS new steps (the plan grows as notes reveal new
// gates) and MOVES existing rows forward: when the newest notes progress a
// step's status or firm up its date, the saved row is updated in place —
// completed rows are never removed, they are the visual record of momentum.
// Proposals are deduped within one reply and against the rows already
// saved, matching on normalized step text.
//
// No DOM, no network — fully testable under Node.
// ============================================================

// The balanced-object extractor (fence stripping + truncation salvage) and
// the verbatim snippet matcher are shared with the sibling analyzers — one
// tested implementation, not two. snippetFoundInText (not fieldFoundInText):
// evidence snippets clear a 20-char/3-word distinctiveness floor, so the
// short-field word-boundary guard adds nothing here — while it WOULD wrongly
// reject a snippet that starts at a glued block boundary in stripped note
// text ("…ObjectiveWipro is evaluating…").
import { extractJsonObject } from './contact-analyzer-schema.js';
import { snippetFoundInText } from './partner-contacts.js';

// ── Sheet contract (the Partner_Next_Steps tab) ─────────────────────
// One row per next step. Flat columns so the spreadsheet reads on its own:
//   source        'analysis' (produced by the Analyze run) or 'manual'
//   source_dates  the dates of the description notes the step came from,
//                 semicolon-separated ('' for manual rows)
//   evidence      the verbatim note snippet that grounds the step ('' manual)
//   analyzed_at   ISO datetime of the Analyze run ('' for manual rows)
//   owner         who is responsible — "Recast", "<Partner> (Name)", "Both teams"
//   status        one word from NEXT_STEP_STATUSES, or ''
//   timing        relative timing stated by the notes ("Post-ARB approval")
//                 for steps with no calendar date
//   kind          'gate' (major milestone / approval gate) or 'step'
// The four plan columns are APPENDED after the original schema — that is
// what lets ensureSheetWithHeaders extend an existing tab's header row in
// place without moving any data column.
export const PARTNER_NEXT_STEP_HEADERS = [
  'step_id', 'partner_id', 'partner_name',
  'next_step', 'due_date', 'source', 'source_dates', 'evidence',
  'analyzed_at', 'created_at', 'updated_at',
  'owner', 'status', 'timing', 'kind',
];

export const NEXT_STEP_SOURCES = new Set(['analysis', 'manual']);

// ── The status set ──────────────────────────────────────────────────
// The mutual-action-plan vocabulary, verbatim from the MAP standard. One
// word per row, nothing outside this set — and deliberately no
// "Risk"/"Blocked": the agenda is written to be screen-shared with the
// partner, so waiting states read neutrally ("Pending", never "stalled").
export const NEXT_STEP_STATUSES = ['Complete', 'In Progress', 'Next', 'Scheduled', 'Pending'];

// Case/spacing-insensitive lookup ("in-progress", "COMPLETED" → canonical).
const STATUS_BY_KEY = new Map([
  ['complete', 'Complete'],
  ['completed', 'Complete'],
  ['inprogress', 'In Progress'],
  ['next', 'Next'],
  ['scheduled', 'Scheduled'],
  ['pending', 'Pending'],
]);

/**
 * Canonicalize a status to the fixed set, or ''. Forgiving on case,
 * spacing and the "Completed" past-participle; anything else — "On track",
 * "Blocked", prose — is empty rather than a made-up state on the plan.
 */
export function normalizeNextStepStatus(value) {
  const key = String(value == null ? '' : value).toLowerCase().replace(/[\s_-]+/g, '');
  return STATUS_BY_KEY.get(key) || '';
}

/** 'gate' (major milestone / approval gate — rendered bold) or 'step'. */
export function normalizeNextStepKind(value) {
  const key = String(value == null ? '' : value).toLowerCase().trim();
  return (key === 'gate' || key === 'milestone' || key === 'major') ? 'gate' : 'step';
}

// Field bounds. Generous enough for a real action item, tight enough that a
// row stays a few hundred bytes and the table stays readable.
const MAX_STEP_LEN = 400;
const MAX_EVIDENCE_LEN = 240;
const MAX_OWNER_LEN = 80;
const MAX_TIMING_LEN = 80;
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
      "next_step": "string — ONE concrete plan milestone or action in plain, client-safe language, specific enough that anyone reading the plan knows what must happen",
      "kind": "\\"gate\\" for a major milestone or approval gate, \\"step\\" for a supporting sub-step",
      "owner": "who is responsible, exactly as far as the notes support it — \\"Recast\\", \\"<Partner name> (Person)\\" or \\"Both teams\\" — else \\"NA\\"",
      "status": "exactly ONE of: Complete | In Progress | Next | Scheduled | Pending",
      "due_date": "YYYY-MM-DD — only when the notes state or unambiguously imply a calendar date for this action, else \\"NA\\"",
      "timing": "the relative timing the notes state when there is no calendar date (e.g. \\"Post-ARB approval\\", \\"After the POC\\"), else \\"NA\\" — never an invented date",
      "evidence": "string — an EXACT verbatim snippet (a full clause of at least a few words, 20-200 characters) copied character-for-character from ONE of the supplied notes, proving this step comes from the notes",
      "source_ids": ["string — the supplied source id(s) this step draws on"]
    }
  ],
  "note": "string — the INTERNAL handoff line for the account owner (never shown to the partner): anything you left out or reworded under the client-safe rules and why, plus any ambiguous product name, owner or date worth double-checking — or \\"\\""
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
    const verifiedIds = candidates.filter(id => snippetFoundInText(evidence, sourceById.get(id).text));
    if (!verifiedIds.length && citedIds.length) {
      // Cited sources don't contain it — check the rest before giving up.
      for (const id of sourceById.keys()) {
        if (!citedIds.includes(id) && snippetFoundInText(evidence, sourceById.get(id).text)) {
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
      // The plan columns survive only in their canonical forms — an owner
      // is bounded text, a status is one of the fixed set or nothing, a
      // timing is the notes' stated relative timing, never a guessed date.
      owner: typeof raw.owner === 'string' ? cleanText(raw.owner, MAX_OWNER_LEN) : '',
      status: normalizeNextStepStatus(raw.status),
      timing: typeof raw.timing === 'string' ? cleanText(raw.timing, MAX_TIMING_LEN) : '',
      kind: normalizeNextStepKind(raw.kind),
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
 * Did this proposal move a saved step forward? Progression means the newest
 * notes changed its state — a new status ("In Progress" → "Complete") or a
 * date that firmed up or moved. A mere rewording of owner or timing text is
 * NOT progression: it would churn the sheet on every re-analysis.
 */
export function nextStepProgressed(existing, proposed) {
  const e = existing || {};
  const p = proposed || {};
  const pStatus = normalizeNextStepStatus(p.status);
  const eStatus = normalizeNextStepStatus(e.status);
  if (pStatus && pStatus !== eStatus) return true;
  const pDue = isoDateOrEmpty(p.due_date);
  if (pDue && pDue !== isoDateOrEmpty(e.due_date)) return true;
  return false;
}

/**
 * Split freshly verified proposals against the saved plan — the living-plan
 * rule. Matches on normalized step text:
 *   fresh    not on the plan yet → append (the plan grows);
 *   updates  already on the plan AND the newest notes progressed it (see
 *            nextStepProgressed) → move the saved row forward in place;
 *   skipped  already on the plan, unchanged → nothing to do.
 * Rows are never removed here — completed steps stay as the record of
 * momentum.
 */
export function dedupeNextSteps(existingSteps, proposedSteps) {
  const byKey = new Map();
  for (const s of existingSteps || []) {
    const key = normalizeStepKey(s && s.next_step);
    if (key && !byKey.has(key)) byKey.set(key, s);
  }
  const known = new Set(byKey.keys());
  const fresh = [];
  const updates = [];
  const skipped = [];
  for (const p of proposedSteps || []) {
    const key = normalizeStepKey(p && p.next_step);
    if (!key) continue;
    if (known.has(key)) {
      const existing = byKey.get(key);
      if (existing && nextStepProgressed(existing, p)) updates.push({ existing, proposed: p });
      else skipped.push(p);
      continue;
    }
    known.add(key);
    fresh.push(p);
  }
  return { fresh, updates, skipped };
}

/**
 * Merge a progressed proposal into the SAVED record (pure — the caller
 * writes the result). Conservative by design:
 *   • the step's identity — text, ids, created_at — is untouched;
 *   • a non-empty proposed value replaces the stored one; an empty proposal
 *     never blanks a field the plan already knows;
 *   • 'gate' is sticky: once a row is a major milestone it stays one;
 *   • evidence and source_dates refresh to the newest analysis (the
 *     consolidation rule: cite the most recent note), and the analysis
 *     stamp records that this run touched the row.
 */
export function mergeNextStepUpdate(record, proposed, { analyzedAt = '', sourceDates = '' } = {}) {
  const r = record || {};
  const p = proposed || {};
  const pStatus = normalizeNextStepStatus(p.status);
  return {
    ...r,
    status: pStatus || normalizeNextStepStatus(r.status),
    due_date: isoDateOrEmpty(p.due_date) || isoDateOrEmpty(r.due_date),
    timing: (typeof p.timing === 'string' && p.timing.trim()) ? p.timing.trim() : (r.timing || ''),
    owner: (typeof p.owner === 'string' && p.owner.trim()) ? p.owner.trim() : (r.owner || ''),
    kind: (normalizeNextStepKind(p.kind) === 'gate' || normalizeNextStepKind(r.kind) === 'gate') ? 'gate' : 'step',
    evidence: p.evidence || r.evidence || '',
    source_dates: sourceDates || r.source_dates || '',
    analyzed_at: analyzedAt || r.analyzed_at || '',
    updated_at: analyzedAt || r.updated_at || '',
  };
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
    owner: r.owner || '',
    status: normalizeNextStepStatus(r.status),
    timing: r.timing || '',
    kind: normalizeNextStepKind(r.kind),
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
    owner: cell('owner'),
    // A hand-edited "Blocked" or "On hold" in the sheet reads back as '' —
    // the plan only ever shows the fixed vocabulary.
    status: normalizeNextStepStatus(cell('status')),
    timing: cell('timing'),
    kind: normalizeNextStepKind(cell('kind')),
  };
}

/**
 * This partner's saved steps, in PLAN ORDER — the stored row order, kept
 * exactly. The analysis emits steps in the plan's sequence (each approval
 * gate in the order the notes describe it, budget before POC, the standard
 * tail), appends preserve that sequence, and later-discovered milestones
 * append as the plan grows. A date re-sort would scramble it: "Contract
 * signature — post-POC" has no calendar date yet belongs after the POC
 * rows, not floated above or below them. Strictly matched on partner_id;
 * rows without a step text are ignored.
 */
export function selectPartnerNextSteps(rows, partnerId) {
  const id = String(partnerId || '').trim();
  if (!id) return [];
  return (rows || [])
    .filter(r => String(r && r.partner_id || '').trim() === id)
    .map(nextStepFromRow)
    .filter(s => s.next_step);
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
