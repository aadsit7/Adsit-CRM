// ============================================================
// Forecast stage model — the single source of truth
// ============================================================
// Transcribed from the sales-process whiteboard the Forecast tab is
// based on. This is a NEW, SEPARATE stage definition — it deliberately
// does NOT touch the six legacy CRM stages in admin-opportunities.js
// (Prospect · Qualified · Develop · Proposal · Negotiation · Closed).
// Renaming those would break the kanban board, the stage filter, the
// demo data, and every existing opportunity row. The Forecast tab reads
// from this file only; mapLegacyStage() bridges the two as a weak
// fallback hint when Randy finds no evidence at all.
//
// Note on branding: the source whiteboard was a Nintex template
// ("Why Nintex", "Nintex is the vendor of choice"). Those are swapped to
// Recast here — see the "vendor_of_choice" criterion and the "Why Recast"
// buying-process band.
//
// Pure data + pure functions. No DOM, no network.
// ============================================================

/**
 * The seven forecast stages, in order. Each stage has a stable `id`
 * (used everywhere as the key), a display `name`, its forecast `bucket`
 * and `probability`, and a list of exit criteria. Each criterion has a
 * stable `id` and a human `label` — the checkable items Randy scores.
 */
export const FORECAST_STAGES = [
  {
    id: 'inside_sales_working',
    name: 'Inside Sales Working',
    bucket: 'Demand Gen',
    probability: 0,
    criteria: [
      { id: 'icp_match',         label: 'Ideal customer profile match & buyer authority confirmed' },
      { id: 'pain_validated',    label: 'Buyer has validated that a business pain point exists and is interested in evaluating solutions' },
      { id: 'meeting_committed', label: 'Confirmed commitment to a meeting with sales' },
    ],
  },
  {
    id: 'sal',
    name: 'SAL (Inside Sales Qualified)',
    bucket: 'Demand Gen',
    probability: 0,
    criteria: [
      { id: 'pain_confirmed',     label: 'Initial pain has been confirmed' },
      { id: 'use_case_uncovered', label: 'Use case has been uncovered' },
      { id: 'next_steps_set',     label: 'Meaningful next steps are set (meeting on the calendar)' },
    ],
  },
  {
    id: 'identification',
    name: 'Identification',
    bucket: 'Pipeline',
    probability: 10,
    criteria: [
      { id: 'use_case_identified',  label: 'Initial project / use case has been identified' },
      { id: 'decision_criteria',    label: 'Buyer has communicated business objectives and outlined requirements' },
      { id: 'decision_makers',      label: 'Key decision makers have been identified' },
      { id: 'compelling_event_map', label: 'Compelling event + Mutual Action Plan created with the prospect' },
    ],
  },
  {
    id: 'qualification',
    name: 'Qualification',
    bucket: 'Pipeline',
    probability: 25,
    criteria: [
      { id: 'pain_impact',            label: 'Buyer has validated the business impact of solving the pain' },
      { id: 'tech_win',               label: 'Technical win completed with presales or partner' },
      { id: 'pricing_estimate',       label: 'A quote is synced to the opportunity' },
      { id: 'competitors_identified', label: 'Potential competitors identified' },
    ],
  },
  {
    id: 'development',
    name: 'Development',
    bucket: 'Best Case',
    probability: 50,
    criteria: [
      { id: 'compelling_event_linked', label: 'Business value / ROI linked to the compelling event' },
      { id: 'implementation_scope',    label: 'Decision team agrees the solution meets their need; presales has completed scope' },
      { id: 'vendor_of_choice',        label: 'Buyer verbally agrees Recast is the vendor of choice and budget is allocated' },
    ],
  },
  {
    id: 'proposal',
    name: 'Proposal',
    bucket: 'Best Case',
    probability: 75,
    criteria: [
      { id: 'legal_complete',    label: 'Legal review completed' },
      { id: 'security_complete', label: 'Security review completed' },
      { id: 'executable_quote',  label: 'Proposal review meeting completed and verbal agreement reached' },
    ],
  },
  {
    id: 'closing',
    name: 'Closing',
    bucket: 'Commit',
    probability: 90,
    criteria: [
      { id: 'signature_po', label: 'Signature and/or PO received; software fulfillment complete' },
      { id: 'onboarding',   label: 'Onboarding introductions made; primary customer stakeholder identified' },
    ],
  },
];

/**
 * The Customer Buying Process bands that render under the stage row,
 * each spanning a range of stages (1-based, inclusive). `points` are the
 * sub-themes printed inside the band.
 */
export const BUYING_PROCESS_BANDS = [
  {
    id: 'why_change',
    label: 'Why Change',
    startStage: 1,
    endStage: 3,
    points: ['Initial interest', 'Trends', 'Objections, challenges & insights'],
  },
  {
    id: 'why_now',
    label: 'Why Now',
    startStage: 3,
    endStage: 6,
    points: ['Project definition', 'Cost of delay', 'Business value', 'Personalization'],
  },
  {
    id: 'why_recast',
    label: 'Why Recast',
    startStage: 5,
    endStage: 7,
    points: ['Solution overview & decision', 'Recast differentiation', 'Success stories'],
  },
];

/**
 * The six legacy CRM stages, in progression order. Exported so callers
 * (and tests) can enumerate what mapLegacyStage() must cover.
 */
export const LEGACY_STAGES = ['Prospect', 'Qualified', 'Develop', 'Proposal', 'Negotiation', 'Closed'];

// Legacy → forecast stage id. Used ONLY as a fallback hint when the notes
// carry no evidence at all: the CRM stage field is a human's rough guess,
// not scored evidence, so it never overrides a criterion Randy actually
// found (or didn't find) in the notes.
const LEGACY_STAGE_MAP = {
  prospect:    'identification',
  qualified:   'qualification',
  develop:     'development',
  proposal:    'proposal',
  negotiation: 'closing',
  closed:      'closing',
};

/**
 * Map one of the six legacy CRM stages onto a forecast stage id.
 * Case-insensitive; returns '' for anything unrecognized.
 *
 * @param {string} legacyStage
 * @returns {string} a forecast stage id, or '' if unknown
 */
export function mapLegacyStage(legacyStage) {
  const key = String(legacyStage || '').trim().toLowerCase();
  return LEGACY_STAGE_MAP[key] || '';
}

/** Look up a stage definition by its id. Returns null if not found. */
export function getStageById(stageId) {
  return FORECAST_STAGES.find(s => s.id === stageId) || null;
}

/**
 * 1-based position of a stage in the row (1..7), or -1 if unknown.
 * Handy for the buying-process band spans and "furthest stage" logic.
 */
export function getStageIndex(stageId) {
  const idx = FORECAST_STAGES.findIndex(s => s.id === stageId);
  return idx < 0 ? -1 : idx + 1;
}

/** Every criterion id across all stages, flattened, in stage order. */
export function allCriterionIds() {
  return FORECAST_STAGES.flatMap(s => s.criteria.map(c => c.id));
}

/** Set of every valid criterion id — for fast membership checks. */
export const CRITERION_IDS = new Set(allCriterionIds());

/** Map of criterion id → its owning stage id. */
export const CRITERION_TO_STAGE = FORECAST_STAGES.reduce((acc, stage) => {
  stage.criteria.forEach(c => { acc[c.id] = stage.id; });
  return acc;
}, {});

/** Forecast bucket for a stage id (e.g. 'Pipeline'), or '' if unknown. */
export function getBucketForStageId(stageId) {
  const stage = getStageById(stageId);
  return stage ? stage.bucket : '';
}

/** Probability for a stage id (0..90), or null if unknown. */
export function getProbabilityForStageId(stageId) {
  const stage = getStageById(stageId);
  return stage ? stage.probability : null;
}

// ── Forecast position ───────────────────────────────────────────────
// The fraction of a stage's exit criteria that must be MET before the deal
// is considered to have "substantially reached" that stage for forecasting.
// Deliberately generous (half): the forecast should track the real depth of
// progress, not lag behind at the last stage whose every last checkbox was
// ticked. This is what fixes a deal that has cleared most of Development
// still reading as "Pipeline · 10%" just because one early checkbox is open.
export const SUBSTANTIAL_STAGE_RATIO = 0.5;

/**
 * Has the deal SUBSTANTIALLY reached this stage? True when the stage is fully
 * complete, or when at least SUBSTANTIAL_STAGE_RATIO of its exit criteria are
 * met. A lone stray checkmark far ahead (e.g. 1 of 4) stays below the bar, so
 * this reflects genuine depth of progress rather than over-forecasting.
 *
 * @param {{ criteria: Array, metCount: number, status: string }} stage
 *   A derived stage entry from deriveForecastBoard().
 */
export function isStageSubstantial(stage) {
  if (!stage) return false;
  const total = (stage.criteria || []).length;
  if (total === 0) return false;
  if (stage.status === 'complete') return true;
  return (stage.metCount || 0) / total >= SUBSTANTIAL_STAGE_RATIO;
}

// ── Board derivation ────────────────────────────────────────────────
/**
 * Derive the visual stage board from a validated forecast object. This is
 * the SINGLE SOURCE OF TRUTH shared by the Analyzer DOM render and the
 * Analyzer PDF export, so the two can never drift apart.
 *
 * The chevron colours and the current-stage header are computed from the
 * PARSER-VALIDATED criteria, not from the model's self-reported stage
 * status — so nothing on the board can be more advanced than the evidence
 * that survived parsing. A stage is "complete" only if every one of its
 * criteria is "met".
 *
 * @param {object} forecast  Parsed forecast JSON (see forecast-schema.js).
 * @returns {{ stages: Array, currentIndex: number, workingIndex: number, forecastIndex: number }}
 *   `stages` has one entry per FORECAST_STAGES definition, each shaped as
 *   `{ def, index, status, criteria, notes, metCount }`. `currentIndex` is
 *   the furthest fully-complete stage (-1 if none); `workingIndex` is the
 *   furthest stage with any progress (-1 if none); `forecastIndex` is the
 *   furthest stage the deal has SUBSTANTIALLY reached (-1 if none) — the one
 *   the "current position" headline and probability are read from.
 */
export function deriveForecastBoard(forecast) {
  const stageResults = new Map(((forecast && forecast.stages) || []).map(s => [s.stage_id, s]));

  const stages = FORECAST_STAGES.map((stageDef, i) => {
    const res = stageResults.get(stageDef.id);
    const critResults = new Map(((res && res.criteria) || []).map(c => [c.criterion_id, c]));

    const criteria = stageDef.criteria.map(def => {
      const cr = critResults.get(def.id);
      return {
        id: def.id,
        label: def.label,
        status: cr ? cr.status : 'no_evidence',
        evidence: cr ? cr.evidence : '',
        source_date: cr ? cr.source_date : '',
        source_id: cr ? cr.source_id : '',
      };
    });

    const metCount = criteria.filter(c => c.status === 'met').length;
    const claimedCount = criteria.filter(c => c.status === 'met' || c.status === 'partial').length;
    let status = 'not_started';
    if (criteria.length > 0 && metCount === criteria.length) status = 'complete';
    else if (claimedCount > 0) status = 'in_progress';

    return { def: stageDef, index: i, status, criteria, notes: (res && res.notes) || '', metCount };
  });

  let currentIndex = -1;
  let workingIndex = -1;
  let forecastIndex = -1;
  stages.forEach((s, i) => {
    if (s.status === 'complete') currentIndex = i;
    if (s.status !== 'not_started') workingIndex = i;
    if (isStageSubstantial(s)) forecastIndex = i;
  });

  return { stages, currentIndex, workingIndex, forecastIndex };
}

/**
 * Resolve the single "current position" line the Analyzer summary and the
 * PDF both show, from a derived board and an optional manual stage override.
 *
 * The analyzed position is `forecastIndex` — the furthest stage the deal has
 * substantially reached — falling back to `workingIndex` when nothing is
 * substantial yet. Its probability is ALWAYS reported (an in-progress stage
 * no longer collapses to "—"), so the forecast reflects the stage the deal is
 * actively working, matching how the whiteboard buckets read. A manual
 * override, when it names a real stage, wins over the analysis (view-only).
 *
 * @param {object} board  Result of deriveForecastBoard().
 * @param {string} [overrideStageId]  A stage id the user picked manually.
 * @returns {{
 *   def: object|null, index: number, bucket: string, probability: number,
 *   complete: boolean, inProgress: boolean, source: 'override'|'analyzed'|'none'
 * }}
 */
export function resolveForecastPosition(board, overrideStageId = '') {
  const stages = (board && board.stages) || [];

  const at = (idx, source) => {
    const stage = stages[idx];
    if (!stage) return null;
    const complete = stage.status === 'complete';
    return {
      def: stage.def,
      index: idx,
      bucket: stage.def.bucket,
      probability: stage.def.probability,
      complete,
      inProgress: !complete,
      source,
    };
  };

  // A manual override wins, but only when it names a real stage on the board.
  if (overrideStageId) {
    const overrideIdx = getStageIndex(overrideStageId) - 1;
    const pos = overrideIdx >= 0 ? at(overrideIdx, 'override') : null;
    if (pos) return pos;
  }

  const analyzedIdx = (board && board.forecastIndex >= 0)
    ? board.forecastIndex
    : (board && board.workingIndex >= 0 ? board.workingIndex : -1);
  if (analyzedIdx < 0) {
    return { def: null, index: -1, bucket: '', probability: 0, complete: false, inProgress: false, source: 'none' };
  }
  return at(analyzedIdx, 'analyzed');
}

/**
 * Compare the analyzed forecast position against the stage a human filed the
 * deal in (the CRM "stage" field). The Analyzer surfaces a note when the two
 * disagree, so a rep sees when the evidence says the deal is further along (or
 * further back) than where it currently sits in the pipeline.
 *
 * @param {number} analyzedIndex  0-based index of the analyzed forecast stage (-1 if none).
 * @param {string} crmStage       The opportunity's legacy CRM stage string.
 * @returns {{ crmStageId: string, crmIndex: number, differs: boolean,
 *             direction: 'ahead'|'behind'|'same'|'unknown' }}
 *   `direction` is relative to the CRM stage: 'ahead' = analysis is further
 *   along, 'behind' = analysis is earlier. 'unknown' when either side is
 *   missing (blank CRM stage or no analyzed position).
 */
export function compareToCrmStage(analyzedIndex, crmStage) {
  const crmStageId = mapLegacyStage(crmStage);
  const crmIndex = crmStageId ? getStageIndex(crmStageId) - 1 : -1;
  if (analyzedIndex < 0 || crmIndex < 0) {
    return { crmStageId, crmIndex, differs: false, direction: 'unknown' };
  }
  if (analyzedIndex === crmIndex) {
    return { crmStageId, crmIndex, differs: false, direction: 'same' };
  }
  return {
    crmStageId,
    crmIndex,
    differs: true,
    direction: analyzedIndex > crmIndex ? 'ahead' : 'behind',
  };
}
