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
  RELATIONSHIP_HEALTH,
  HEALTH_HEALTHY_MAX_DAYS,
  HEALTH_WATCH_MAX_DAYS,
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
