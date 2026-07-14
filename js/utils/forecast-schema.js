// ============================================================
// Forecast JSON schema — shared between prompt builder and parser
// ============================================================
// Mirrors the timeline-pdf-schema.js pattern: a single example string
// shown to the model, plus a strict parser that strips fences, extracts
// the JSON, validates every field, drops anything malformed, and coerces
// bad values to safe defaults.
//
// The parser is where the GOLDEN RULE is *enforced* rather than merely
// requested. Two guards matter most:
//   1. Unknown stage_id / criterion_id values are dropped — the model
//      cannot invent a criterion that isn't in the stage definitions.
//   2. A criterion cannot be "met" or "partial" without a real,
//      traceable anchor: a non-empty evidence quote AND either a known
//      source note id or a source date. Anything that fails that test is
//      downgraded to "no_evidence" with its source fields cleared. An
//      invented checkmark with no evidence never survives parsing.
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
  "current_stage_id": "string — the id of the furthest stage whose criteria are all met",
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
 *   supplied, a met/partial criterion whose evidence cannot be tied to a
 *   real note (no known source_id and no source_date) is downgraded to
 *   "no_evidence". Omit to skip source-id validation (parser stays usable
 *   with only static data, e.g. in tests).
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

  const validSourceIds = options.validSourceIds instanceof Set
    ? options.validSourceIds
    : Array.isArray(options.validSourceIds)
      ? new Set(options.validSourceIds.map(String))
      : null;

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
        .map(s => normalizeStage(s, validSourceIds))
        .filter(s => s && s.stage_id && !seenStages.has(s.stage_id) && seenStages.add(s.stage_id))
    : [];

  // ── Lists ────────────────────────────────────────────────────────
  out.gaps           = cleanStrArray(parsed.gaps);
  out.open_questions = cleanStrArray(parsed.open_questions);

  return out;
}

function normalizeStage(rawStage, validSourceIds) {
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
        .map(c => normalizeCriterion(c, stageId, validSourceIds))
        .filter(c => c && !seenCriteria.has(c.criterion_id) && seenCriteria.add(c.criterion_id))
    : [];

  return {
    stage_id: stageId,
    status,
    notes: cleanStr(rawStage.notes),
    criteria,
  };
}

function normalizeCriterion(rawCriterion, stageId, validSourceIds) {
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

  // A cited source_id that doesn't correspond to a real note is a
  // fabrication — clear it. (Only enforced when we know the real ids.)
  if (sourceId && validSourceIds && !validSourceIds.has(sourceId)) {
    sourceId = '';
  }

  // GOLDEN RULE enforcement: "met"/"partial" must be traceable. It needs a
  // non-empty evidence quote AND at least one real anchor (a known source
  // id or a source date). Otherwise it is an unsupported claim → downgrade
  // to "no_evidence" and clear the source fields.
  if (CLAIMED_STATUSES.has(status)) {
    const hasAnchor = !!sourceId || !!sourceDate;
    if (!evidence || !hasAnchor) {
      status = 'no_evidence';
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
