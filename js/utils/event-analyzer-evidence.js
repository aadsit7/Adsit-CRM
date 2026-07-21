// ============================================================
// Event evidence builders — privacy-safe aggregates + deterministic facts
// ============================================================
// Pure functions that turn raw CRM rows (Event_Contacts, Opportunities,
// saved Event_Playbook state) into:
//   • privacy-safe AGGREGATES for the prompt (counts only — never a name,
//     never an email, never any unnecessary PII), and
//   • FACTS for the parser:
//       deterministic     — hard CRM facts overlaid after model parsing
//                            (a scheduled date, linked opps, closed-won deals)
//       structuredSupport — which structured model claims may stand
//       savedChecked      — manually-confirmed saved-playbook activities
//
// The split matters: the model is shown aggregates so it can reason, but it
// is NEVER trusted to interpret a count — the parser validates every
// structured claim against these facts and overlays the hard ones itself.
//
// No DOM, no network — fully testable under Node.
// ============================================================

import { activityIdAt, ACTIVITY_IDS } from './event-analyzer-stages.js';

// ── Selection helpers (strict event_id filtering) ───────────────────
// Every event evidence source is filtered STRICTLY by event_id so one
// event's analysis can never pick up another event's rows. Kept here (pure,
// DOM-free) so the view's data plumbing is unit-testable.

/**
 * This event's Event_Descriptions rows, oldest first (the order the prompt
 * and grounding rely on).
 */
export function selectEventDescriptions(rows, eventId) {
  const id = String(eventId || '').trim();
  return (rows || [])
    .filter(d => d && String(d.event_id || '').trim() === id)
    .slice()
    .sort((a, b) => (Date.parse(a.description_date || a.created_at) || 0) - (Date.parse(b.description_date || b.created_at) || 0));
}

/** This event's Event_Contacts rows (unsorted; aggregated before use). */
export function selectEventContacts(rows, eventId) {
  const id = String(eventId || '').trim();
  return (rows || []).filter(c => c && String(c.event_id || '').trim() === id);
}

// ── Contact aggregates (privacy-safe) ───────────────────────────────
/**
 * Aggregate a list of Event_Contacts rows (already filtered to one event)
 * into counts only. No names, titles, companies or emails leave this
 * function — the aggregate is what the prompt is allowed to see.
 *
 * @param {Array} contacts  Event_Contacts rows for one event.
 * @returns {{
 *   total:number, withRole:number, withSeniority:number, withOwner:number,
 *   ownerCoveragePct:number, meetingCount:number,
 *   byStatus:Object<string,number>, byRole:Object<string,number>
 * }}
 */
export function buildContactAggregates(contacts) {
  const list = Array.isArray(contacts) ? contacts : [];
  const agg = {
    total: 0,
    withRole: 0,
    withSeniority: 0,
    withOwner: 0,
    ownerCoveragePct: 0,
    meetingCount: 0,
    byStatus: {},
    byRole: {},
  };

  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    agg.total += 1;

    const role = String(c.icp_role || '').trim();
    if (role) { agg.withRole += 1; agg.byRole[role] = (agg.byRole[role] || 0) + 1; }

    if (String(c.seniority_tier || '').trim()) agg.withSeniority += 1;
    if (String(c.owner || '').trim()) agg.withOwner += 1;

    const status = String(c.status || '').trim().toLowerCase();
    if (status) agg.byStatus[status] = (agg.byStatus[status] || 0) + 1;
    if (status === 'meeting') agg.meetingCount += 1;
  }

  agg.ownerCoveragePct = agg.total > 0 ? Math.round((agg.withOwner / agg.total) * 100) : 0;
  return agg;
}

// ── Linked-opportunity facts ────────────────────────────────────────
// A linked opportunity is one whose `lead_source` equals this event's id.
// Closed-won is an EXPLICIT won status — open pipeline value is never
// treated as closed-won revenue.
function isClosedWon(opp) {
  const status = String(opp.status || '').trim().toLowerCase();
  const stage = String(opp.stage || '').trim().toLowerCase();
  if (/lost/.test(status)) return false;
  if (status === 'won' || status === 'closed won' || status === 'closed-won') return true;
  // A "Closed" stage combined with a won status also counts.
  return stage === 'closed' && /won/.test(status);
}

/**
 * Summarize the opportunities linked to an event into counts only.
 *
 * @param {Array}  opportunities  All Opportunities rows.
 * @param {string} eventId        The event's id (matched against lead_source).
 * @returns {{ count:number, closedWonCount:number, openCount:number,
 *   byStatus:Object<string,number>, ids:string[], closedWonIds:string[] }}
 */
export function buildLinkedOppFacts(opportunities, eventId) {
  const id = String(eventId || '').trim();
  const facts = { count: 0, closedWonCount: 0, openCount: 0, byStatus: {}, ids: [], closedWonIds: [] };
  if (!id) return facts;

  for (const opp of (Array.isArray(opportunities) ? opportunities : [])) {
    if (!opp || String(opp.lead_source || '').trim() !== id) continue;
    facts.count += 1;
    const oppId = String(opp.opportunity_id || '').trim();
    if (oppId) facts.ids.push(oppId);

    const status = String(opp.status || '').trim() || 'Unknown';
    facts.byStatus[status] = (facts.byStatus[status] || 0) + 1;

    if (isClosedWon(opp)) {
      facts.closedWonCount += 1;
      if (oppId) facts.closedWonIds.push(oppId);
    } else if (!/lost/i.test(status)) {
      facts.openCount += 1;
    }
  }
  return facts;
}

// ── Saved playbook state ────────────────────────────────────────────
/**
 * Parse saved Event_Playbook state into checked-activity facts. Accepts the
 * standalone serialized shape — an array of
 *   { key, gate, note, acts:[{ x, o, dt, d }] }
 * — as a JS array OR a JSON string, or a keyed object { key: {note, acts} }
 * (the loadPlaybook return shape). Positional `acts[i]` are mapped onto
 * stable activity ids via activityIdAt(stageKey, i).
 *
 * @param {Array|string|object|null} raw
 * @returns {{ found:boolean, checked:Object<string,{date:string}>, notes:Object<string,string> }}
 */
export function parseSavedPlaybook(raw) {
  const out = { found: false, checked: {}, notes: {} };
  if (raw == null || raw === '') return out;

  let stages = raw;
  if (typeof raw === 'string') {
    try { stages = JSON.parse(raw); } catch { return out; }
  }

  // Normalize to an array of { key, note, acts }.
  let list = [];
  if (Array.isArray(stages)) {
    list = stages;
  } else if (stages && typeof stages === 'object') {
    list = Object.keys(stages).map(key => ({ key, note: stages[key] && stages[key].note, acts: stages[key] && stages[key].acts }));
  } else {
    return out;
  }

  for (const stage of list) {
    if (!stage || typeof stage !== 'object') continue;
    const key = String(stage.key || '').trim();
    if (!key) continue;
    out.found = true;
    const note = String(stage.note || '').trim();
    if (note) out.notes[key] = note;

    const acts = Array.isArray(stage.acts) ? stage.acts : [];
    acts.forEach((a, j) => {
      if (!a || typeof a !== 'object') return;
      if (!a.d) return; // only checked activities are operational confirmations
      const idx = (a.i != null && !Number.isNaN(Number(a.i))) ? Number(a.i) : j;
      const activityId = activityIdAt(key, idx);
      if (activityId && ACTIVITY_IDS.has(activityId)) {
        out.checked[activityId] = { date: String(a.dt || '').trim() };
      }
    });
  }
  return out;
}

// ── Deterministic + structured facts for the parser ─────────────────
/**
 * A non-empty, parseable date string. A scheduled date deterministically
 * satisfies "Date scheduled" — but note it says NOTHING about whether the
 * event has happened (that needs other evidence).
 */
function validDate(v) {
  const s = String(v || '').trim();
  return s && !Number.isNaN(Date.parse(s)) ? s : '';
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Build the `facts` object the parser consumes:
 *   { deterministic, structuredSupport, savedChecked }
 *
 * @param {object} params
 * @param {object} params.event          Events row (event_id, event_date, event_type, ...)
 * @param {object} params.contacts       buildContactAggregates() result.
 * @param {object} params.linkedOpps     buildLinkedOppFacts() result.
 * @param {object} params.savedPlaybook  parseSavedPlaybook() result.
 */
export function buildEventFacts({ event, contacts, linkedOpps, savedPlaybook } = {}) {
  const ev = event || {};
  const agg = contacts || { total: 0, withRole: 0, withSeniority: 0, withOwner: 0, meetingCount: 0 };
  const opps = linkedOpps || { count: 0, closedWonCount: 0, ids: [], closedWonIds: [] };
  const saved = savedPlaybook || { checked: {} };

  const deterministic = {};
  const structuredSupport = {};

  // setup_date — a valid scheduled date is a hard fact.
  const eventDate = validDate(ev.event_date);
  if (eventDate) {
    const typeLabel = String(ev.event_type || '').trim();
    deterministic.setup_date = {
      status: 'met',
      source_type: 'event_metadata',
      evidence: `Event date scheduled for ${eventDate}${typeLabel ? ` (${typeLabel})` : ''}.`,
      source_id: String(ev.event_id || '').trim(),
      source_date: eventDate,
    };
  }

  // results_opportunities — linked opps are deterministic evidence.
  if (opps.count > 0) {
    deterministic.results_opportunities = {
      status: 'met',
      source_type: 'linked_opportunities',
      evidence: `${plural(opps.count, 'opportunity', 'opportunities')} linked to this event via lead source.`,
      source_id: opps.ids[0] || '',
      source_date: '',
    };
  }

  // results_closed_won — only an EXPLICIT closed-won status counts.
  if (opps.closedWonCount > 0) {
    deterministic.results_closed_won = {
      status: 'met',
      source_type: 'linked_opportunities',
      evidence: `${plural(opps.closedWonCount, 'linked opportunity', 'linked opportunities')} marked closed-won.`,
      source_id: opps.closedWonIds[0] || '',
      source_date: '',
    };
  }

  // Structured support — the model may claim these if the backing fact exists,
  // but they never PROVE completion on their own (the model decides met vs
  // partial from the aggregates).
  if (agg.total > 0) structuredSupport.audience_upload = true;
  if (agg.withRole > 0 || agg.withSeniority > 0) structuredSupport.audience_roles = true;
  if (agg.withOwner > 0) structuredSupport.audience_owners = true;
  if (agg.meetingCount > 0) structuredSupport.results_meetings = true;

  return { deterministic, structuredSupport, savedChecked: saved.checked || {} };
}
