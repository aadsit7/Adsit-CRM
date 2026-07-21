// ============================================================
// Event analysis JSON schema — shared between prompt builder and parser
// ============================================================
// Parallels forecast-schema.js: one example string shown to the model,
// plus a strict parser that strips fences, extracts the JSON, validates
// every field, drops anything malformed, and coerces bad values to safe
// defaults. The parser — NOT the model — enforces correctness.
//
// The event lifecycle has five kinds of evidence source, each validated
// differently:
//   • event_description — a saved Event_Descriptions note. Held to the
//     full GOLDEN RULE bar: a met/partial needs a non-empty quote AND a
//     real anchor (a source id or date matching an actual note), AND the
//     quote must overlap the cited note's prose (grounding). A fabricated
//     quote — even one pinned to a real note — is downgraded.
//   • event_metadata / event_contacts / linked_opportunities — DETERMINISTIC
//     structured facts. The model is never trusted to interpret counts; a
//     claim on one of these survives only if the fact supplied to the parser
//     supports it, and the hard facts are OVERLAID after parsing so obvious
//     counts (a scheduled date, linked opportunities, closed-won deals) are
//     always reflected regardless of what the model said.
//   • saved_playbook — a manually-checked activity from the saved
//     Event_Playbook state. Valid operational confirmation, but distinct
//     from note-backed evidence: it needs a real matching checked activity,
//     never a manufactured quote, and is labelled "Saved playbook".
//
// Stage status, the current lifecycle position and the completion
// percentage are always RECOMPUTED from the validated activities — the
// model's self-reported stage claims are never trusted when they conflict.
//
// IMPORTANT: no forecast buckets, no win probabilities. Event execution is
// a checklist, not a sales pipeline.
// ============================================================

import {
  EVENT_STAGES,
  ACTIVITY_IDS,
  ACTIVITY_TO_STAGE,
  getEventStageById,
  stageStatusFromActivities,
} from './event-analyzer-stages.js';

export const EVENT_ANALYZER_SCHEMA_EXAMPLE = `{
  "event_id": "string — echo back the ID given",
  "event_title": "string",
  "current_stage_id": "string — the first stage in lifecycle order that is NOT complete (recomputed by the app; you may estimate)",
  "current_stage_confidence": "high | medium | low",
  "summary": "string — 2-3 sentences on where this event's execution actually stands",
  "stages": [
    {
      "stage_id": "string — must exactly match a stage id from the stage definitions",
      "status": "complete | in_progress | not_started",
      "notes": "string — 1-3 sentences on this stage. Empty string if no evidence.",
      "activities": [
        {
          "activity_id": "string — must exactly match an id from the stage definitions",
          "status": "met | partial | not_met | no_evidence",
          "evidence": "string — a short quote or close paraphrase from ONE source. Empty string if no_evidence or a manual saved-playbook check.",
          "source_type": "event_description | event_metadata | event_contacts | linked_opportunities | saved_playbook | none",
          "source_id": "string — the description_id / event_id the evidence came from. Empty string if none.",
          "source_date": "string — the date of the cited source. Empty string if none."
        }
      ]
    }
  ],
  "next_actions": ["string — the most useful next steps to advance the lifecycle"],
  "gaps": ["string — what is missing to complete the current stage"],
  "open_questions": ["string — questions the sources leave unanswered"]
}`;

const VALID_STAGE_STATUSES = new Set(['complete', 'in_progress', 'not_started']);
const VALID_ACTIVITY_STATUSES = new Set(['met', 'partial', 'not_met', 'no_evidence']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
const VALID_SOURCE_TYPES = new Set([
  'event_description', 'event_metadata', 'event_contacts',
  'linked_opportunities', 'saved_playbook', 'none',
]);

// Source types whose claims are DETERMINISTIC structured facts — never
// trusted from the model on their own; they need a supporting fact.
const STRUCTURED_SOURCE_TYPES = new Set(['event_metadata', 'event_contacts', 'linked_opportunities']);

// Statuses that assert an activity is (at least partly) satisfied and so
// must be backed by a real, validated source.
const CLAIMED_STATUSES = new Set(['met', 'partial']);

// ── Evidence grounding (event_description guard) ────────────────────
// Same tolerant-overlap approach as forecast-schema.js: the evidence must
// share a strong majority of its content words with the cited note's prose.
// Tolerates a close paraphrase; rejects a quote invented on a real note.
const EVIDENCE_GROUNDING_MIN_OVERLAP = 0.5;

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
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !GROUNDING_STOPWORDS.has(w));
}

function isEvidenceGrounded(evidence, noteText) {
  const evWords = [...new Set(groundingTokens(evidence))];
  if (evWords.length === 0) return true;
  const noteSet = new Set(groundingTokens(noteText));
  if (noteSet.size === 0) return true;
  let hits = 0;
  for (const w of evWords) if (noteSet.has(w)) hits += 1;
  return (hits / evWords.length) >= EVIDENCE_GROUNDING_MIN_OVERLAP;
}

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

function toSet(v) {
  if (v instanceof Set) return v;
  return Array.isArray(v) ? new Set(v.map(String)) : null;
}

function toMap(v) {
  if (v instanceof Map) return v;
  if (v && typeof v === 'object') return new Map(Object.entries(v).map(([k, val]) => [String(k), String(val)]));
  return null;
}

// A fresh no_evidence activity result (the safe default for every slot).
function emptyActivity(activityId) {
  return {
    activity_id: activityId,
    status: 'no_evidence',
    evidence: '',
    source_type: 'none',
    source_id: '',
    source_date: '',
    manual: false,
  };
}

/**
 * Parse and validate Claude's raw text response into an event-analysis object.
 *
 * @param {string} rawText  The model's message text.
 * @param {object} [options]
 * @param {string} [options.eventId]     Echoed into event_id when the model omits it.
 * @param {string} [options.eventTitle]  Echoed into event_title when the model omits it.
 * @param {Set<string>|Array<string>} [options.validSourceIds]   Real Event_Descriptions ids.
 * @param {Set<string>|Array<string>} [options.validSourceDates] Real note dates.
 * @param {Object|Map} [options.sourceTextById]   description_id → note prose (for grounding).
 * @param {Object|Map} [options.sourceTextByDate] date → note prose (for grounding).
 * @param {object} [options.facts]  Deterministic/structured facts supplied to the parser:
 *   { deterministic: { [activityId]: { status, source_type, evidence, source_id, source_date } },
 *     structuredSupport: { [activityId]: true },
 *     savedChecked: { [activityId]: { date } } }
 * @returns {object} normalized event-analysis JSON (canonical 7×3 board).
 */
export function parseEventAnalysisResponse(rawText, options = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    const err = new Error('Claude returned an empty event-analysis response.');
    err.code = 'EVENT_JSON_EMPTY';
    throw err;
  }

  let body = rawText.trim();

  const fenceMatch = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) body = fenceMatch[1].trim();

  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) body = body.slice(first, last + 1);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    const err = new Error(`Event-analysis JSON parse failed: ${e.message}`);
    err.code = 'EVENT_JSON_INVALID';
    throw err;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('Event-analysis response is not a JSON object.');
    err.code = 'EVENT_JSON_SCHEMA';
    throw err;
  }

  const anchors = {
    validSourceIds: toSet(options.validSourceIds),
    validSourceDates: toSet(options.validSourceDates),
    sourceTexts: (toMap(options.sourceTextById) || toMap(options.sourceTextByDate))
      ? { byId: toMap(options.sourceTextById), byDate: toMap(options.sourceTextByDate) }
      : null,
  };

  const facts = options.facts || {};
  const deterministic = (facts.deterministic && typeof facts.deterministic === 'object') ? facts.deterministic : {};
  const structuredSupport = (facts.structuredSupport && typeof facts.structuredSupport === 'object') ? facts.structuredSupport : {};
  const savedChecked = (facts.savedChecked && typeof facts.savedChecked === 'object') ? facts.savedChecked : {};

  // ── Validate the model's per-activity claims into a working map ─────
  // activityId → validated result. Unknown ids, wrong-stage placements and
  // duplicates never enter the map (first valid claim wins).
  const validated = new Map();
  const seenStages = new Set();
  const stageNotes = new Map();

  if (Array.isArray(parsed.stages)) {
    for (const rawStage of parsed.stages) {
      if (!rawStage || typeof rawStage !== 'object') continue;
      const stageId = cleanStr(rawStage.stage_id);
      if (!getEventStageById(stageId)) continue;          // drop unknown stages
      if (seenStages.has(stageId)) continue;              // dedupe stages (first wins)
      seenStages.add(stageId);
      stageNotes.set(stageId, cleanStr(rawStage.notes));

      const acts = Array.isArray(rawStage.activities) ? rawStage.activities : [];
      for (const rawAct of acts) {
        if (!rawAct || typeof rawAct !== 'object') continue;
        const activityId = cleanStr(rawAct.activity_id);
        if (!ACTIVITY_IDS.has(activityId)) continue;      // drop unknown activities
        if (ACTIVITY_TO_STAGE[activityId] !== stageId) continue; // drop wrong-stage placement
        if (validated.has(activityId)) continue;          // dedupe activities (first wins)
        validated.set(activityId, validateActivity(activityId, rawAct, anchors, structuredSupport, savedChecked));
      }
    }
  }

  // ── Overlay saved-playbook manual checks ───────────────────────────
  // A checked activity is valid operational state. It fills any activity
  // the model didn't already establish as `met`, and is labelled a manual
  // confirmation (never a fabricated quote).
  for (const activityId of Object.keys(savedChecked)) {
    if (!ACTIVITY_IDS.has(activityId)) continue;
    const current = validated.get(activityId);
    if (current && current.status === 'met') continue; // stronger evidence already stands
    const info = savedChecked[activityId] || {};
    validated.set(activityId, {
      activity_id: activityId,
      status: 'met',
      evidence: '',
      source_type: 'saved_playbook',
      source_id: '',
      source_date: cleanStr(info.date),
      manual: true,
    });
  }

  // ── Overlay deterministic CRM facts (authoritative) ────────────────
  // Hard facts — a scheduled date, linked opportunities, closed-won deals —
  // override any model interpretation. Added AFTER parsing so obvious counts
  // are never left to the model.
  for (const activityId of Object.keys(deterministic)) {
    if (!ACTIVITY_IDS.has(activityId)) continue;
    const fact = deterministic[activityId] || {};
    const status = VALID_ACTIVITY_STATUSES.has(String(fact.status)) ? String(fact.status) : 'met';
    validated.set(activityId, {
      activity_id: activityId,
      status,
      evidence: cleanStr(fact.evidence),
      source_type: VALID_SOURCE_TYPES.has(String(fact.source_type)) ? String(fact.source_type) : 'event_metadata',
      source_id: cleanStr(fact.source_id),
      source_date: cleanStr(fact.source_date),
      manual: false,
    });
  }

  // ── Build the canonical 7×3 board with recomputed stage statuses ───
  const stages = EVENT_STAGES.map(stageDef => {
    const activities = stageDef.activities.map(actDef => validated.get(actDef.id) || emptyActivity(actDef.id));
    return {
      stage_id: stageDef.id,
      status: stageStatusFromActivities(activities),
      notes: stageNotes.get(stageDef.id) || '',
      activities,
    };
  });

  // ── Recompute lifecycle position + completion from the board ───────
  let currentStageId = '';
  let complete = true;
  for (const s of stages) {
    if (s.status !== 'complete') { currentStageId = s.stage_id; complete = false; break; }
  }
  const metCount = stages.reduce((n, s) => n + s.activities.filter(a => a.status === 'met').length, 0);
  const total = stages.reduce((n, s) => n + s.activities.length, 0);

  return {
    event_id: cleanStr(parsed.event_id) || cleanStr(options.eventId),
    event_title: cleanStr(parsed.event_title) || cleanStr(options.eventTitle),
    current_stage_id: currentStageId,
    current_stage_confidence: VALID_CONFIDENCE.has(cleanStr(parsed.current_stage_confidence).toLowerCase())
      ? cleanStr(parsed.current_stage_confidence).toLowerCase()
      : 'low',
    lifecycle_complete: complete,
    summary: cleanStr(parsed.summary),
    stages,
    next_actions: cleanStrArray(parsed.next_actions),
    gaps: cleanStrArray(parsed.gaps),
    open_questions: cleanStrArray(parsed.open_questions),
    completion: { met: metCount, total, pct: total > 0 ? Math.round((metCount / total) * 100) : 0 },
  };
}

// Validate one model activity claim into a normalized result, enforcing the
// per-source-type rules. Returns a full activity result object.
function validateActivity(activityId, rawAct, anchors, structuredSupport, savedChecked) {
  let status = VALID_ACTIVITY_STATUSES.has(cleanStr(rawAct.status).toLowerCase())
    ? cleanStr(rawAct.status).toLowerCase()
    : 'no_evidence';

  let evidence = cleanStr(rawAct.evidence);
  let sourceType = VALID_SOURCE_TYPES.has(cleanStr(rawAct.source_type).toLowerCase())
    ? cleanStr(rawAct.source_type).toLowerCase()
    : 'none';
  let sourceId = cleanStr(rawAct.source_id);
  let sourceDate = cleanStr(rawAct.source_date);

  const { validSourceIds, validSourceDates, sourceTexts } = anchors;

  const downgrade = () => {
    status = 'no_evidence';
    evidence = '';
    sourceType = 'none';
    sourceId = '';
    sourceDate = '';
  };

  if (CLAIMED_STATUSES.has(status)) {
    if (sourceType === 'event_description') {
      // GOLDEN RULE — note-backed evidence must be traceable + grounded.
      if (sourceId && validSourceIds && !validSourceIds.has(sourceId)) sourceId = '';
      if (sourceDate && validSourceDates && !validSourceDates.has(sourceDate)) sourceDate = '';
      const hasAnchor = !!sourceId || !!sourceDate;
      if (!evidence || !hasAnchor) {
        downgrade();
      } else {
        const noteText = resolveAnchorText(sourceId, sourceDate, sourceTexts);
        if (noteText != null && !isEvidenceGrounded(evidence, noteText)) downgrade();
      }
    } else if (STRUCTURED_SOURCE_TYPES.has(sourceType)) {
      // Deterministic structured claim — trusted only if a supplied fact
      // supports it. (Hard facts are overlaid separately after parsing.)
      if (!structuredSupport[activityId]) downgrade();
    } else if (sourceType === 'saved_playbook') {
      // Manual confirmation — needs a real matching checked activity; a quote
      // is never manufactured for a checkbox.
      if (!savedChecked[activityId]) {
        downgrade();
      } else {
        evidence = '';
        sourceId = '';
        sourceDate = cleanStr((savedChecked[activityId] || {}).date) || sourceDate;
      }
    } else {
      // sourceType 'none' (or unresolved) can never back a claim.
      downgrade();
    }
  }

  // not_met keeps its (negative) citation; no_evidence carries no payload.
  if (status === 'no_evidence') {
    evidence = '';
    sourceType = 'none';
    sourceId = '';
    sourceDate = '';
  }

  return {
    activity_id: activityId,
    status,
    evidence,
    source_type: sourceType,
    source_id: sourceId,
    source_date: sourceDate,
    manual: sourceType === 'saved_playbook',
  };
}
