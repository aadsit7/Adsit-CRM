// ============================================================
// Forecast JSON schema — shared between prompt builder and parser
// ============================================================
// Mirrors the timeline-pdf-schema.js pattern: a single example string
// shown to the model, plus a strict parser that strips fences, extracts
// the JSON, validates every field, drops anything malformed, and coerces
// bad values to safe defaults.
//
// The parser is where the GOLDEN RULE is *enforced* rather than merely
// requested. Three guards matter most:
//   1. Unknown stage_id / criterion_id values are dropped — the model
//      cannot invent a criterion that isn't in the stage definitions.
//   2. A criterion cannot be "met" or "partial" without a real,
//      traceable anchor: a non-empty evidence quote AND either a source
//      note id OR a source date that matches an actual note. A cited id
//      or date that does not exist in the source notes is cleared; if a
//      claim is left with no surviving anchor it is downgraded to
//      "no_evidence" with its source fields cleared. An invented
//      checkmark — including one pinned to a fabricated date — never
//      survives parsing when the real note ids/dates are supplied.
//   3. Evidence grounding: even when the cited note id/date is real, the
//      quote itself must actually come from that note. When the source
//      note text is supplied, a "met"/"partial" whose evidence quote does
//      not overlap the cited note's prose (a fabricated quote pinned to a
//      real note) is downgraded to "no_evidence". Tolerant of close
//      paraphrase, intolerant of invention.
// ============================================================

import {
  CRITERION_IDS,
  CRITERION_TO_STAGE,
  getStageById,
  getBucketForStageId,
  getProbabilityForStageId,
} from './forecast-stages.js';

export const FORECAST_SCHEMA_EXAMPLE = `{
  "opportunity_id": "string — echo back the ID given",
  "customer_name": "string",
  "current_stage_id": "string — the id of the furthest stage the deal has substantially reached (fully complete, or at least half its criteria met)",
  "current_stage_confidence": "high | medium | low",
  "forecast_bucket": "string — derived from current_stage_id",
  "probability": "number — derived from current_stage_id",
  "summary": "string — 2-3 sentences on where this deal actually stands",
  "stages": [
    {
      "stage_id": "string — must exactly match a stage id from the stage definitions",
      "status": "complete | in_progress | not_started",
      "notes": "string — 1-3 sentences on what happened in this stage. Empty string if no evidence.",
      "criteria": [
        {
          "criterion_id": "string — must exactly match an id from the stage definitions",
          "status": "met | partial | not_met | no_evidence",
          "evidence": "string — a short quote or close paraphrase from ONE source note. Empty string if no_evidence.",
          "source_date": "string — the description_date of the note the evidence came from. Empty string if none.",
          "source_id": "string — the description_id of that note. Empty string if none."
        }
      ]
    }
  ],
  "gaps": ["string — what is missing to advance to the next stage"],
  "open_questions": ["string — questions the notes leave unanswered"]
}`;

const VALID_STAGE_STATUSES     = new Set(['complete', 'in_progress', 'not_started']);
const VALID_CRITERION_STATUSES = new Set(['met', 'partial', 'not_met', 'no_evidence']);
const VALID_CONFIDENCE         = new Set(['high', 'medium', 'low']);

// Statuses that assert a criterion is (at least partly) satisfied and so
// must be backed by real, traceable evidence.
const CLAIMED_STATUSES = new Set(['met', 'partial']);

// ── Evidence grounding (guard #3) ───────────────────────────────────
// The model is instructed to "quote or closely paraphrase" one source
// note. We verify that promise deterministically: the evidence must share
// a strong majority of its content words with the cited note's prose. This
// tolerates a close paraphrase (synonyms/reordering keep most content
// words) while rejecting a quote invented on top of a real note id/date.
const EVIDENCE_GROUNDING_MIN_OVERLAP = 0.5;

// Words too common to carry meaning — excluded so overlap reflects the
// substantive vocabulary (names, numbers, verbs) rather than filler.
const GROUNDING_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'been', 'being', 'has', 'have',
  'had', 'its', 'this', 'that', 'these', 'those', 'they', 'them', 'their',
  'with', 'from', 'will', 'would', 'can', 'could', 'should', 'may', 'might',
  'not', 'but', 'our', 'your', 'his', 'her', 'she', 'him', 'who', 'whom',
  'which', 'what', 'when', 'where', 'into', 'onto', 'per', 'via', 'about',
]);

function groundingTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation → space (keeps $150k → 150k)
    .split(/\s+/)
    .filter(w => w.length >= 3 && !GROUNDING_STOPWORDS.has(w));
}

/**
 * Is `evidence` grounded in `noteText`? True when a strong majority of the
 * evidence's distinct content words appear in the note. Returns true (skip
 * the check) when there is nothing substantive to compare — an empty quote,
 * or a note whose text we don't have — so grounding only ever downgrades a
 * quote we can positively show is ungrounded; it never invents a rejection.
 */
function isEvidenceGrounded(evidence, noteText) {
  const evWords = [...new Set(groundingTokens(evidence))];
  if (evWords.length === 0) return true;
  const noteSet = new Set(groundingTokens(noteText));
  if (noteSet.size === 0) return true;
  let hits = 0;
  for (const w of evWords) if (noteSet.has(w)) hits += 1;
  return (hits / evWords.length) >= EVIDENCE_GROUNDING_MIN_OVERLAP;
}

// Resolve the text of the note a surviving anchor points at, preferring the
// precise id match over the (possibly many-to-one) date match. Returns null
// when we have no text for either anchor — the signal to skip grounding.
function resolveAnchorText(sourceId, sourceDate, texts) {
  if (!texts) return null;
  if (sourceId && texts.byId && texts.byId.has(sourceId)) return texts.byId.get(sourceId);
  if (sourceDate && texts.byDate && texts.byDate.has(sourceDate)) return texts.byDate.get(sourceDate);
  return null;
}

function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function cleanStrArray(v) {
  return Array.isArray(v)
    ? v.map(x => String(x == null ? '' : x).trim()).filter(Boolean)
    : [];
}

/**
 * Parse and validate Claude's raw text response into a forecast object.
 *
 * @param {string} rawText              The model's message text.
 * @param {object} [options]
 * @param {Set<string>|Array<string>} [options.validSourceIds]
 *   The description_ids actually present in the source notes. When
 *   supplied, a cited source_id outside this set is cleared as a
 *   fabrication.
 * @param {Set<string>|Array<string>} [options.validSourceDates]
 *   The dates the model was shown for the source notes. When supplied, a
 *   cited source_date outside this set is cleared as a fabrication — so a
 *   met/partial claim cannot be anchored on an invented date. A criterion
 *   left with no surviving anchor is downgraded to "no_evidence". Omit
 *   either set to skip that validation (parser stays usable with only
 *   static data, e.g. in tests).
 * @param {Object<string,string>|Map<string,string>} [options.sourceTextById]
 *   description_id → the note's prose (HTML stripped). When supplied, a
 *   met/partial quote that doesn't overlap the cited note's text is
 *   downgraded (guard #3). Omit to skip grounding.
 * @param {Object<string,string>|Map<string,string>} [options.sourceTextByDate]
 *   description_date → the note prose for that date (notes sharing a date
 *   concatenated). Used to ground a claim anchored only by date.
 * @returns {object} normalized forecast JSON.
 */
export function parseForecastJsonResponse(rawText, options = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    const err = new Error('Claude returned an empty forecast response.');
    err.code = 'FORECAST_JSON_EMPTY';
    throw err;
  }

  let body = rawText.trim();

  // Strip markdown code fences if present.
  const fenceMatch = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) body = fenceMatch[1].trim();

  // Extract the JSON object if surrounded by prose.
  const first = body.indexOf('{');
  const last  = body.lastIndexOf('}');
  if (first >= 0 && last > first) body = body.slice(first, last + 1);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    const err = new Error(`Forecast JSON parse failed: ${e.message}`);
    err.code = 'FORECAST_JSON_INVALID';
    throw err;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('Forecast response is not a JSON object.');
    err.code = 'FORECAST_JSON_SCHEMA';
    throw err;
  }

  const toSet = (v) => v instanceof Set
    ? v
    : Array.isArray(v) ? new Set(v.map(String)) : null;
  const toMap = (v) => {
    if (v instanceof Map) return v;
    if (v && typeof v === 'object') return new Map(Object.entries(v).map(([k, val]) => [String(k), String(val)]));
    return null;
  };
  const sourceTexts = (toMap(options.sourceTextById) || toMap(options.sourceTextByDate))
    ? { byId: toMap(options.sourceTextById), byDate: toMap(options.sourceTextByDate) }
    : null;
  const anchors = {
    validSourceIds:   toSet(options.validSourceIds),
    validSourceDates: toSet(options.validSourceDates),
    sourceTexts,
  };

  // ── Top-level scalars ────────────────────────────────────────────
  const out = {};
  out.opportunity_id = cleanStr(parsed.opportunity_id);
  out.customer_name  = cleanStr(parsed.customer_name);
  out.summary        = cleanStr(parsed.summary);

  // current_stage_id must be a real stage id; anything else collapses to
  // "unknown" so downstream never trusts an invented stage.
  const stageId = cleanStr(parsed.current_stage_id);
  out.current_stage_id = getStageById(stageId) ? stageId : '';

  out.current_stage_confidence = VALID_CONFIDENCE.has(cleanStr(parsed.current_stage_confidence).toLowerCase())
    ? cleanStr(parsed.current_stage_confidence).toLowerCase()
    : 'low';

  // forecast_bucket + probability are DERIVED from current_stage_id, never
  // taken from the model — that keeps them internally consistent and stops
  // a confident-but-wrong probability from leaking through.
  out.forecast_bucket = out.current_stage_id ? getBucketForStageId(out.current_stage_id) : '';
  out.probability     = out.current_stage_id ? getProbabilityForStageId(out.current_stage_id) : null;

  // ── Stages ───────────────────────────────────────────────────────
  const seenStages = new Set();
  out.stages = Array.isArray(parsed.stages)
    ? parsed.stages
        .filter(s => s && typeof s === 'object')
        .map(s => normalizeStage(s, anchors))
        .filter(s => s && s.stage_id && !seenStages.has(s.stage_id) && seenStages.add(s.stage_id))
    : [];

  // ── Lists ────────────────────────────────────────────────────────
  out.gaps           = cleanStrArray(parsed.gaps);
  out.open_questions = cleanStrArray(parsed.open_questions);

  return out;
}

function normalizeStage(rawStage, anchors) {
  const stageId = cleanStr(rawStage.stage_id);
  // Drop stages whose id isn't one of the seven — no inventing rows.
  if (!getStageById(stageId)) return null;

  const status = VALID_STAGE_STATUSES.has(cleanStr(rawStage.status).toLowerCase())
    ? cleanStr(rawStage.status).toLowerCase()
    : 'not_started';

  const seenCriteria = new Set();
  const criteria = Array.isArray(rawStage.criteria)
    ? rawStage.criteria
        .filter(c => c && typeof c === 'object')
        .map(c => normalizeCriterion(c, stageId, anchors))
        .filter(c => c && !seenCriteria.has(c.criterion_id) && seenCriteria.add(c.criterion_id))
    : [];

  return {
    stage_id: stageId,
    status,
    notes: cleanStr(rawStage.notes),
    criteria,
  };
}

function normalizeCriterion(rawCriterion, stageId, anchors = {}) {
  const criterionId = cleanStr(rawCriterion.criterion_id);

  // Drop unknown criterion ids, and drop criteria filed under the wrong
  // stage — both are signs the model wandered off the definitions.
  if (!CRITERION_IDS.has(criterionId)) return null;
  if (CRITERION_TO_STAGE[criterionId] !== stageId) return null;

  let status = VALID_CRITERION_STATUSES.has(cleanStr(rawCriterion.status).toLowerCase())
    ? cleanStr(rawCriterion.status).toLowerCase()
    : 'no_evidence';

  let evidence   = cleanStr(rawCriterion.evidence);
  let sourceDate = cleanStr(rawCriterion.source_date);
  let sourceId   = cleanStr(rawCriterion.source_id);

  const { validSourceIds, validSourceDates, sourceTexts } = anchors;

  // A cited source_id / source_date that doesn't correspond to a real note
  // is a fabrication — clear it. (Only enforced when we know the real
  // ids/dates.) Without validating the date too, a model could anchor a
  // "met" on an invented date and slip past the guard below.
  if (sourceId && validSourceIds && !validSourceIds.has(sourceId)) {
    sourceId = '';
  }
  if (sourceDate && validSourceDates && !validSourceDates.has(sourceDate)) {
    sourceDate = '';
  }

  // GOLDEN RULE enforcement: "met"/"partial" must be traceable. It needs a
  // non-empty evidence quote AND at least one SURVIVING anchor (a source
  // id or date that matched a real note). Otherwise it is an unsupported
  // claim → downgrade to "no_evidence" and clear the source fields.
  if (CLAIMED_STATUSES.has(status)) {
    const hasAnchor = !!sourceId || !!sourceDate;
    if (!evidence || !hasAnchor) {
      status = 'no_evidence';
    } else {
      // Guard #3 — evidence grounding: a real anchor isn't enough; the
      // quote must actually come from that note. When we have the cited
      // note's text and the quote doesn't overlap it, the quote was
      // invented on top of a real note → downgrade.
      const noteText = resolveAnchorText(sourceId, sourceDate, sourceTexts);
      if (noteText != null && !isEvidenceGrounded(evidence, noteText)) {
        status = 'no_evidence';
      }
    }
  }

  // "no_evidence" means the notes are silent — it carries no payload.
  // "not_met" is a negative claim ("a note says this hasn't happened") and
  // may legitimately cite that note, so its evidence is preserved.
  if (status === 'no_evidence') {
    evidence = '';
    sourceDate = '';
    sourceId = '';
  }

  return {
    criterion_id: criterionId,
    status,
    evidence,
    source_date: sourceDate,
    source_id: sourceId,
  };
}
