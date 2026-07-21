// ============================================================
// Event lifecycle model — the single source of truth
// ============================================================
// Transcribed from the standalone partner event playbook
// (`index (58).html`, the PB_STAGES_TEMPLATE constant — the business
// source of truth). Seven lifecycle stages, each with three activity
// rows, for 21 activities total. This is a NEW, SEPARATE definition that
// deliberately does NOT touch the sales-forecast stages in
// forecast-stages.js — the two analyzers are independent boards.
//
// Every stage and every activity carries a stable, machine-readable id so
// the model, the parser, the view, the PDF and the tests all refer to the
// same thing. The activity ids are derived from the standalone template's
// stage key + a short slug and MUST NOT be renamed — the saved
// Event_Playbook state and the model contract are keyed on them.
//
// IMPORTANT: unlike the sales forecast, the event lifecycle has NO
// forecast buckets and NO win probabilities. Event execution is a
// checklist of activities, not a pipeline — the parser and the view never
// surface a probability or a sales bucket in event mode.
//
// Pure data + pure functions. No DOM, no network.
// ============================================================

// Activity owner tags mirror the standalone: 'both' (Recast + partner),
// 'recast' (Recast-led), 'partner' (partner-led). The playbook template
// uses only 'both' and 'recast', but 'partner' is defined for completeness
// and so a saved row that carries it round-trips.
export const OWNER_BOTH = 'both';
export const OWNER_RECAST = 'recast';
export const OWNER_PARTNER = 'partner';

/**
 * The seven event lifecycle stages, in order. Each stage has a stable
 * `id` (the standalone template's `key`), a display `name`, its `timing`
 * hint, and exactly three `activities`. Each activity has a stable `id`,
 * the human `label` (verbatim from the standalone), and an `owner` tag.
 *
 * Source of truth: PB_STAGES_TEMPLATE in `index (58).html`.
 */
export const EVENT_STAGES = [
  {
    id: 'setup',
    name: 'Event',
    timing: '5–6 weeks out',
    activities: [
      { id: 'setup_topic', label: 'Event topic', owner: OWNER_BOTH },
      { id: 'setup_date', label: 'Date scheduled', owner: OWNER_BOTH },
      { id: 'setup_why', label: 'Why Change, Why Now, Why Us — outline the WHY', owner: OWNER_BOTH },
    ],
  },
  {
    id: 'audience',
    name: 'Audience',
    timing: '4–5 weeks out',
    activities: [
      { id: 'audience_upload', label: 'Upload target accounts and contacts', owner: OWNER_BOTH },
      { id: 'audience_roles', label: 'Identify buying roles and missing stakeholders', owner: OWNER_BOTH },
      { id: 'audience_owners', label: 'Assign account and contact owners', owner: OWNER_BOTH },
    ],
  },
  {
    id: 'messaging',
    name: 'Messaging',
    timing: '3–4 weeks out',
    activities: [
      { id: 'messaging_why', label: 'Define Why Change and Why Now', owner: OWNER_BOTH },
      { id: 'messaging_proof', label: 'Define Why Us and supporting proof', owner: OWNER_RECAST },
      { id: 'messaging_cta', label: 'Agree on the CTA and seller talk track', owner: OWNER_BOTH },
    ],
  },
  {
    id: 'drive',
    name: 'Drive Attendance',
    timing: '3 weeks through the day before',
    activities: [
      { id: 'drive_outreach', label: 'Launch marketing, SDR, AE, and partner outreach', owner: OWNER_BOTH },
      { id: 'drive_registrations', label: 'Track registrations and priority accounts', owner: OWNER_RECAST },
      { id: 'drive_booking', label: 'Confirm meeting booking availability', owner: OWNER_RECAST },
    ],
  },
  {
    id: 'eventday',
    name: 'Event Day',
    timing: 'The event dates',
    activities: [
      { id: 'eventday_dryrun', label: 'Finalize presentation and dry run', owner: OWNER_BOTH },
      { id: 'eventday_deliver', label: 'Deliver the event and present the CTA', owner: OWNER_BOTH },
      { id: 'eventday_capture', label: 'Capture attendance and engagement', owner: OWNER_RECAST },
    ],
  },
  {
    id: 'followup',
    name: 'Follow-Up',
    timing: 'Within 1 week',
    activities: [
      { id: 'followup_segment', label: 'Segment attendees and no-shows', owner: OWNER_RECAST },
      { id: 'followup_owners', label: 'Assign follow-up owners', owner: OWNER_BOTH },
      { id: 'followup_outreach', label: 'Launch outreach and schedule meetings', owner: OWNER_BOTH },
    ],
  },
  {
    id: 'results',
    name: 'Results',
    timing: '1–2 months after',
    activities: [
      { id: 'results_meetings', label: 'Confirm meetings booked', owner: OWNER_RECAST },
      { id: 'results_opportunities', label: 'Confirm opportunities created', owner: OWNER_RECAST },
      { id: 'results_closed_won', label: 'Confirm closed-won deals', owner: OWNER_BOTH },
    ],
  },
];

/** Total number of activities across the whole lifecycle (always 21). */
export const TOTAL_ACTIVITIES = EVENT_STAGES.reduce((n, s) => n + s.activities.length, 0);

/** Look up a stage definition by its id. Returns null if not found. */
export function getEventStageById(stageId) {
  return EVENT_STAGES.find(s => s.id === stageId) || null;
}

/**
 * 1-based position of a stage in the lifecycle (1..7), or -1 if unknown.
 */
export function getEventStageIndex(stageId) {
  const idx = EVENT_STAGES.findIndex(s => s.id === stageId);
  return idx < 0 ? -1 : idx + 1;
}

/** Every activity id across all stages, flattened, in lifecycle order. */
export function allActivityIds() {
  return EVENT_STAGES.flatMap(s => s.activities.map(a => a.id));
}

/** Set of every valid activity id — for fast membership checks. */
export const ACTIVITY_IDS = new Set(allActivityIds());

/** Map of activity id → its owning stage id. */
export const ACTIVITY_TO_STAGE = EVENT_STAGES.reduce((acc, stage) => {
  stage.activities.forEach(a => { acc[a.id] = stage.id; });
  return acc;
}, {});

/** Map of activity id → its definition ({ id, label, owner }). */
export const ACTIVITY_BY_ID = EVENT_STAGES.reduce((acc, stage) => {
  stage.activities.forEach(a => { acc[a.id] = a; });
  return acc;
}, {});

/**
 * The activity id at a given (stage key, zero-based index) — used to map
 * the standalone saved-playbook `acts[i]` rows (which are positional) onto
 * stable activity ids. Returns '' when out of range.
 */
export function activityIdAt(stageId, index) {
  const stage = getEventStageById(stageId);
  if (!stage) return '';
  const act = stage.activities[Number(index)];
  return act ? act.id : '';
}

/** Human label for an owner tag. `partnerName` overrides the 'partner' label. */
export function ownerLabel(owner, partnerName) {
  if (owner === OWNER_RECAST) return 'Recast';
  if (owner === OWNER_PARTNER) return (partnerName && String(partnerName).trim()) || 'Partner';
  return 'Both';
}

// ── Board derivation ────────────────────────────────────────────────
// Event completion rules (from the playbook methodology, NOT the sales
// probability logic):
//   • An activity is COMPLETE only when its validated status is `met`.
//   • An activity is UNDERWAY when its validated status is `partial`.
//   • A stage is `complete` only when every activity is `met`.
//   • A stage is `in_progress` when at least one activity is `met` or
//     `partial`, but not all are `met`.
//   • Otherwise the stage is `not_started`.
//   • The OPERATIONAL current stage is the FIRST stage in lifecycle order
//     that is not complete (later-stage progress never hides an earlier
//     gap). If all stages are complete, the lifecycle is complete.
//   • Completion % = met activities / 21 × 100. Partial activities are
//     shown but never counted as complete.

/**
 * Compute a stage's status from its activities' statuses.
 * @param {Array<{status:string}>} activities
 * @returns {'complete'|'in_progress'|'not_started'}
 */
export function stageStatusFromActivities(activities) {
  const list = activities || [];
  if (list.length === 0) return 'not_started';
  const metCount = list.filter(a => a.status === 'met').length;
  const claimedCount = list.filter(a => a.status === 'met' || a.status === 'partial').length;
  if (metCount === list.length) return 'complete';
  if (claimedCount > 0) return 'in_progress';
  return 'not_started';
}

/**
 * Derive the visual lifecycle board from a validated event-analysis object.
 * This is the SINGLE SOURCE OF TRUTH shared by the Analyzer DOM render and
 * the Analyzer PDF export, so the two can never drift apart.
 *
 * Statuses are computed from the PARSER-VALIDATED activities, never from
 * the model's self-reported stage status — so nothing on the board can be
 * more advanced than the evidence that survived parsing.
 *
 * @param {object} analysis  Parsed event analysis (see event-analyzer-schema.js).
 * @returns {{
 *   stages: Array<{ def, index, status, activities, notes, metCount, partialCount }>,
 *   currentIndex: number,      // first stage NOT complete (0-based); -1 if all complete
 *   lastCompleteIndex: number, // furthest fully-complete stage (0-based); -1 if none
 *   workingIndex: number,      // furthest stage with any progress (0-based); -1 if none
 *   complete: boolean,         // every stage complete
 *   metCount: number,          // total met activities
 *   totalActivities: number,   // always 21
 *   completionPct: number      // 0..100, met / 21
 * }}
 */
export function deriveEventBoard(analysis) {
  const stageResults = new Map(((analysis && analysis.stages) || []).map(s => [s.stage_id, s]));

  const stages = EVENT_STAGES.map((stageDef, i) => {
    const res = stageResults.get(stageDef.id);
    const actResults = new Map(((res && res.activities) || []).map(a => [a.activity_id, a]));

    const activities = stageDef.activities.map(def => {
      const ar = actResults.get(def.id);
      return {
        id: def.id,
        label: def.label,
        owner: def.owner,
        status: ar ? ar.status : 'no_evidence',
        evidence: ar ? (ar.evidence || '') : '',
        source_type: ar ? (ar.source_type || 'none') : 'none',
        source_id: ar ? (ar.source_id || '') : '',
        source_date: ar ? (ar.source_date || '') : '',
        manual: ar ? !!ar.manual : false,
      };
    });

    const metCount = activities.filter(a => a.status === 'met').length;
    const partialCount = activities.filter(a => a.status === 'partial').length;
    const status = stageStatusFromActivities(activities);

    return { def: stageDef, index: i, status, activities, notes: (res && res.notes) || '', metCount, partialCount };
  });

  let lastCompleteIndex = -1;
  let workingIndex = -1;
  let currentIndex = -1;
  stages.forEach((s, i) => {
    if (s.status === 'complete') lastCompleteIndex = i;
    if (s.status !== 'not_started') workingIndex = i;
    // First stage that is NOT complete is the operational current stage.
    if (currentIndex === -1 && s.status !== 'complete') currentIndex = i;
  });

  const metCount = stages.reduce((n, s) => n + s.metCount, 0);
  const complete = currentIndex === -1;
  const completionPct = TOTAL_ACTIVITIES > 0 ? Math.round((metCount / TOTAL_ACTIVITIES) * 100) : 0;

  return {
    stages,
    currentIndex,
    lastCompleteIndex,
    workingIndex,
    complete,
    metCount,
    totalActivities: TOTAL_ACTIVITIES,
    completionPct,
  };
}

/**
 * Resolve the single "lifecycle position" line the Analyzer summary and the
 * PDF both show, from a derived board. The operational position is the
 * FIRST-INCOMPLETE stage (board.currentIndex). When every stage is complete
 * the lifecycle is reported as complete (position = the last stage).
 *
 * @param {object} board  Result of deriveEventBoard().
 * @returns {{ def: object|null, index: number, complete: boolean, started: boolean }}
 */
export function resolveEventPosition(board) {
  if (!board) return { def: null, index: -1, complete: false, started: false };
  const started = board.workingIndex >= 0;
  if (board.complete) {
    const lastIdx = EVENT_STAGES.length - 1;
    return { def: EVENT_STAGES[lastIdx], index: lastIdx, complete: true, started };
  }
  const idx = board.currentIndex >= 0 ? board.currentIndex : 0;
  return { def: EVENT_STAGES[idx] || null, index: idx, complete: false, started };
}
