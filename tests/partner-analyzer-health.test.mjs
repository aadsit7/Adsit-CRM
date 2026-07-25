// Tests for deterministic relationship health (js/utils/partner-analyzer-health.js).
// Health is SEPARATE from maturity and is derived deterministically. The
// 45-day and 90-day thresholds are tested EXACTLY at their boundaries, and
// newly-created partners are handled fairly (Insufficient history, not At Risk).
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  derivePartnerHealth,
  healthLabel,
  containsRiskLanguage,
  RISK_LANGUAGE,
  RELATIONSHIP_HEALTH,
  HEALTH_HEALTHY_MAX_DAYS,
  HEALTH_WATCH_MAX_DAYS,
  NEW_PARTNER_GRACE_DAYS,
} from '../js/utils/partner-analyzer-health.js';

const TODAY = '2026-07-21';

// Local-midnight date arithmetic that matches the module's own parser.
function daysAgo(n, today = TODAY) {
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

const H = (signals) => derivePartnerHealth(signals, { today: TODAY });

// ── Constants ────────────────────────────────────────────────────────
test('thresholds are the documented 45 / 90 day constants', () => {
  assert.equal(HEALTH_HEALTHY_MAX_DAYS, 45);
  assert.equal(HEALTH_WATCH_MAX_DAYS, 90);
});

test('healthLabel maps codes to human labels', () => {
  assert.equal(healthLabel(RELATIONSHIP_HEALTH.HEALTHY), 'Healthy');
  assert.equal(healthLabel(RELATIONSHIP_HEALTH.WATCH), 'Watch');
  assert.equal(healthLabel(RELATIONSHIP_HEALTH.AT_RISK), 'At Risk');
  assert.equal(healthLabel(RELATIONSHIP_HEALTH.INSUFFICIENT), 'Insufficient history');
});

// ── Healthy ──────────────────────────────────────────────────────────
test('Healthy: recent activity with a concrete active signal', () => {
  const r = H({ lastActivityDate: daysAgo(10), createdAt: daysAgo(300), hasActiveSignal: true });
  assert.equal(r.status, RELATIONSHIP_HEALTH.HEALTHY);
  assert.equal(r.label, 'Healthy');
  assert.equal(r.daysSinceActivity, 10);
});

test('Healthy boundary: exactly 45 days + active signal is still Healthy', () => {
  const r = H({ lastActivityDate: daysAgo(45), createdAt: daysAgo(300), hasActiveSignal: true });
  assert.equal(r.status, RELATIONSHIP_HEALTH.HEALTHY);
  assert.equal(r.daysSinceActivity, 45);
});

test('recent activity but NO active signal → Watch (not Healthy)', () => {
  const r = H({ lastActivityDate: daysAgo(10), createdAt: daysAgo(300), hasActiveSignal: false });
  assert.equal(r.status, RELATIONSHIP_HEALTH.WATCH);
});

// ── Watch ────────────────────────────────────────────────────────────
test('Watch boundary: 46 days is Watch even with an active signal', () => {
  const r = H({ lastActivityDate: daysAgo(46), createdAt: daysAgo(300), hasActiveSignal: true });
  assert.equal(r.status, RELATIONSHIP_HEALTH.WATCH);
  assert.equal(r.daysSinceActivity, 46);
});

test('Watch boundary: exactly 90 days is still Watch', () => {
  const r = H({ lastActivityDate: daysAgo(90), createdAt: daysAgo(300), hasActiveSignal: true });
  assert.equal(r.status, RELATIONSHIP_HEALTH.WATCH);
  assert.equal(r.daysSinceActivity, 90);
});

// ── At Risk ──────────────────────────────────────────────────────────
test('At Risk boundary: 91 days tips into At Risk', () => {
  const r = H({ lastActivityDate: daysAgo(91), createdAt: daysAgo(300), hasActiveSignal: true });
  assert.equal(r.status, RELATIONSHIP_HEALTH.AT_RISK);
  assert.equal(r.daysSinceActivity, 91);
});

test('At Risk: recent explicit risk evidence overrides recent activity', () => {
  const r = H({ lastActivityDate: daysAgo(3), createdAt: daysAgo(300), hasActiveSignal: true, recentRiskEvidence: true });
  assert.equal(r.status, RELATIONSHIP_HEALTH.AT_RISK, 'explicit risk wins over recency');
});

test('At Risk: established partner (>90 days old) with NO activity on record', () => {
  const r = H({ lastActivityDate: '', createdAt: daysAgo(200), hasActiveSignal: false });
  assert.equal(r.status, RELATIONSHIP_HEALTH.AT_RISK);
  assert.equal(r.daysSinceActivity, null);
});

// ── New-partnership age gate (the reported PDF scenario) ─────────────
// A relationship that just began cannot have "deteriorated". Risk language in
// an early conversation usually describes the prospect, not the partnership.
test('brand-new partnership: first call today with risk language is Watch, NOT At Risk', () => {
  const r = H({
    lastActivityDate: daysAgo(0), createdAt: daysAgo(0),
    hasActiveSignal: true, recentRiskEvidence: true,
  });
  assert.equal(r.status, RELATIONSHIP_HEALTH.WATCH);
  assert.equal(r.label, 'Watch');
  assert.match(r.reason, /too new to be At Risk/i);
});

test('new partnership within the grace window + risk language → Watch', () => {
  const r = H({
    lastActivityDate: daysAgo(2), createdAt: daysAgo(NEW_PARTNER_GRACE_DAYS),
    hasActiveSignal: true, recentRiskEvidence: true,
  });
  assert.equal(r.status, RELATIONSHIP_HEALTH.WATCH, 'exactly at the grace boundary is still new');
});

test('age falls back to firstActivityDate when createdAt is missing (still new → Watch)', () => {
  const r = H({
    lastActivityDate: daysAgo(1), createdAt: '', firstActivityDate: daysAgo(1),
    hasActiveSignal: true, recentRiskEvidence: true,
  });
  assert.equal(r.status, RELATIONSHIP_HEALTH.WATCH, 'no created date → earliest interaction dates the partnership');
});

test('an ESTABLISHED partner (via firstActivityDate) with risk language is still At Risk', () => {
  const r = H({
    lastActivityDate: daysAgo(5), createdAt: '', firstActivityDate: daysAgo(200),
    hasActiveSignal: true, recentRiskEvidence: true,
  });
  assert.equal(r.status, RELATIONSHIP_HEALTH.AT_RISK, 'first engaged 200 days ago → old enough to be At Risk');
});

test('createdAt takes precedence over firstActivityDate for age', () => {
  // Created 300 days ago even though the earliest surviving note is only 3 days
  // old → established, so risk language still means At Risk.
  const r = H({
    lastActivityDate: daysAgo(3), createdAt: daysAgo(300), firstActivityDate: daysAgo(3),
    hasActiveSignal: true, recentRiskEvidence: true,
  });
  assert.equal(r.status, RELATIONSHIP_HEALTH.AT_RISK);
});

test('a positive first call (no risk language) is Healthy, not held back by newness', () => {
  const r = H({
    lastActivityDate: daysAgo(0), createdAt: daysAgo(0),
    hasActiveSignal: true, recentRiskEvidence: false,
  });
  assert.equal(r.status, RELATIONSHIP_HEALTH.HEALTHY);
});

// ── Insufficient history (new partners handled fairly) ───────────────
test('Insufficient history: a brand-new partner with no activity is NOT At Risk', () => {
  const r = H({ lastActivityDate: '', createdAt: daysAgo(10), hasActiveSignal: false });
  assert.equal(r.status, RELATIONSHIP_HEALTH.INSUFFICIENT);
  assert.equal(r.label, 'Insufficient history');
});

test('Insufficient history boundary: created exactly at the grace window', () => {
  const r = H({ lastActivityDate: '', createdAt: daysAgo(HEALTH_WATCH_MAX_DAYS), hasActiveSignal: false });
  assert.equal(r.status, RELATIONSHIP_HEALTH.INSUFFICIENT);
});

test('Insufficient history: no activity and no created date at all', () => {
  const r = H({ lastActivityDate: '', createdAt: '', hasActiveSignal: false });
  assert.equal(r.status, RELATIONSHIP_HEALTH.INSUFFICIENT);
});

// ── Bad input ────────────────────────────────────────────────────────
test('invalid activity date is treated as no meaningful activity', () => {
  const r = H({ lastActivityDate: 'not-a-date', createdAt: daysAgo(5), hasActiveSignal: false });
  assert.equal(r.status, RELATIONSHIP_HEALTH.INSUFFICIENT, 'invalid date + new partner → insufficient');
  assert.equal(r.daysSinceActivity, null);
});

test('empty signals object does not throw and is insufficient', () => {
  assert.doesNotThrow(() => derivePartnerHealth());
  assert.equal(derivePartnerHealth({}, { today: TODAY }).status, RELATIONSHIP_HEALTH.INSUFFICIENT);
});

// ── Risk language detector ───────────────────────────────────────────
test('containsRiskLanguage flags disengagement / cancellation / blocked', () => {
  assert.ok(containsRiskLanguage('The partner wants to cancel the agreement'));
  assert.ok(containsRiskLanguage('They have gone quiet and are unresponsive'));
  assert.ok(containsRiskLanguage('Project is blocked pending legal'));
  assert.ok(containsRiskLanguage('They may walk away from the partnership'));
  assert.ok(!containsRiskLanguage('Great meeting, everyone is aligned and excited'));
  assert.ok(!containsRiskLanguage(''));
  assert.ok(!containsRiskLanguage(null));
});

// Relationship health is one of the few numbers on the partner board the model
// never gets to invent, so a false positive here is a deterministic lie about
// the relationship. A substring test made every mention of "install" contain
// "stall" — fatal in a CRM whose partners deploy software for a living.
test('containsRiskLanguage does not fire on words that merely CONTAIN a risk term', () => {
  assert.ok(!containsRiskLanguage('Installed the agent on 400 endpoints'), '"install" is not "stall"');
  assert.ok(!containsRiskLanguage('Installation completed on schedule'));
  assert.ok(!containsRiskLanguage('Their install base is growing'));
  assert.ok(!containsRiskLanguage('We are re-installing the console'));
  assert.ok(!containsRiskLanguage('Uncancelled the renewal'));
});

test('containsRiskLanguage still fires on the real word', () => {
  assert.ok(containsRiskLanguage('The rollout has stalled'));
  assert.ok(containsRiskLanguage('Deal stalls whenever procurement gets involved'));
  assert.ok(containsRiskLanguage('There are blockers on the integration'), 'plural still counts');
  assert.ok(containsRiskLanguage('Cancellation of the joint webinar'));
  assert.ok(containsRiskLanguage('At risk of losing the renewal'));
  assert.ok(containsRiskLanguage('Project paused until Q3'));
});

// Word boundaries must not cost the inflected forms a substring test caught.
// Losing these would flip a genuinely at-risk partner to Healthy — the same
// deterministic lie as a false positive, pointing the other way.
test('containsRiskLanguage catches regular inflections of a risk term', () => {
  assert.ok(containsRiskLanguage('The project is stalling'));
  assert.ok(containsRiskLanguage('They are canceling the contract'));
  assert.ok(containsRiskLanguage('They are cancelling the contract'), 'British spelling');
  assert.ok(containsRiskLanguage('unresponsiveness from the team'));
  assert.ok(containsRiskLanguage('They are churning through the deployment'));
});

test('every RISK_LANGUAGE term still matches its own sentence', () => {
  for (const term of RISK_LANGUAGE) {
    assert.ok(containsRiskLanguage(`QBR note: the account has ${term} this quarter.`),
      `"${term}" no longer matches — the boundary/suffix rules dropped a listed term`);
  }
});

// "No <describing word> blockers" is how reps actually write a clean status.
// An allowlist of adjectives would never keep up, so the gap is open and only
// the not-really-negating continuations are excluded.
test('containsRiskLanguage ignores a negated risk term, however it is qualified', () => {
  for (const s of [
    'No blockers reported this week',
    'No open blockers.',
    'No remaining blockers.',
    'No technical blockers.',
    'No immediate blockers.',
    'No critical blockers.',
    'No procurement blockers',
    'No major blockers',
    'No longer blocked — legal signed off',
    'There are no longer any blockers.',
    'not currently blocked',
    'Zero blockers',
    'Zero open blockers.',
    'Without any blockers we ship Friday',
  ]) {
    assert.ok(!containsRiskLanguage(s), `should read as negated: ${s}`);
  }
  // …but a negation elsewhere in the sentence must not launder a real risk.
  assert.ok(containsRiskLanguage('No update yet, and the project is blocked'));
});

// The negator has to be adjacent (or separated only by a degree word). A
// negator that merely appears two words earlier is usually negating something
// else entirely, and suppressing on it hides real risk.
// A negator that is not negating the TERM must not suppress it. These are the
// constructions the gap blocklist exists for.
test('containsRiskLanguage does not treat a non-negating negator as negation', () => {
  assert.ok(containsRiskLanguage('The project has not only stalled but reversed.'));
  assert.ok(containsRiskLanguage('They have not yet cancelled, but they will.'));
  assert.ok(containsRiskLanguage('Without warning cancelled the contract.'));
  assert.ok(containsRiskLanguage('No progress this month, the deal is stalled'));
});

test('containsRiskLanguage stays fast on a very long note', () => {
  // Negated hits used to re-scan the whole prefix, making this quadratic.
  const long = 'the partner installed and reinstalled with no blockers everywhere. '.repeat(3000);
  const started = Date.now();
  assert.equal(containsRiskLanguage(long), false);
  assert.ok(Date.now() - started < 1000, 'scanning a 200KB note must not block the main thread');
});

test('containsRiskLanguage reads a whole note, not just its opening', () => {
  const note = 'Kicked off the pilot. Installed on three sites. '
    + 'Procurement has stalled the order form.';
  assert.ok(containsRiskLanguage(note));
});
