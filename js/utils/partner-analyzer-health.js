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
  // British doubled-l spelling: the suffix group below derives "canceling"
  // from "cancel" but cannot derive "cancelling", so it is listed outright —
  // the same reason "cancelled" and "canceled" both already appear.
  'cancelling',
  'blocked', 'blocker', 'stalled', 'stall',
  'at risk', 'walk away', 'walked away', 'pulling out', 'pull out',
  'no longer interested', 'not interested', 'lost interest',
  'unresponsive', 'gone quiet', 'went cold', 'ghosted',
  'deprioritize', 'deprioritized', 'on hold', 'paused', 'pause the',
  'ending the relationship', 'end the partnership', 'winding down',
];

// Words that negate the risk term immediately following them. "No blockers"
// and "no longer blocked" are the OPPOSITE of a relationship at risk, and in
// this CRM they are common phrasings, so a hit right after one of these is
// discarded rather than counted.
//
// Up to two describing words may sit between the negator and the term — "no
// open blockers", "no longer any blockers", "not currently blocked" are all
// still negations, and an allowlist of adjectives would never keep up with how
// people actually write.
//
// What DOES have to be excluded is the small set of continuations that show
// the negator is not negating the term at all: "has not ONLY stalled", "not
// YET cancelled", "without WARNING cancelled". Those read as risk and must
// survive, so they are blocked from the gap rather than the gap being closed.
const NEGATOR_ALTERNATIVES = "no|not|zero|without|never|aren't any|isn't any";
const NEGATOR_GAP_BLOCKLIST = 'only|yet|just|merely|simply|solely|warning|sooner';
// `\s{1,4}` rather than `\s+`: a term separated from a negator by a long run
// of whitespace is not being negated by it, and bounding the run is what makes
// the lookback window below provably sufficient.
const RISK_NEGATOR_RE = new RegExp(
  `\\b(?:${NEGATOR_ALTERNATIVES})\\s{1,4}(?:(?!(?:${NEGATOR_GAP_BLOCKLIST})\\b)\\w+\\s{1,4}){0,2}$`,
);

// How far back to look for a negator. The pattern is `$`-anchored and bounded
// — a negator (≤10 chars) plus at most two gap words and their bounded
// whitespace — so this window covers every string it can match, while keeping
// the scan linear in the note's length instead of quadratic in
// (length × negated hits).
const NEGATOR_LOOKBACK = 120;

// Word-boundary matcher for one risk term, tolerating the regular English
// inflections. Boundaries are what keep "install" from reading as "stall" — a
// plain substring test flagged an IT partner as At Risk for the word
// "installed". The suffix group is what keeps the boundaries from throwing out
// the inflected forms the substring test legitimately caught ("stalling",
// "canceling", "unresponsiveness"): a leading boundary is still required, so
// "installing" cannot match "stall" either way.
function riskTermRegex(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}(?:s|es|ed|ing|ness)?\\b`, 'g');
}

// Built once — this runs over every recent note of every partner analyzed.
const RISK_TERM_REGEXES = RISK_LANGUAGE.filter(Boolean).map(riskTermRegex);

/**
 * Does `text` contain explicit relationship-risk language?
 *
 * Case-insensitive, WORD-BOUNDED match against RISK_LANGUAGE (regular
 * inflections tolerated), ignoring any hit that is directly negated
 * ("no blockers"). Pure — the caller decides whether the source is recent
 * enough to matter.
 *
 * Word boundaries are not a nicety here: relationship health is one of the few
 * numbers on the partner board the model never gets to invent, so a false
 * positive is a deterministic lie. A plain substring test made every mention of
 * "install", "installed" or "installation" contain "stall".
 *
 * Note this is a vocabulary match, not comprehension: a term listed in
 * RISK_LANGUAGE still fires in an innocent context that happens to use the word
 * (e.g. "reviewed the cancellation policy"), because "cancellation" is a listed
 * term. Boundaries fixed the substring collisions, not that.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function containsRiskLanguage(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return false;
  for (const re of RISK_TERM_REGEXES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const before = s.slice(Math.max(0, m.index - NEGATOR_LOOKBACK), m.index);
      if (!RISK_NEGATOR_RE.test(before)) return true;
      // Zero-length matches are impossible here (every term is non-empty),
      // so exec always advances.
    }
  }
  return false;
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
 * @param {string} [signals.createdAt]  ISO date the partner row was created —
 *   the PRIMARY signal for how long the partnership has existed.
 * @param {string} [signals.firstActivityDate]  ISO date of the EARLIEST known
 *   interaction (first transcript/meeting/note/completed event). Used as a
 *   fallback for partnership age when `createdAt` is missing — i.e. "when we
 *   first engaged" — so a relationship's age is still known even if the row
 *   was never stamped with a created date.
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
  const firstSeenMs = parseDay(signals.firstActivityDate);
  const hasActiveSignal = !!signals.hasActiveSignal;
  const recentRisk = !!signals.recentRiskEvidence;
  const evidenceCount = Number(signals.evidenceCount) || 0;

  const daysSinceActivity = lastMs != null ? wholeDaysBetween(lastMs, todayMs) : null;

  // Partnership age. Prefer the explicit created date; when it is missing, fall
  // back to the EARLIEST known interaction ("when we first engaged"). A young
  // relationship has not had a fair chance to generate evidence, and — most
  // importantly — a relationship that has only just begun cannot have
  // *deteriorated*. `ageDays` is null only when we can find no origin at all.
  const originMs = createdMs != null ? createdMs : firstSeenMs;
  const ageDays = originMs != null ? wholeDaysBetween(originMs, todayMs) : null;
  const isBrandNew = ageDays != null && ageDays <= NEW_PARTNER_GRACE_DAYS;

  // 1. Explicit, recent risk language.
  if (recentRisk) {
    // A brand-new partnership is NOT declared At Risk on risk language alone.
    // In an early conversation, phrases like "blocked", "on hold" or "not
    // interested" usually describe the prospect's own situation, not a
    // relationship that is falling apart — the relationship is just getting
    // started. Surface it as Watch (keep an eye on it) with an honest reason.
    if (isBrandNew) {
      return mk(RELATIONSHIP_HEALTH.WATCH, daysSinceActivity,
        `A recent source contains cautionary language, but the partnership is only ${ageDays} day(s) old — too new to be At Risk. Watch as it develops.`);
    }
    return mk(RELATIONSHIP_HEALTH.AT_RISK, daysSinceActivity,
      'A recent source explicitly documents disengagement, blocked progress, or a relationship risk.');
  }

  // 2. No meaningful activity at all.
  if (daysSinceActivity == null) {
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
      `No meaningful activity on record and the partnership has existed for ${ageDays} days.`);
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
