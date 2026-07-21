// ============================================================
// Partner relationship health — deterministic, tested rules
// ============================================================
// Relationship health is SEPARATE from maturity. Maturity asks "how far has
// this partnership progressed?"; health asks "is the relationship warm,
// cooling, or cold right now?". A Premier/Strategic partner can be At Risk;
// a brand-new Registered partner can be Healthy.
//
// The label is derived DETERMINISTICALLY here — the model is never asked to
// invent it. The thresholds are named constants so they can be tuned in one
// place, and the boundaries are tested exactly.
//
// The CRM `status` field (engaged / active / inactive) is NOT relationship
// health. An inactive CRM status is shown separately by the view; it never
// silently becomes an "At Risk" health label.
//
// Pure functions. No DOM, no network.
// ============================================================

// ── Thresholds (named so they can be adjusted later) ────────────────
/** Meaningful activity within this many days (inclusive) is "recent". */
export const HEALTH_HEALTHY_MAX_DAYS = 45;
/** Beyond HEALTHY and up to this many days (inclusive) is the "Watch" band. */
export const HEALTH_WATCH_MAX_DAYS = 90;
/**
 * A partner with NO meaningful activity that was created within this many
 * days is treated as "Insufficient history" rather than automatically
 * "At Risk" — a new relationship hasn't had a fair chance to generate
 * evidence yet.
 */
export const NEW_PARTNER_GRACE_DAYS = 90;

/** Stable status codes + their display labels. */
export const RELATIONSHIP_HEALTH = {
  HEALTHY: 'healthy',
  WATCH: 'watch',
  AT_RISK: 'at_risk',
  INSUFFICIENT: 'insufficient_history',
};

const HEALTH_LABELS = {
  [RELATIONSHIP_HEALTH.HEALTHY]: 'Healthy',
  [RELATIONSHIP_HEALTH.WATCH]: 'Watch',
  [RELATIONSHIP_HEALTH.AT_RISK]: 'At Risk',
  [RELATIONSHIP_HEALTH.INSUFFICIENT]: 'Insufficient history',
};

/** Human label for a health status code. */
export function healthLabel(status) {
  return HEALTH_LABELS[status] || 'Insufficient history';
}

// Risk language that, when found in a RECENT source, explicitly signals a
// relationship at risk (disengagement, blocked progress, cancellation). The
// recency window is applied by the caller (see evidence.detectRecentRiskEvidence);
// this list is exported so both the health tests and the evidence scan share it.
export const RISK_LANGUAGE = [
  'disengage', 'disengaged', 'disengagement',
  'churn', 'churning', 'churned',
  'cancel', 'cancelled', 'canceled', 'cancellation',
  'terminate', 'terminated', 'termination',
  'blocked', 'blocker', 'stalled', 'stall',
  'at risk', 'walk away', 'walked away', 'pulling out', 'pull out',
  'no longer interested', 'not interested', 'lost interest',
  'unresponsive', 'gone quiet', 'went cold', 'ghosted',
  'deprioritize', 'deprioritized', 'on hold', 'paused', 'pause the',
  'ending the relationship', 'end the partnership', 'winding down',
];

/**
 * Does `text` contain explicit relationship-risk language? Case-insensitive
 * substring match against RISK_LANGUAGE. Pure — the caller decides whether the
 * source is recent enough to matter.
 * @param {string} text
 * @returns {boolean}
 */
export function containsRiskLanguage(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return false;
  return RISK_LANGUAGE.some(term => term && s.includes(term));
}

// ── Date helpers ────────────────────────────────────────────────────
function parseDay(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const ms = Date.parse(s.length <= 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(ms) ? null : ms;
}

function wholeDaysBetween(fromMs, toMs) {
  return Math.floor((toMs - fromMs) / 86_400_000);
}

/**
 * Derive relationship health from deterministic signals.
 *
 * @param {object} signals
 * @param {string} [signals.lastActivityDate]  ISO date of the most recent
 *   MEANINGFUL activity (recent transcript/meeting, a dated note, a completed
 *   or upcoming event, a recent opportunity update). Empty/invalid → treated
 *   as "no meaningful activity".
 * @param {string} [signals.createdAt]  ISO date the partner row was created.
 * @param {boolean} [signals.hasActiveSignal]  Is there at least one CONCRETE
 *   active signal — an active opportunity, an upcoming partner-specific event,
 *   a documented next step, or a recent meeting?
 * @param {boolean} [signals.recentRiskEvidence]  Does a RECENT source explicitly
 *   document disengagement, blocked progress, cancellation, or a relationship
 *   risk?
 * @param {number} [signals.evidenceCount]  Count of meaningful evidence items
 *   found for the partner (used only to distinguish a genuinely empty new
 *   partner from an established one).
 * @param {object} [options]
 * @param {string} [options.today]  Injectable YYYY-MM-DD for deterministic tests.
 * @returns {{ status:string, label:string, daysSinceActivity:(number|null), reason:string }}
 */
export function derivePartnerHealth(signals = {}, options = {}) {
  const todayMs = parseDay(options.today) ?? Date.now();
  const lastMs = parseDay(signals.lastActivityDate);
  const createdMs = parseDay(signals.createdAt);
  const hasActiveSignal = !!signals.hasActiveSignal;
  const recentRisk = !!signals.recentRiskEvidence;
  const evidenceCount = Number(signals.evidenceCount) || 0;

  const daysSinceActivity = lastMs != null ? wholeDaysBetween(lastMs, todayMs) : null;

  // 1. Explicit, recent risk language always wins → At Risk (task rule).
  if (recentRisk) {
    return mk(RELATIONSHIP_HEALTH.AT_RISK, daysSinceActivity,
      'A recent source explicitly documents disengagement, blocked progress, or a relationship risk.');
  }

  // 2. No meaningful activity at all.
  if (daysSinceActivity == null) {
    const ageDays = createdMs != null ? wholeDaysBetween(createdMs, todayMs) : null;
    // A brand-new partner (or one with essentially no evidence) is judged
    // fairly — Insufficient history, never automatically At Risk.
    const isNew = ageDays == null || ageDays <= NEW_PARTNER_GRACE_DAYS;
    if (isNew) {
      return mk(RELATIONSHIP_HEALTH.INSUFFICIENT, null,
        'Too little history to assess relationship health.');
    }
    // Established for longer than the grace window with no meaningful
    // activity on record → the relationship has gone cold.
    return mk(RELATIONSHIP_HEALTH.AT_RISK, null,
      `No meaningful activity on record and the partner has existed for ${ageDays} days.`);
  }

  // 3. Activity is on record — bucket by recency.
  if (daysSinceActivity <= HEALTH_HEALTHY_MAX_DAYS) {
    if (hasActiveSignal) {
      return mk(RELATIONSHIP_HEALTH.HEALTHY, daysSinceActivity,
        `Meaningful activity ${daysSinceActivity} day(s) ago with a concrete active signal.`);
    }
    // Recent activity but no concrete next step / active motion → Watch.
    return mk(RELATIONSHIP_HEALTH.WATCH, daysSinceActivity,
      'Recent activity exists, but there is no concrete next step or active commercial/GTM motion.');
  }

  if (daysSinceActivity <= HEALTH_WATCH_MAX_DAYS) {
    return mk(RELATIONSHIP_HEALTH.WATCH, daysSinceActivity,
      `No meaningful activity for ${daysSinceActivity} days (46–90 day window).`);
  }

  return mk(RELATIONSHIP_HEALTH.AT_RISK, daysSinceActivity,
    `No meaningful activity for ${daysSinceActivity} days (more than 90).`);
}

function mk(status, daysSinceActivity, reason) {
  return { status, label: healthLabel(status), daysSinceActivity, reason };
}
