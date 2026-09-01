// ============================================
// Admin Comp View — Compensation Calculator
// ============================================
//
// Models the FY26 Individual Compensation Plan for Aaron Adsit:
//   - Annual quota target = 500,000 net ARR (managed-partner invoiced)
//   - $90k incentive at 100% attainment (18% primary rate)
//   - 23% accelerator on the 100-150% attainment band
//   - 27% accelerator on the >150% attainment band
//   - 5% flat commission on RidgePoint net ARR (non-renewal)
//   - Microsoft and RidgePoint excluded from quota attainment
//
// The calculator pulls live opportunities from the same Opportunities
// sheet used by /admin/opportunities, lets the rep filter by status &
// stage, and recomputes earned + projected commission on every change.

import { readSheetAsObjects } from '../sheets.js';
import { CONFIG } from '../config.js';
import { el, mount, formatCurrency, debounce } from '../utils/dom.js';
import { statCard } from '../components/card.js';
import { setTopbarTitle } from '../components/sidebar.js';
import { filterOpportunities, filterPartners } from '../utils/filters.js';
import { formatDate } from '../utils/date.js';

export const title = 'Comp';

// ---- Plan defaults (FY26 Individual Compensation Plan) ----

const DEFAULT_PLAN = {
  participantName: 'Aaron Adsit',
  role: 'VP Partner Sales',
  planStart: 'January 1, 2026',
  annualTarget: 500000,
  annualIncentive: 90000,
  primaryRate: 0.18,
  accelTier1Rate: 0.23,   // 100-150% of budget
  accelTier2Rate: 0.27,   // 150%+ of budget
  ridgepointFlatRate: 0.05,
  // Personal stretch goal — separate from the contractual quota.
  // Drives the "Goal Gap" projection: shows how much more ARR the rep
  // needs and what additional commission that closes out.
  personalGoal: 1000000,
  // Partners excluded from quota attainment but still paid via flat
  // commission (RidgePoint) or excluded entirely (Microsoft).
  excludedPartnerNames: ['Microsoft'],
  flatCommissionPartnerNames: ['RidgePoint'],
};

const PLAN_STORAGE_KEY = 'pp_comp_plan_v1';

function loadPlan() {
  try {
    const stored = JSON.parse(localStorage.getItem(PLAN_STORAGE_KEY) || 'null');
    if (stored && typeof stored === 'object') {
      return { ...DEFAULT_PLAN, ...stored };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_PLAN };
}

function savePlan(plan) {
  try {
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plan));
  } catch { /* ignore */ }
}

// ---- Cached data (within the view's lifetime) ----

let cachedOpps = null;
let cachedPartners = null;

const STAGE_ORDER = ['Prospect', 'Qualified', 'Develop', 'Proposal', 'Negotiation', 'Closed'];

const STAGE_WIN_PROBABILITY = {
  'Prospect': 0.10,
  'Qualified': 0.30,
  // Between Qualified and Proposal, matching its slot in STAGE_ORDER. It
  // was missing and fell to the generic 0.25 fallback — BELOW Qualified —
  // so the Weighted projection ranked a further-along deal lower than an
  // earlier one.
  'Develop': 0.42,
  'Proposal': 0.55,
  'Negotiation': 0.80,
  'Closed': 1.00,
};

// ---- Eligibility classification ----

function isRenewalOpp(opp) {
  // The Opportunities sheet has no dedicated renewal flag, so we infer from
  // the deal name. Reps already use the convention "Renewal" / "Renew" in
  // deal titles. Anything matching is excluded from the RidgePoint flat
  // commission per the plan: "5% flat commission rate on net ARR invoiced
  // through RidgePoint outside of renewal transactions."
  const dealName = String(opp.deal_name || '').toLowerCase();
  // Matches: renew, renews, renewal, renewals (as standalone words).
  // Doesn't match: renewing, renewed, renewable.
  return /\brenew(?:s|als?)?\b/i.test(dealName);
}

function classifyOpp(opp, partners, plan) {
  const partner = partners.find(p => p.partner_id === opp.partner_id);
  const partnerName = (partner?.display_name || '').trim();
  const partnerNameLc = partnerName.toLowerCase();

  // Substring match (case-insensitive) so partner names like "Microsoft
  // Corporation" or "RidgePoint Inc" still classify correctly.
  const isExcluded = plan.excludedPartnerNames.some(name =>
    partnerNameLc.includes(name.toLowerCase())
  );
  const isFlatPartner = plan.flatCommissionPartnerNames.some(name =>
    partnerNameLc.includes(name.toLowerCase())
  );
  const isRenewal = isRenewalOpp(opp);

  let eligibility;
  if (isExcluded) {
    eligibility = 'excluded';
  } else if (isFlatPartner) {
    // RidgePoint renewals earn no commission (excluded from flat per plan).
    eligibility = isRenewal ? 'excluded' : 'flat';
  } else {
    eligibility = 'quota';
  }

  return { partner, partnerName, eligibility, isRenewal };
}

// ---- Commission math ----

/**
 * Compute commission earned on a slice of quota ARR given the cumulative
 * ARR already counted toward quota *before* this slice. Walks the three
 * brackets (primary, +accel1, +accel2) in order.
 */
function commissionOnQuotaSlice(sliceArr, priorQuotaArr, plan) {
  if (sliceArr <= 0) return 0;
  const target = plan.annualTarget;
  if (target <= 0) return sliceArr * plan.primaryRate;

  const tier1End = target;              // 100% of quota
  const tier2End = target * 1.5;        // 150% of quota

  let remaining = sliceArr;
  let cursor = priorQuotaArr;
  let commission = 0;

  // Primary tier
  if (cursor < tier1End && remaining > 0) {
    const room = tier1End - cursor;
    const take = Math.min(room, remaining);
    commission += take * plan.primaryRate;
    cursor += take;
    remaining -= take;
  }
  // Accelerator tier 1 (100-150%)
  if (cursor < tier2End && remaining > 0) {
    const room = tier2End - cursor;
    const take = Math.min(room, remaining);
    commission += take * plan.accelTier1Rate;
    cursor += take;
    remaining -= take;
  }
  // Accelerator tier 2 (>150%)
  if (remaining > 0) {
    commission += remaining * plan.accelTier2Rate;
  }
  return commission;
}

/**
 * Run all opportunities through the comp model. Returns earned / pipeline /
 * projected totals plus a per-opp breakdown the table renders.
 */
function computeCompModel(opps, partners, plan) {
  const enriched = opps.map(opp => {
    const { partnerName, eligibility, isRenewal } = classifyOpp(opp, partners, plan);
    const value = parseFloat(opp.deal_value) || 0;
    const stage = opp.stage || 'Prospect';
    const status = opp.status || '';
    const isWon = status === 'Won';
    const isLost = status === 'Lost';
    const isOpen = !isWon && !isLost;
    // Closed-stage open deals shouldn't really exist in the data (status
    // would be Won or Lost), so cap probability at 90% rather than 100%
    // to avoid over-stating projection if such a row ever appears.
    let probability = STAGE_WIN_PROBABILITY[stage] ?? 0.25;
    if (isOpen && stage === 'Closed') probability = 0.9;
    return {
      opp, partnerName, eligibility, isRenewal,
      value, stage, status,
      isWon, isLost, isOpen, probability,
    };
  });

  // First pass: closed/won deals consume quota in the order they arrived.
  // We sort by close date so the earliest wins consume primary-tier first.
  const wonQuotaDeals = enriched
    .filter(e => e.isWon && e.eligibility === 'quota')
    .sort((a, b) => (a.opp.expected_close || '').localeCompare(b.opp.expected_close || ''));

  let cumulativeWonQuota = 0;
  for (const e of wonQuotaDeals) {
    e.commissionEarned = commissionOnQuotaSlice(e.value, cumulativeWonQuota, plan);
    e.startingQuotaArr = cumulativeWonQuota;
    cumulativeWonQuota += e.value;
  }

  // Flat commission won deals (RidgePoint)
  const wonFlatDeals = enriched.filter(e => e.isWon && e.eligibility === 'flat');
  for (const e of wonFlatDeals) {
    e.commissionEarned = e.value * plan.ridgepointFlatRate;
  }

  // Excluded won deals contribute no commission
  for (const e of enriched.filter(e => e.isWon && e.eligibility === 'excluded')) {
    e.commissionEarned = 0;
  }

  // Lost deals: zero
  for (const e of enriched.filter(e => e.isLost)) {
    e.commissionEarned = 0;
  }

  // Open pipeline: project commission *if every open quota deal closes*.
  // We sort by expected close so deals expected to land earlier consume
  // the next available bracket first.
  const openQuotaDeals = enriched
    .filter(e => e.isOpen && e.eligibility === 'quota')
    .sort((a, b) => (a.opp.expected_close || '').localeCompare(b.opp.expected_close || ''));

  let projectedCursor = cumulativeWonQuota;
  for (const e of openQuotaDeals) {
    const fullProjected = commissionOnQuotaSlice(e.value, projectedCursor, plan);
    e.commissionIfWon = fullProjected;
    e.commissionWeighted = fullProjected * e.probability;
    e.startingQuotaArr = projectedCursor;
    projectedCursor += e.value;
  }

  // Open RidgePoint deals
  for (const e of enriched.filter(e => e.isOpen && e.eligibility === 'flat')) {
    e.commissionIfWon = e.value * plan.ridgepointFlatRate;
    e.commissionWeighted = e.commissionIfWon * e.probability;
  }

  // Open excluded deals: zero
  for (const e of enriched.filter(e => e.isOpen && e.eligibility === 'excluded')) {
    e.commissionIfWon = 0;
    e.commissionWeighted = 0;
  }

  // Aggregate totals
  const wonQuotaArr = cumulativeWonQuota;
  const wonFlatArr = wonFlatDeals.reduce((s, e) => s + e.value, 0);
  const openQuotaArr = openQuotaDeals.reduce((s, e) => s + e.value, 0);
  const openFlatArr = enriched.filter(e => e.isOpen && e.eligibility === 'flat').reduce((s, e) => s + e.value, 0);
  const openExcludedArr = enriched.filter(e => e.isOpen && e.eligibility === 'excluded').reduce((s, e) => s + e.value, 0);

  const earnedQuotaCommission = wonQuotaDeals.reduce((s, e) => s + (e.commissionEarned || 0), 0);
  const earnedFlatCommission = wonFlatDeals.reduce((s, e) => s + (e.commissionEarned || 0), 0);
  const earnedTotal = earnedQuotaCommission + earnedFlatCommission;

  const projectedIfAllClose = enriched
    .filter(e => e.isOpen)
    .reduce((s, e) => s + (e.commissionIfWon || 0), 0);
  const projectedWeighted = enriched
    .filter(e => e.isOpen)
    .reduce((s, e) => s + (e.commissionWeighted || 0), 0);

  const attainmentPct = plan.annualTarget > 0
    ? (wonQuotaArr / plan.annualTarget) * 100
    : 0;
  const projectedAttainmentPct = plan.annualTarget > 0
    ? ((wonQuotaArr + openQuotaArr) / plan.annualTarget) * 100
    : 0;

  // Personal goal — synthetic "Goal Gap" deal representing the ARR the rep
  // would still need to close beyond their current pipeline to hit goal.
  // Goal commission is computed as quota commission (using bracket walk)
  // because the personal goal is denominated in quota-eligible ARR.
  const goal = Math.max(0, plan.personalGoal || 0);
  const projectedQuotaArr = wonQuotaArr + openQuotaArr;
  const goalGapArr = Math.max(0, goal - projectedQuotaArr);
  const goalGapCommission = goalGapArr > 0
    ? commissionOnQuotaSlice(goalGapArr, projectedCursor, plan)
    : 0;
  const goalAttainmentPct = goal > 0 ? (projectedQuotaArr / goal) * 100 : 0;
  const totalIfGoalHit = earnedTotal + projectedIfAllClose + goalGapCommission;

  return {
    enriched,
    totals: {
      wonQuotaArr, wonFlatArr,
      openQuotaArr, openFlatArr, openExcludedArr,
      earnedQuotaCommission, earnedFlatCommission, earnedTotal,
      projectedIfAllClose, projectedWeighted,
      attainmentPct, projectedAttainmentPct,
      totalProjectedAtFullClose: earnedTotal + projectedIfAllClose,
      totalProjectedWeighted: earnedTotal + projectedWeighted,
      goal, goalGapArr, goalGapCommission, goalAttainmentPct, totalIfGoalHit,
    },
  };
}

// ---- Render ----

export async function render(container) {
  setTopbarTitle('Comp');
  mount(container, el('div', { class: 'loading-overlay' }, el('div', { class: 'spinner' })));

  try {
    const [opportunities, partners] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
      readSheetAsObjects(CONFIG.SHEET_PARTNERS),
    ]);
    cachedOpps = filterOpportunities(opportunities);
    cachedPartners = filterPartners(partners);
    renderView(container);
  } catch (err) {
    mount(container, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'Error loading compensation data'),
      el('div', { class: 'empty-state__description' }, err.message)
    ));
  }
}

export function cleanup() {
  cachedOpps = null;
  cachedPartners = null;
}

function renderView(container) {
  const plan = loadPlan();

  // Filter state
  const stageSet = new Set(cachedOpps.map(o => o.stage).filter(Boolean));
  const allStages = [
    ...STAGE_ORDER.filter(s => stageSet.has(s)),
    ...[...stageSet].filter(s => !STAGE_ORDER.includes(s)).sort(),
  ];

  let filters = {
    statusGroup: 'all',           // 'all' | 'open' | 'closed' | 'won' | 'lost'
    stages: new Set(allStages),
    eligibility: 'all',           // 'all' | 'quota' | 'flat' | 'excluded'
    search: '',
  };

  // Compute model on the FULL dataset so attainment never depends on filters.
  // The filters only affect the table view.
  function getModel() {
    return computeCompModel(cachedOpps, cachedPartners, plan);
  }

  function getFilteredEnriched(model) {
    return model.enriched.filter(e => {
      if (filters.statusGroup === 'open' && !e.isOpen) return false;
      if (filters.statusGroup === 'closed' && e.isOpen) return false;
      if (filters.statusGroup === 'won' && !e.isWon) return false;
      if (filters.statusGroup === 'lost' && !e.isLost) return false;

      if (filters.eligibility !== 'all' && e.eligibility !== filters.eligibility) return false;

      if (allStages.length && filters.stages.size < allStages.length) {
        if (!filters.stages.has(e.stage)) return false;
      }

      if (filters.search) {
        const q = filters.search.toLowerCase();
        const hay = `${e.opp.deal_name || ''} ${e.opp.customer_name || ''} ${e.partnerName || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // ---- Plan editor ----

  const planCard = buildPlanCard(plan, () => {
    savePlan(plan);
    refreshAll();
  });

  // ---- Stat cards ----

  const statsContainer = el('div', { class: 'stats-grid stagger comp-stats' });

  // ---- Attainment progress visual ----

  const attainmentContainer = el('div', { class: 'comp-attainment' });

  // ---- Bracket waterfall ----

  const waterfallContainer = el('div', { class: 'comp-bracket' });

  // ---- Filters ----

  const searchInput = el('input', {
    class: 'search-bar__input',
    type: 'text',
    placeholder: 'Search deals, customers, partners...',
    onInput: debounce((e) => { filters.search = e.target.value; refreshTable(); }, 200),
  });

  const statusSelect = el('select', {
    class: 'form-select filter-bar__select',
    onChange: (e) => { filters.statusGroup = e.target.value; refreshTable(); },
  },
    el('option', { value: 'all' }, 'All Opportunities'),
    el('option', { value: 'open' }, 'Open Only'),
    el('option', { value: 'closed' }, 'Closed Only'),
    el('option', { value: 'won' }, 'Won Only'),
    el('option', { value: 'lost' }, 'Lost Only'),
  );

  const eligibilitySelect = el('select', {
    class: 'form-select filter-bar__select',
    onChange: (e) => { filters.eligibility = e.target.value; refreshTable(); },
  },
    el('option', { value: 'all' }, 'All Eligibility'),
    el('option', { value: 'quota' }, 'Quota-Eligible'),
    el('option', { value: 'flat' }, 'Flat (RidgePoint)'),
    el('option', { value: 'excluded' }, 'Excluded'),
  );

  const stageMultiSelect = buildStageMultiSelect({
    allStages,
    selected: filters.stages,
    onChange: () => refreshTable(),
  });

  const tableContainer = el('div', { id: 'comp-table-container' });

  function refreshStats(model) {
    statsContainer.innerHTML = '';
    const t = model.totals;

    statsContainer.appendChild(statCard('Quota Attainment', `${t.attainmentPct.toFixed(1)}%`, {
      accentColor: 'var(--color-primary-lighter)',
      change: `${formatCurrency(t.wonQuotaArr)} / ${formatCurrency(plan.annualTarget)}`,
    }));
    statsContainer.appendChild(statCard('Earned Commission', formatCurrency(t.earnedTotal), {
      accentColor: 'var(--color-status-won)',
      change: `Quota ${formatCurrency(t.earnedQuotaCommission)} · Flat ${formatCurrency(t.earnedFlatCommission)}`,
    }));
    statsContainer.appendChild(statCard('Open Pipeline', formatCurrency(t.openQuotaArr + t.openFlatArr + t.openExcludedArr), {
      accentColor: 'var(--color-status-in-progress)',
      change: `Quota ${formatCurrency(t.openQuotaArr)} · Flat ${formatCurrency(t.openFlatArr)}`,
    }));
    statsContainer.appendChild(statCard('Projected Payout (All Close)', formatCurrency(t.totalProjectedAtFullClose), {
      accentColor: 'var(--color-accent)',
      change: `Weighted: ${formatCurrency(t.totalProjectedWeighted)}`,
    }));

    // Personal goal payout — only render when a goal is set.
    if (t.goal > 0) {
      const subtitle = t.goalGapArr > 0
        ? `Gap to goal: ${formatCurrency(t.goalGapArr)} ARR → +${formatCurrency(t.goalGapCommission)}`
        : `Goal reached at ${t.goalAttainmentPct.toFixed(0)}% — pipeline already covers it`;
      statsContainer.appendChild(statCard('Total If Goal Hit', formatCurrency(t.totalIfGoalHit), {
        accentColor: 'var(--color-warning)',
        change: subtitle,
      }));
    }
  }

  function refreshAttainment(model) {
    attainmentContainer.innerHTML = '';
    const t = model.totals;
    const target = plan.annualTarget;

    // Goal as percent of quota (so it sits on the same axis as the bar).
    const goalPctOfQuota = target > 0 && t.goal > 0 ? (t.goal / target) * 100 : 0;

    // Cap the visualization wide enough to cover whichever is largest:
    // 200%, current projection + 20pp, or the personal goal + 10pp.
    const cap = Math.max(200, t.projectedAttainmentPct + 20, goalPctOfQuota + 10);
    const wonPct = target > 0 ? Math.min((t.wonQuotaArr / target) * 100, cap) : 0;
    const openPct = target > 0 ? Math.min((t.openQuotaArr / target) * 100, cap - wonPct) : 0;

    const tier1Pos = (100 / cap) * 100;
    const tier2Pos = (150 / cap) * 100;
    const goalPos = goalPctOfQuota > 0 ? Math.min((goalPctOfQuota / cap) * 100, 100) : 0;

    const wonWidth = (wonPct / cap) * 100;
    const openWidth = (openPct / cap) * 100;

    const bar = el('div', { class: 'comp-attainment__bar' },
      el('div', {
        class: 'comp-attainment__segment comp-attainment__segment--won',
        style: { width: `${wonWidth}%` },
        title: `Won: ${formatCurrency(t.wonQuotaArr)} (${t.attainmentPct.toFixed(1)}%)`,
      }),
      el('div', {
        class: 'comp-attainment__segment comp-attainment__segment--open',
        style: { width: `${openWidth}%` },
        title: `Open Pipeline: ${formatCurrency(t.openQuotaArr)}`,
      }),
      el('div', {
        class: 'comp-attainment__marker comp-attainment__marker--tier1',
        style: { left: `${tier1Pos}%` },
        title: '100% — Accelerator begins',
      }, el('span', { class: 'comp-attainment__marker-label' }, '100%')),
      el('div', {
        class: 'comp-attainment__marker comp-attainment__marker--tier2',
        style: { left: `${tier2Pos}%` },
        title: '150% — Super accelerator begins',
      }, el('span', { class: 'comp-attainment__marker-label' }, '150%')),
      goalPos > 0 ? el('div', {
        class: 'comp-attainment__marker comp-attainment__marker--goal',
        style: { left: `${goalPos}%` },
        title: `Personal Goal: ${formatCurrency(t.goal)} (${goalPctOfQuota.toFixed(0)}% of quota)`,
      }, el('span', { class: 'comp-attainment__marker-label' }, 'Goal')) : null,
    );

    const headerChips = [
      el('span', { class: 'comp-attainment__chip comp-attainment__chip--won' },
        `Won ${t.attainmentPct.toFixed(1)}%`),
      el('span', { class: 'comp-attainment__chip comp-attainment__chip--open' },
        `+ Pipeline ${t.projectedAttainmentPct.toFixed(1)}%`),
    ];
    if (t.goal > 0) {
      headerChips.push(el('span', { class: 'comp-attainment__chip comp-attainment__chip--goal' },
        `${t.goalAttainmentPct.toFixed(0)}% to goal`));
    }

    attainmentContainer.appendChild(
      el('div', { class: 'comp-attainment__header' },
        el('span', { class: 'comp-attainment__title' }, 'Quota Attainment'),
        el('span', { class: 'comp-attainment__values' }, ...headerChips),
      ),
    );
    attainmentContainer.appendChild(bar);

    const legendItems = [
      el('span', {}, `Quota: ${formatCurrency(plan.annualTarget)}`),
      el('span', {}, `Won ARR: ${formatCurrency(t.wonQuotaArr)}`),
      el('span', {}, `Open ARR: ${formatCurrency(t.openQuotaArr)}`),
    ];
    if (t.goal > 0) {
      legendItems.push(el('span', {}, `Goal: ${formatCurrency(t.goal)}`));
    }
    attainmentContainer.appendChild(
      el('div', { class: 'comp-attainment__legend' }, ...legendItems),
    );
  }

  function refreshWaterfall(model) {
    waterfallContainer.innerHTML = '';
    const t = model.totals;
    const target = plan.annualTarget;
    const wonArr = t.wonQuotaArr;

    // How much ARR sits in each bracket today (won) and how much would
    // sit in each bracket if everything open closes.
    const tier1End = target;
    const tier2End = target * 1.5;

    function bucketize(totalArr) {
      const primary = Math.min(totalArr, tier1End);
      const accel1 = Math.max(0, Math.min(totalArr, tier2End) - tier1End);
      const accel2 = Math.max(0, totalArr - tier2End);
      return { primary, accel1, accel2 };
    }

    const wonBuckets = bucketize(wonArr);
    const projectedBuckets = bucketize(wonArr + t.openQuotaArr);

    const rows = [
      {
        label: `Primary (≤100%) — ${(plan.primaryRate * 100).toFixed(0)}%`,
        wonArr: wonBuckets.primary,
        projectedArr: projectedBuckets.primary,
        rate: plan.primaryRate,
      },
      {
        label: `Accelerator 1 (100-150%) — ${(plan.accelTier1Rate * 100).toFixed(0)}%`,
        wonArr: wonBuckets.accel1,
        projectedArr: projectedBuckets.accel1,
        rate: plan.accelTier1Rate,
      },
      {
        label: `Accelerator 2 (>150%) — ${(plan.accelTier2Rate * 100).toFixed(0)}%`,
        wonArr: wonBuckets.accel2,
        projectedArr: projectedBuckets.accel2,
        rate: plan.accelTier2Rate,
      },
      {
        label: `RidgePoint Flat — ${(plan.ridgepointFlatRate * 100).toFixed(0)}%`,
        wonArr: t.wonFlatArr,
        projectedArr: t.wonFlatArr + t.openFlatArr,
        rate: plan.ridgepointFlatRate,
      },
    ];

    const totalProjectedArr = Math.max(
      1,
      ...rows.map(r => r.projectedArr),
    );

    const rowEls = rows.map(r => {
      const wonComm = r.wonArr * r.rate;
      const projComm = r.projectedArr * r.rate;
      const wonPct = (r.wonArr / totalProjectedArr) * 100;
      const incPct = (Math.max(0, r.projectedArr - r.wonArr) / totalProjectedArr) * 100;
      return el('div', { class: 'comp-bracket__row' },
        el('div', { class: 'comp-bracket__row-label' }, r.label),
        el('div', { class: 'comp-bracket__row-bar' },
          wonPct > 0 ? el('div', {
            class: 'comp-bracket__seg comp-bracket__seg--won',
            style: { width: `${wonPct}%` },
            title: `Earned: ${formatCurrency(wonComm)} on ${formatCurrency(r.wonArr)}`,
          }) : null,
          incPct > 0 ? el('div', {
            class: 'comp-bracket__seg comp-bracket__seg--open',
            style: { width: `${incPct}%` },
            title: `If all open closes: +${formatCurrency(projComm - wonComm)}`,
          }) : null,
        ),
        el('div', { class: 'comp-bracket__row-values' },
          el('span', { class: 'comp-bracket__row-earned' }, formatCurrency(wonComm)),
          el('span', { class: 'comp-bracket__row-proj' },
            ` → ${formatCurrency(projComm)}`),
        ),
      );
    });

    waterfallContainer.appendChild(
      el('div', { class: 'comp-bracket__header' },
        el('h3', { class: 'comp-bracket__title' }, 'Commission by Bracket'),
        el('p', { class: 'comp-bracket__subtitle' },
          'Earned today → projection if every open quota deal closes'),
      ),
    );
    waterfallContainer.appendChild(el('div', { class: 'comp-bracket__rows' }, ...rowEls));
  }

  function refreshTable() {
    const model = getModel();
    const filtered = getFilteredEnriched(model);
    tableContainer.innerHTML = '';
    // Goal Gap is conceptually "future open quota deals you'd need to win,"
    // so it only makes sense when the filters could have shown an open
    // quota deal: hidden on closed/won/lost-only or non-quota filters.
    const showGoalGap = model.totals.goalGapArr > 0
      && (filters.statusGroup === 'all' || filters.statusGroup === 'open')
      && (filters.eligibility === 'all' || filters.eligibility === 'quota');
    tableContainer.appendChild(buildOppsTable(filtered, plan, model, { showGoalGap }));
  }

  function refreshAll() {
    const model = getModel();
    refreshStats(model);
    refreshAttainment(model);
    refreshWaterfall(model);
    refreshTable();
  }

  const content = el('div', {},
    el('div', { class: 'section-header' },
      el('div', {},
        el('h2', { class: 'section-header__title' }, 'Compensation Calculator'),
      ),
    ),

    planCard,

    statsContainer,

    el('div', { class: 'comp-grid' },
      el('div', { class: 'comp-grid__attainment' }, attainmentContainer),
      el('div', { class: 'comp-grid__bracket' }, waterfallContainer),
    ),

    el('div', { class: 'section-header' },
      el('div', {},
        el('h3', { class: 'section-header__title' }, 'Opportunity Detail'),
        el('p', { class: 'section-header__subtitle' },
          'Per-deal commission projection. Filter to focus on open pipeline or closed business.'),
      ),
    ),

    el('div', { class: 'filter-section' },
      el('div', { class: 'filter-bar filter-bar--wrap' },
        el('div', { class: 'filter-bar__search' },
          el('span', { class: 'search-bar__icon', html: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M12.5 12.5L16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' }),
          searchInput,
        ),
        statusSelect,
        eligibilitySelect,
        stageMultiSelect,
      ),
    ),

    tableContainer,
  );

  mount(container, content);
  refreshAll();
}

// ---- Plan editor card ----

function buildPlanCard(plan, onChange) {
  function numField(label, key, options = {}) {
    const { isPercent = false, step = '1' } = options;
    const value = isPercent ? (plan[key] * 100).toFixed(2) : plan[key];
    const input = el('input', {
      type: 'number',
      class: 'form-input comp-plan__input',
      value,
      step,
      min: '0',
      onChange: (e) => {
        const raw = parseFloat(e.target.value);
        if (!isFinite(raw)) return;
        plan[key] = isPercent ? raw / 100 : raw;
        onChange();
      },
    });
    return el('label', { class: 'comp-plan__field' },
      el('span', { class: 'comp-plan__label' }, label),
      el('div', { class: 'comp-plan__input-wrap' },
        isPercent ? null : el('span', { class: 'comp-plan__prefix' }, '$'),
        input,
        isPercent ? el('span', { class: 'comp-plan__suffix' }, '%') : null,
      ),
    );
  }

  // Collapsible state — defaults to collapsed, persisted to localStorage
  // so the rep doesn't have to keep re-collapsing on every page load.
  const COLLAPSE_KEY = 'pp_comp_plan_collapsed_v1';
  const stored = localStorage.getItem(COLLAPSE_KEY);
  const isOpen = stored === 'open';   // default = collapsed

  const chevronSvg = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const card = el('div', {
    class: `comp-plan comp-plan--collapsible ${isOpen ? 'comp-plan--open' : ''}`,
  });

  const header = el('button', {
    type: 'button',
    class: 'comp-plan__header comp-plan__header--toggle',
    'aria-expanded': isOpen ? 'true' : 'false',
    onClick: () => {
      const nowOpen = card.classList.toggle('comp-plan--open');
      header.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      try { localStorage.setItem(COLLAPSE_KEY, nowOpen ? 'open' : 'collapsed'); } catch {}
    },
  },
    el('div', { class: 'comp-plan__header-text' },
      el('span', { class: 'comp-plan__title' }, 'Plan Inputs'),
      el('span', { class: 'comp-plan__subtitle' },
        'Adjust to model "what-if" scenarios. Saved locally to your browser.'),
    ),
    el('span', { class: 'comp-plan__chevron', html: chevronSvg }),
  );

  const body = el('div', { class: 'comp-plan__body' },
    el('div', { class: 'comp-plan__grid' },
      numField('Annual Quota Target', 'annualTarget'),
      numField('Annual Quota Incentive', 'annualIncentive'),
      numField('Personal Goal', 'personalGoal'),
      numField('Primary Rate', 'primaryRate', { isPercent: true, step: '0.01' }),
      numField('Accelerator 100-150%', 'accelTier1Rate', { isPercent: true, step: '0.01' }),
      numField('Accelerator 150%+', 'accelTier2Rate', { isPercent: true, step: '0.01' }),
      numField('RidgePoint Flat Rate', 'ridgepointFlatRate', { isPercent: true, step: '0.01' }),
    ),
    el('div', { class: 'comp-plan__footer' },
      el('button', {
        class: 'btn btn--ghost btn--sm',
        onClick: () => {
          Object.assign(plan, DEFAULT_PLAN);
          try { localStorage.removeItem(PLAN_STORAGE_KEY); } catch {}
          onChange();
          // Re-render this card so the inputs reflect defaults
          const view = document.getElementById('view-container');
          if (view) renderView(view);
        },
      }, 'Reset to FY26 Plan'),
    ),
  );

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

// ---- Stage multi-select (lightweight clone of admin-opportunities) ----

function buildStageMultiSelect({ allStages, selected, onChange }) {
  const button = el('button', {
    type: 'button',
    class: 'multi-select__button form-select',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
  });

  const panel = el('div', { class: 'multi-select__panel', role: 'listbox' });

  const allCheckbox = el('input', { type: 'checkbox', class: 'multi-select__checkbox' });
  panel.appendChild(el('label', { class: 'multi-select__option multi-select__option--all' },
    allCheckbox, el('span', {}, 'All')));

  const stageCheckboxes = new Map();
  allStages.forEach(stage => {
    const cb = el('input', { type: 'checkbox', class: 'multi-select__checkbox', value: stage });
    cb.checked = selected.has(stage);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(stage); else selected.delete(stage);
      sync(); updateLabel(); onChange();
    });
    stageCheckboxes.set(stage, cb);
    panel.appendChild(el('label', { class: 'multi-select__option' }, cb, el('span', {}, stage)));
  });

  allCheckbox.addEventListener('change', () => {
    if (allCheckbox.checked) allStages.forEach(s => selected.add(s));
    else selected.clear();
    stageCheckboxes.forEach((cb, stage) => { cb.checked = selected.has(stage); });
    updateLabel(); onChange();
  });

  function sync() {
    allCheckbox.checked = selected.size === allStages.length;
    allCheckbox.indeterminate = selected.size > 0 && selected.size < allStages.length;
  }
  function updateLabel() {
    button.textContent = selected.size === allStages.length || allStages.length === 0
      ? 'All Stages' : `Stages: ${selected.size} selected`;
  }

  const wrapper = el('div', { class: 'multi-select filter-bar__select' }, button, panel);

  function setOpen(open) {
    wrapper.classList.toggle('multi-select--open', open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!wrapper.classList.contains('multi-select--open'));
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  // Self-removing — see the note in admin-opportunities' multi-select: one
  // listener per render accumulated on document holding detached DOM.
  const onDocClick = (e) => {
    if (!wrapper.isConnected) { document.removeEventListener('click', onDocClick); return; }
    if (!wrapper.contains(e.target)) setOpen(false);
  };
  document.addEventListener('click', onDocClick);

  sync(); updateLabel();
  return wrapper;
}

// ---- Opportunity table ----

function buildOppsTable(rows, plan, model, options = {}) {
  const { showGoalGap = false } = options;
  if (rows.length === 0 && !showGoalGap) {
    return el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'No opportunities match'),
      el('div', { class: 'empty-state__description' }, 'Try clearing filters above.'),
    );
  }

  const head = el('thead', {},
    el('tr', {},
      el('th', {}, 'Deal'),
      el('th', {}, 'Customer'),
      el('th', {}, 'Partner'),
      el('th', {}, 'Stage'),
      el('th', {}, 'Status'),
      el('th', { class: 'comp-table__num' }, 'Deal Value'),
      el('th', {}, 'Eligibility'),
      el('th', { class: 'comp-table__num' }, 'Earned'),
      el('th', { class: 'comp-table__num' }, 'If Won'),
      el('th', { class: 'comp-table__num' }, 'Weighted'),
      el('th', {}, 'Close Date'),
    ),
  );

  // Sort: Won → Open by close date → Lost. Within open, by close date.
  const sorted = [...rows].sort((a, b) => {
    const order = (e) => (e.isWon ? 0 : e.isOpen ? 1 : 2);
    const oa = order(a); const ob = order(b);
    if (oa !== ob) return oa - ob;
    return (a.opp.expected_close || '').localeCompare(b.opp.expected_close || '');
  });

  const realRows = sorted.map(e => {
    const statusClass = (e.status || 'registered').toLowerCase().replace(/\s+/g, '-');
    const earned = e.commissionEarned || 0;
    const ifWon = e.commissionIfWon || 0;
    const weighted = e.commissionWeighted || 0;

    return el('tr', { class: `comp-table__row comp-table__row--${e.eligibility}` },
      el('td', { class: 'comp-table__deal' }, e.opp.deal_name || '—'),
      el('td', {}, e.opp.customer_name || '—'),
      el('td', {}, e.partnerName || '—'),
      el('td', {}, el('span', { class: 'comp-table__stage' }, e.stage)),
      el('td', {}, el('span', { class: `badge badge--${statusClass}` }, e.status || '—')),
      el('td', { class: 'comp-table__num' }, formatCurrency(e.value)),
      el('td', {}, eligibilityBadge(e.eligibility, e.isRenewal)),
      el('td', { class: 'comp-table__num' }, e.isWon ? formatCurrency(earned) : '—'),
      el('td', { class: 'comp-table__num' }, e.isOpen ? formatCurrency(ifWon) : '—'),
      el('td', { class: 'comp-table__num' }, e.isOpen
        ? el('span', { title: `${(e.probability * 100).toFixed(0)}% × ${formatCurrency(ifWon)}` }, formatCurrency(weighted))
        : '—'),
      el('td', {}, e.opp.expected_close ? formatDate(e.opp.expected_close) : '—'),
    );
  });

  // Synthetic Goal Gap row — represents the additional ARR the rep would
  // need to close beyond their current pipeline to hit their personal goal.
  // Rendered as the final row so it visually reads as "next up."
  const goalGapRow = showGoalGap && model
    ? el('tr', { class: 'comp-table__row comp-table__row--goal-gap' },
        el('td', { class: 'comp-table__deal' },
          el('span', { class: 'comp-table__goal-marker' }, '🎯 '),
          'Goal Gap',
        ),
        el('td', {}, '—'),
        el('td', {}, '—'),
        el('td', {}, el('span', { class: 'comp-table__stage' }, 'Goal')),
        el('td', {}, el('span', { class: 'badge badge--registered' }, 'Stretch')),
        el('td', { class: 'comp-table__num' }, formatCurrency(model.totals.goalGapArr)),
        el('td', {}, el('span', { class: 'comp-eligibility comp-eligibility--goal' }, 'Goal')),
        el('td', { class: 'comp-table__num' }, '—'),
        el('td', { class: 'comp-table__num' }, formatCurrency(model.totals.goalGapCommission)),
        el('td', { class: 'comp-table__num' }, '—'),
        el('td', {}, '—'),
      )
    : null;

  const body = el('tbody', {}, ...realRows, goalGapRow);

  // Footer totals — include Goal Gap when shown so the bottom line matches
  // the "Total If Goal Hit" KPI.
  const totals = sorted.reduce((acc, e) => {
    acc.value += e.value;
    acc.earned += e.commissionEarned || 0;
    acc.ifWon += e.commissionIfWon || 0;
    acc.weighted += e.commissionWeighted || 0;
    return acc;
  }, { value: 0, earned: 0, ifWon: 0, weighted: 0 });

  if (showGoalGap && model) {
    totals.value += model.totals.goalGapArr;
    totals.ifWon += model.totals.goalGapCommission;
  }

  const dealLabel = showGoalGap
    ? `${sorted.length} deal${sorted.length === 1 ? '' : 's'} + Goal Gap`
    : `${sorted.length} deal${sorted.length === 1 ? '' : 's'}`;

  const foot = el('tfoot', {},
    el('tr', { class: 'comp-table__totals' },
      el('td', { colspan: 5 }, dealLabel),
      el('td', { class: 'comp-table__num' }, formatCurrency(totals.value)),
      el('td', {}, ''),
      el('td', { class: 'comp-table__num' }, formatCurrency(totals.earned)),
      el('td', { class: 'comp-table__num' }, formatCurrency(totals.ifWon)),
      el('td', { class: 'comp-table__num' }, formatCurrency(totals.weighted)),
      el('td', {}, ''),
    ),
  );

  return el('div', { class: 'comp-table-wrap' },
    el('table', { class: 'comp-table' }, head, body, foot),
  );
}

function eligibilityBadge(elig, isRenewal) {
  const map = {
    quota: { label: 'Quota', cls: 'comp-eligibility--quota' },
    flat: { label: 'Flat 5%', cls: 'comp-eligibility--flat' },
    excluded: {
      label: isRenewal ? 'Excluded (Renewal)' : 'Excluded',
      cls: 'comp-eligibility--excluded',
    },
  };
  const m = map[elig] || map.quota;
  return el('span', { class: `comp-eligibility ${m.cls}` }, m.label);
}
