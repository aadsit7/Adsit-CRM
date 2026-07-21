// ============================================================
// Partner Maturity model — the single source of truth
// ============================================================
// A NEW Partner Maturity framework for the Analyzer's Partner mode. It is
// the partner-relationship analogue of the sales Forecast board
// (forecast-stages.js) and the Event lifecycle board
// (event-analyzer-stages.js): seven ordered stages, each with exactly three
// criteria, for 21 criteria total. Every stage and criterion carries a
// stable, globally-unique machine id so the model, the strict parser, the
// view, the PDF and the tests all refer to the same thing.
//
// IMPORTANT — this framework does NOT exist as a persisted playbook in the
// CRM. There is no Google Sheet and no Apps Script that stores these
// definitions; they live here, as a pure tested JavaScript module, exactly
// like the Opportunity and Event stage modules. See docs/PARTNER_ANALYZER.md
// for the product write-up.
//
// IMPORTANT — the Partners sheet's `tier` (Registered / Value·Preferred /
// Premier·Strategic) and `status` (engaged / active / inactive) are CRM
// classifications, NOT maturity stages. Nothing in this module derives a
// maturity stage from tier, status, account age, or the mere existence of
// later-stage activity. Maturity is scored ONLY from validated evidence.
//
// Pure data + pure functions. No DOM, no network.
// ============================================================

/**
 * The seven Partner Maturity stages, in order. Each stage has a stable
 * `id`, a display `name`, a short `summary` of what it represents, and
 * exactly three `criteria`. Each criterion has a stable, globally-unique
 * `id` and a human `label` — the checkable items Randy scores from evidence.
 *
 * Source of truth: this module (a new Partner Maturity model — see the file
 * header). The criterion ids MUST NOT be renamed: the model contract, the
 * parser, the view and the tests are all keyed on them.
 */
export const PARTNER_STAGES = [
  {
    id: 'profile_fit',
    name: 'Profile & Fit',
    summary: 'The partner is documented and the strategic rationale for the relationship is clear.',
    criteria: [
      { id: 'partner_profile_complete', label: 'Partner type, region, headquarters/location, and core account information are sufficiently documented' },
      { id: 'strategic_fit_defined',    label: 'The relationship’s strategic rationale, target market, relevant use cases, or joint value proposition is documented' },
      { id: 'key_stakeholders_identified', label: 'Relevant partner stakeholders and Recast relationship owners are identified in transcripts, meetings, documents, or structured CRM records' },
    ],
  },
  {
    id: 'relationship_alignment',
    name: 'Relationship & Alignment',
    summary: 'A working relationship exists with shared goals and a forward cadence.',
    criteria: [
      { id: 'relationship_established', label: 'At least one substantive partner conversation or meeting is documented' },
      { id: 'goals_priorities_aligned', label: 'Shared goals, priorities, desired outcomes, or areas of collaboration are explicitly documented' },
      { id: 'cadence_next_steps',       label: 'A follow-up cadence, scheduled next meeting, or concrete relationship next step is documented' },
    ],
  },
  {
    id: 'enablement_readiness',
    name: 'Enablement & Readiness',
    summary: 'The partner is being enabled to position, validate and sell the solution.',
    criteria: [
      { id: 'solution_enablement', label: 'Product, solution, or sales enablement has been delivered or is underway' },
      { id: 'technical_readiness', label: 'Technical training, certification, solution validation, or delivery readiness is evidenced' },
      { id: 'sales_readiness',     label: 'The partner has documented positioning, qualification guidance, sales materials, or the ability to identify and progress appropriate use cases' },
    ],
  },
  {
    id: 'joint_gtm',
    name: 'Joint Go-to-Market Planning',
    summary: 'A concrete joint go-to-market plan exists with a target market and value proposition.',
    criteria: [
      { id: 'target_market_defined',    label: 'Target accounts, segments, industries, territories, or buyer profiles are explicitly defined' },
      { id: 'joint_value_proposition',  label: 'A joint value proposition, messaging framework, campaign theme, or “Why Change / Why Now / Why Us” narrative is documented' },
      { id: 'gtm_plan_owned',           label: 'A concrete joint plan exists with activities, owners, dates, or agreed next steps' },
    ],
  },
  {
    id: 'market_engagement',
    name: 'Market Engagement',
    summary: 'Joint market-facing activity has launched and generated audience response and follow-up.',
    criteria: [
      { id: 'joint_activity_launched', label: 'At least one partner-specific event, campaign, webinar, workshop, or other market-facing activity has been launched or completed' },
      { id: 'audience_engaged',        label: 'There is evidence of target contacts, registrations, attendance, engagement, meetings, or other response to joint activity' },
      { id: 'follow_up_executed',      label: 'Post-event or post-campaign follow-up, lead assignment, outreach, or meeting conversion is evidenced' },
    ],
  },
  {
    id: 'pipeline_execution',
    name: 'Pipeline Execution',
    summary: 'Real, active pipeline is linked to the partner and is progressing.',
    criteria: [
      { id: 'opportunities_created', label: 'One or more real Opportunities rows are linked to this partner' },
      { id: 'active_pipeline',       label: 'At least one linked opportunity is genuinely active, and the deterministic pipeline total is greater than zero' },
      { id: 'deal_progression',      label: 'Evidence shows linked opportunities progressing through meaningful sales stages, with recent notes, meetings, or next steps' },
    ],
  },
  {
    id: 'revenue_growth',
    name: 'Revenue & Growth',
    summary: 'Revenue has been won and there is a repeatable, growing motion.',
    criteria: [
      { id: 'revenue_won',        label: 'At least one linked opportunity is explicitly closed won' },
      { id: 'repeatable_motion',  label: 'Evidence shows repeat activity: multiple opportunities, multiple joint activities, repeatable sourcing, or a documented repeatable sales/GTM motion' },
      { id: 'growth_plan',        label: 'Expansion goals, investment plans, future pipeline targets, tier-development goals, or a documented growth plan exists' },
    ],
  },
];

/** Total number of criteria across the whole framework (always 21). */
export const TOTAL_CRITERIA = PARTNER_STAGES.reduce((n, s) => n + s.criteria.length, 0);

/** Look up a stage definition by its id. Returns null if not found. */
export function getPartnerStageById(stageId) {
  return PARTNER_STAGES.find(s => s.id === stageId) || null;
}

/** 1-based position of a stage in the framework (1..7), or -1 if unknown. */
export function getPartnerStageIndex(stageId) {
  const idx = PARTNER_STAGES.findIndex(s => s.id === stageId);
  return idx < 0 ? -1 : idx + 1;
}

/** Every criterion id across all stages, flattened, in stage order. */
export function allCriterionIds() {
  return PARTNER_STAGES.flatMap(s => s.criteria.map(c => c.id));
}

/** Set of every valid criterion id — for fast membership checks. */
export const CRITERION_IDS = new Set(allCriterionIds());

/** Map of criterion id → its owning stage id. */
export const CRITERION_TO_STAGE = PARTNER_STAGES.reduce((acc, stage) => {
  stage.criteria.forEach(c => { acc[c.id] = stage.id; });
  return acc;
}, {});

/** Map of criterion id → its definition ({ id, label }). */
export const CRITERION_BY_ID = PARTNER_STAGES.reduce((acc, stage) => {
  stage.criteria.forEach(c => { acc[c.id] = c; });
  return acc;
}, {});

// ── Board derivation ────────────────────────────────────────────────
// Maturity derivation rules (from the framework, NOT from CRM tier/status):
//   • A criterion counts as complete ONLY when its validated status is `met`.
//   • `partial` indicates progress but never counts as complete.
//   • A stage is `complete` only when all three criteria are `met`.
//   • A stage is `in_progress` when one or more criteria are `met` or
//     `partial`, but not all are `met`.
//   • Otherwise the stage is `not_started`.
//   • The OPERATIONAL maturity stage is the FIRST ordered stage that is not
//     complete. Later-stage achievements are still displayed, but they never
//     conceal an unfinished earlier stage.
//   • The FURTHEST DEMONSTRATED stage is the furthest stage that contains at
//     least one validated `met` criterion — computed independently, so a
//     partner can demonstrate later-stage behavior despite earlier gaps.
//   • If every stage is complete, the partner is reported as
//     "Revenue & Growth — Mature".
//   • Completion % = validated met criteria / 21 × 100. `partial` never
//     counts.

/**
 * Compute a stage's status from its criteria's statuses.
 * @param {Array<{status:string}>} criteria
 * @returns {'complete'|'in_progress'|'not_started'}
 */
export function stageStatusFromCriteria(criteria) {
  const list = criteria || [];
  if (list.length === 0) return 'not_started';
  const metCount = list.filter(c => c.status === 'met').length;
  const claimedCount = list.filter(c => c.status === 'met' || c.status === 'partial').length;
  if (metCount === list.length) return 'complete';
  if (claimedCount > 0) return 'in_progress';
  return 'not_started';
}

/**
 * Derive the visual maturity board from a validated partner-analysis object.
 * This is the SINGLE SOURCE OF TRUTH shared by the Analyzer DOM render and
 * the Analyzer PDF export, so the two can never drift apart.
 *
 * Statuses are computed from the PARSER-VALIDATED criteria, never from the
 * model's self-reported stage status — so nothing on the board can be more
 * advanced than the evidence that survived parsing.
 *
 * @param {object} analysis  Parsed partner analysis (see partner-analyzer-schema.js).
 * @returns {{
 *   stages: Array<{ def, index, status, criteria, notes, metCount, partialCount }>,
 *   operationalIndex: number,          // first stage NOT complete (0-based); -1 if all complete
 *   furthestDemonstratedIndex: number, // furthest stage with >=1 met criterion (0-based); -1 if none
 *   lastCompleteIndex: number,         // furthest fully-complete stage (0-based); -1 if none
 *   workingIndex: number,              // furthest stage with any progress (0-based); -1 if none
 *   complete: boolean,                 // every stage complete
 *   metCount: number,                  // total met criteria
 *   totalCriteria: number,             // always 21
 *   completionPct: number              // 0..100, met / 21
 * }}
 */
export function derivePartnerBoard(analysis) {
  const stageResults = new Map(((analysis && analysis.stages) || []).map(s => [s.stage_id, s]));

  const stages = PARTNER_STAGES.map((stageDef, i) => {
    const res = stageResults.get(stageDef.id);
    const critResults = new Map(((res && res.criteria) || []).map(c => [c.criterion_id, c]));

    const criteria = stageDef.criteria.map(def => {
      const cr = critResults.get(def.id);
      return {
        id: def.id,
        label: def.label,
        status: cr ? cr.status : 'no_evidence',
        evidence: cr ? (cr.evidence || '') : '',
        source_type: cr ? (cr.source_type || 'none') : 'none',
        source_id: cr ? (cr.source_id || '') : '',
        source_date: cr ? (cr.source_date || '') : '',
        related_entity_id: cr ? (cr.related_entity_id || '') : '',
      };
    });

    const metCount = criteria.filter(c => c.status === 'met').length;
    const partialCount = criteria.filter(c => c.status === 'partial').length;
    const status = stageStatusFromCriteria(criteria);

    return { def: stageDef, index: i, status, criteria, notes: (res && res.notes) || '', metCount, partialCount };
  });

  let lastCompleteIndex = -1;
  let workingIndex = -1;
  let furthestDemonstratedIndex = -1;
  let operationalIndex = -1;
  stages.forEach((s, i) => {
    if (s.status === 'complete') lastCompleteIndex = i;
    if (s.status !== 'not_started') workingIndex = i;
    if (s.metCount > 0) furthestDemonstratedIndex = i;
    // First stage that is NOT complete is the operational maturity stage.
    if (operationalIndex === -1 && s.status !== 'complete') operationalIndex = i;
  });

  const metCount = stages.reduce((n, s) => n + s.metCount, 0);
  const complete = operationalIndex === -1;
  const completionPct = TOTAL_CRITERIA > 0 ? Math.round((metCount / TOTAL_CRITERIA) * 100) : 0;

  return {
    stages,
    operationalIndex,
    furthestDemonstratedIndex,
    lastCompleteIndex,
    workingIndex,
    complete,
    metCount,
    totalCriteria: TOTAL_CRITERIA,
    completionPct,
  };
}

/**
 * Resolve the operational maturity position — the headline the Analyzer
 * summary and the PDF both show. This is the FIRST-INCOMPLETE stage
 * (board.operationalIndex). When every stage is complete the partner is
 * reported as mature (position = the last stage, Revenue & Growth).
 *
 * @param {object} board  Result of derivePartnerBoard().
 * @returns {{ def: object|null, index: number, complete: boolean, started: boolean, mature: boolean }}
 */
export function resolvePartnerPosition(board) {
  if (!board) return { def: null, index: -1, complete: false, started: false, mature: false };
  const started = board.workingIndex >= 0;
  if (board.complete) {
    const lastIdx = PARTNER_STAGES.length - 1;
    return { def: PARTNER_STAGES[lastIdx], index: lastIdx, complete: true, started, mature: true };
  }
  const idx = board.operationalIndex >= 0 ? board.operationalIndex : 0;
  return { def: PARTNER_STAGES[idx] || null, index: idx, complete: false, started, mature: false };
}

/**
 * Resolve the FURTHEST DEMONSTRATED maturity position — the furthest stage
 * with at least one validated met criterion. Computed independently of the
 * operational position so the summary can state that the partner demonstrates
 * later-stage behavior even while earlier stages have gaps.
 *
 * @param {object} board  Result of derivePartnerBoard().
 * @returns {{ def: object|null, index: number }}
 */
export function resolveFurthestDemonstrated(board) {
  const idx = board ? board.furthestDemonstratedIndex : -1;
  if (idx < 0) return { def: null, index: -1 };
  return { def: PARTNER_STAGES[idx] || null, index: idx };
}
