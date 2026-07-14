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
