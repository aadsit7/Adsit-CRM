// ============================================================
// Partner evidence builders — strict scoping, privacy, KPIs, coverage
// ============================================================
// Pure functions that turn raw CRM rows into everything the Partner Analyzer
// needs, WITHOUT ever leaking another partner's data or any PII/secret:
//
//   • strict partner-scoped SELECTION helpers (partner_id / opportunity_id /
//     event_id filtering — one partner's analysis can never pull in another's
//     rows, and UNASSIGNED events are never counted as this partner's activity)
//   • deterministic KPI AGGREGATES computed in application code (never by the
//     model): counts, active pipeline value, won revenue, activity dates
//   • deterministic + structured CRITERIA FACTS for the strict parser
//   • bounded, privacy-safe EVIDENCE assembly with an explicit COVERAGE object
//   • parser ANCHORS (valid ids/dates + source text for grounding)
//
// Privacy: EVENT contact rows (attendees) are reduced to counts only
// (reusing the Event Analyzer's tested aggregator). Saved PARTNER contacts
// (Partner_Contacts — the deliberately saved partner-side roster the Contact
// Analyzer already exposes by name) are passed as contact_id + name + role
// ONLY, for the likely org chart. Password hashes, usernames, event
// passwords, contact emails/phones and API keys never enter any output of
// this module.
//
// No DOM, no network — fully testable under Node.
// ============================================================

import { stripHtml } from './forecast-prompts.js';
import { buildContactAggregates } from './event-analyzer-evidence.js';
import { parseSavedPlaybook } from './event-analyzer-evidence.js';

// Re-export so the Analyzer view and client can aggregate contacts without a
// second import path.
export { buildContactAggregates };

// ── Bounded-evidence limits (named so they can be tuned in one place) ─
export const EVIDENCE_LIMITS = {
  transcripts: 12,
  meetings: 12,
  documents: 8,
  opportunityDescriptions: 20,
  eventDescriptions: 15,
  charsPerItem: 2200,
  totalChars: 60_000,
};

// ── Date helpers ────────────────────────────────────────────────────
function toMs(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const ms = Date.parse(s.length <= 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(ms) ? null : ms;
}
function firstDate(...vals) {
  for (const v of vals) { const s = String(v || '').trim(); if (s) return s; }
  return '';
}
/** Newest ISO date among `dates` that is <= today (a real, past activity). */
function latestPastDate(dates, todayMs) {
  let best = null; let bestStr = '';
  for (const d of dates) {
    const ms = toMs(d);
    if (ms == null || ms > todayMs) continue;
    if (best == null || ms > best) { best = ms; bestStr = String(d).slice(0, 10); }
  }
  return bestStr;
}
/** Oldest ISO date among `dates` that is <= today (the first real touchpoint). */
function earliestPastDate(dates, todayMs) {
  let best = null; let bestStr = '';
  for (const d of dates) {
    const ms = toMs(d);
    if (ms == null || ms > todayMs) continue;
    if (best == null || ms < best) { best = ms; bestStr = String(d).slice(0, 10); }
  }
  return bestStr;
}

// ── Opportunity status semantics (mirrors the app's real filters) ────
// The app treats `status === 'Won'` as won and `status === 'Lost'` as lost
// (see admin-partner-detail.js pipeline math and filters.js). Everything else
// is genuinely active pipeline — we never assume a non-Won value is inactive.
export function isWonOpp(opp) {
  return String(opp && opp.status || '').trim().toLowerCase() === 'won';
}
export function isLostOpp(opp) {
  const s = String(opp && opp.status || '').trim().toLowerCase();
  return s === 'lost' || s === 'closed lost' || s === 'closed-lost';
}
export function isActiveOpp(opp) {
  return !isWonOpp(opp) && !isLostOpp(opp);
}
function oppValue(opp) {
  const n = parseFloat(opp && opp.deal_value);
  return Number.isFinite(n) ? n : 0;
}

// ── Strict partner-scoped selection ─────────────────────────────────
/** Transcripts for exactly this partner, NEWEST first (for bounded selection). */
export function selectPartnerTranscripts(rows, partnerId) {
  const id = String(partnerId || '').trim();
  return (rows || [])
    .filter(t => t && String(t.partner_id || '').trim() === id)
    .slice()
    .sort((a, b) => (toMs(firstDate(b.conversation_date, b.created_at)) || 0) - (toMs(firstDate(a.conversation_date, a.created_at)) || 0));
}

/** Meeting_Index rows for exactly this partner, newest first. */
export function selectPartnerMeetings(rows, partnerId) {
  const id = String(partnerId || '').trim();
  return (rows || [])
    .filter(m => m && String(m.partner_id || '').trim() === id)
    .slice()
    .sort((a, b) => (toMs(a.meeting_date) || 0) < (toMs(b.meeting_date) || 0) ? 1 : -1);
}

/** Partner_Documents rows for exactly this partner, newest first. */
export function selectPartnerDocuments(rows, partnerId) {
  const id = String(partnerId || '').trim();
  return (rows || [])
    .filter(d => d && String(d.partner_id || '').trim() === id)
    .slice()
    .sort((a, b) => (toMs(firstDate(b.updated_at, b.created_at)) || 0) - (toMs(firstDate(a.updated_at, a.created_at)) || 0));
}

/** Opportunities for exactly this partner (strict partner_id). */
export function selectPartnerOpportunities(rows, partnerId) {
  const id = String(partnerId || '').trim();
  return (rows || []).filter(o => o && String(o.partner_id || '').trim() === id);
}

/**
 * Events for exactly this partner — STRICT partner_id match.
 *
 * IMPORTANT: this deliberately does NOT reproduce the Partner Detail page's
 * broad display rule (`!event.partner_id || event.partner_id === id`). An
 * unassigned event is not evidence of THIS partner's activity, so it is
 * excluded here.
 */
export function selectPartnerEvents(rows, partnerId) {
  const id = String(partnerId || '').trim();
  return (rows || []).filter(e => e && String(e.partner_id || '').trim() === id);
}

/** The set of opportunity_ids belonging to a partner's opportunities. */
export function collectOpportunityIds(opps) {
  return new Set((opps || []).map(o => String(o && o.opportunity_id || '').trim()).filter(Boolean));
}
/** The set of event_ids belonging to a partner's events. */
export function collectEventIds(events) {
  return new Set((events || []).map(e => String(e && e.event_id || '').trim()).filter(Boolean));
}

/** Opportunity_Descriptions restricted to the given opportunity id set. */
export function selectOpportunityDescriptions(rows, oppIds) {
  const ids = oppIds instanceof Set ? oppIds : new Set(oppIds || []);
  return (rows || [])
    .filter(d => d && ids.has(String(d.opportunity_id || '').trim()))
    .slice()
    .sort((a, b) => (toMs(firstDate(b.description_date, b.created_at)) || 0) - (toMs(firstDate(a.description_date, a.created_at)) || 0));
}

/** Event_Descriptions restricted to the given event id set. */
export function selectEventDescriptionsForPartner(rows, eventIds) {
  const ids = eventIds instanceof Set ? eventIds : new Set(eventIds || []);
  return (rows || [])
    .filter(d => d && ids.has(String(d.event_id || '').trim()))
    .slice()
    .sort((a, b) => (toMs(firstDate(b.description_date, b.created_at)) || 0) - (toMs(firstDate(a.description_date, a.created_at)) || 0));
}

/** Event_Contacts restricted to the given event id set (aggregated before use). */
export function selectEventContactsForPartner(rows, eventIds) {
  const ids = eventIds instanceof Set ? eventIds : new Set(eventIds || []);
  return (rows || []).filter(c => c && ids.has(String(c.event_id || '').trim()));
}

// ── Saved partner contacts (Partner_Contacts — the org-chart roster) ─
// Unlike EVENT contacts (event attendees — reduced to counts only), the
// Partner_Contacts sheet holds the partner-side people deliberately saved on
// this partner's record; the Contact Analyzer already sends their name/role
// to the model. The Partner Analyzer uses them as the roster for its likely
// org chart — restricted to contact_id + name + role. Emails, phones,
// evidence text and LeadCheck payloads NEVER leave this module.

/** How many saved contacts the roster may carry into the prompt. */
export const CONTACT_ROSTER_LIMIT = 60;

/** Partner_Contacts rows for exactly this partner (strict partner_id). */
export function selectPartnerContacts(rows, partnerId) {
  const id = String(partnerId || '').trim();
  if (!id) return [];
  return (rows || []).filter(c => c
    && String(c.partner_id || '').trim() === id
    && String(c.contact_id || '').trim());
}

/**
 * Build the privacy-safe org-chart roster from partner-scoped contact rows:
 * `{ contact_id, name, role }` ONLY, named rows only (an org-chart node needs
 * a person's name, and a nameless email-only row would leak the email as its
 * label), A→Z, bounded with an explicit omitted count.
 *
 * @param {Array} contacts  selectPartnerContacts() rows.
 * @param {number} [limit]  Override for CONTACT_ROSTER_LIMIT.
 * @returns {{ total: number, included: Array<{contact_id,name,role}>, omittedCount: number }}
 */
export function buildPartnerContactRoster(contacts, limit = CONTACT_ROSTER_LIMIT) {
  const named = (contacts || [])
    .map(c => ({
      contact_id: String(c && c.contact_id || '').trim(),
      name: String(c && c.name || '').trim(),
      role: String(c && c.role || '').trim(),
    }))
    .filter(c => c.contact_id && c.name)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const cap = Math.max(0, limit);
  return {
    total: named.length,
    included: named.slice(0, cap),
    omittedCount: Math.max(0, named.length - cap),
  };
}

// ── Partner selector population ─────────────────────────────────────
/**
 * The partners an administrator may analyze: a valid partner_id, NOT an admin
 * row, sorted by display_name case-insensitively. Inactive partners are kept —
 * an admin may need to analyze why a relationship became inactive.
 */
export function selectAnalyzablePartners(partners) {
  return (partners || [])
    .filter(p => p && String(p.partner_id || '').trim() && String(p.is_admin || '').trim().toUpperCase() !== 'TRUE')
    .slice()
    .sort((a, b) => String(a.display_name || '').toLowerCase().localeCompare(String(b.display_name || '').toLowerCase()));
}

/**
 * Build labelled selector options. Suggested format: `Name — Type · Tier`.
 * Duplicate display names are disambiguated by appending the region (then the
 * partner id) so the admin can tell them apart.
 */
export function buildPartnerSelectorOptions(partners) {
  const list = selectAnalyzablePartners(partners);
  const nameCounts = list.reduce((acc, p) => {
    const n = String(p.display_name || '').trim().toLowerCase();
    acc[n] = (acc[n] || 0) + 1; return acc;
  }, {});
  return list.map(p => {
    const name = String(p.display_name || 'Unnamed partner').trim() || 'Unnamed partner';
    const bits = [String(p.partner_type || '').trim(), String(p.tier || '').trim()].filter(Boolean);
    let label = bits.length ? `${name} — ${bits.join(' · ')}` : name;
    if (nameCounts[name.toLowerCase()] > 1) {
      const disamb = String(p.region || '').trim() || String(p.partner_id || '').trim();
      if (disamb) label += ` (${disamb})`;
    }
    return { id: String(p.partner_id || '').trim(), label, partner: p };
  });
}

// ── Deterministic KPIs (computed in app code, never by the model) ────
/**
 * Compute the deterministic KPI strip. Every number here is application-
 * computed; the model is never trusted with any of them.
 *
 * @param {object} params
 * @param {object} params.partner
 * @param {Array} params.transcripts   Partner-scoped transcripts.
 * @param {Array} params.meetings      Partner-scoped Meeting_Index rows.
 * @param {Array} params.documents     Partner-scoped Partner_Documents.
 * @param {Array} params.events        Partner-scoped (STRICT) events.
 * @param {Array} params.opportunities Partner-scoped opportunities.
 * @param {Array} [params.opportunityDescriptions] Scoped opp descriptions (for activity dates).
 * @param {Array} [params.eventDescriptions]       Scoped event descriptions (for activity dates).
 * @param {string} [params.today]      Injectable YYYY-MM-DD.
 * @returns {object} KPI facts.
 */
export function buildPartnerKpis({
  partner, transcripts, meetings, documents, events, opportunities,
  opportunityDescriptions = [], eventDescriptions = [], today,
} = {}) {
  const todayISO = String(today || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const todayMs = toMs(todayISO);

  const opps = opportunities || [];
  const evts = events || [];

  const wonOpps = opps.filter(isWonOpp);
  const activeOpps = opps.filter(isActiveOpp);
  const wonRevenue = wonOpps.reduce((s, o) => s + oppValue(o), 0);
  const activePipelineValue = activeOpps.reduce((s, o) => s + oppValue(o), 0);

  const stageDistribution = {};
  for (const o of opps) {
    const st = String(o.stage || '').trim() || 'Unspecified';
    stageDistribution[st] = (stageDistribution[st] || 0) + 1;
  }

  // Nearest FUTURE expected close among active opps.
  let nearestExpectedClose = '';
  let nearestMs = Infinity;
  for (const o of activeOpps) {
    const ms = toMs(o.expected_close);
    if (ms != null && ms >= todayMs && ms < nearestMs) { nearestMs = ms; nearestExpectedClose = String(o.expected_close).slice(0, 10); }
  }

  // Event timing.
  const eventStatus = (e) => String(e.status || '').trim().toLowerCase();
  const upcomingEvents = evts.filter(e => eventStatus(e) === 'upcoming' || eventStatus(e) === 'in progress');
  const completedEvents = evts.filter(e => eventStatus(e) === 'completed');
  let nextEventDate = ''; let nextMs = Infinity;
  let mostRecentEventDate = ''; let recentEvtMs = -Infinity;
  for (const e of evts) {
    const ms = toMs(e.event_date);
    if (ms == null) continue;
    if (ms >= todayMs && ms < nextMs) { nextMs = ms; nextEventDate = String(e.event_date).slice(0, 10); }
    if (ms <= todayMs && ms > recentEvtMs) { recentEvtMs = ms; mostRecentEventDate = String(e.event_date).slice(0, 10); }
  }

  // Most recent MEANINGFUL activity date (something that has happened, <= today).
  const activityDates = [];
  transcripts && transcripts.forEach(t => activityDates.push(firstDate(t.conversation_date, t.created_at)));
  meetings && meetings.forEach(m => activityDates.push(m.meeting_date));
  documents && documents.forEach(d => activityDates.push(firstDate(d.updated_at, d.created_at)));
  opportunityDescriptions && opportunityDescriptions.forEach(d => activityDates.push(firstDate(d.description_date, d.created_at)));
  eventDescriptions && eventDescriptions.forEach(d => activityDates.push(firstDate(d.description_date, d.created_at)));
  opps.forEach(o => activityDates.push(firstDate(o.updated_at, o.created_at)));
  completedEvents.forEach(e => activityDates.push(e.event_date));
  const mostRecentActivityDate = latestPastDate(activityDates, todayMs);
  // The earliest real touchpoint — used as a fallback for partnership age when
  // the Partners row has no created_at ("when we first engaged").
  const firstActivityDate = earliestPastDate(activityDates, todayMs);

  // Distinct interactions: meetings whose transcript_id matches a transcript
  // are NOT double-counted (they are metadata for the same conversation).
  const standaloneMeetings = dedupeMeetingsAgainstTranscripts(meetings, transcripts);

  return {
    partner_id: String(partner && partner.partner_id || '').trim(),
    partner_type: String(partner && partner.partner_type || '').trim(),
    region: String(partner && partner.region || '').trim(),
    tier: String(partner && partner.tier || '').trim(),
    status: String(partner && partner.status || '').trim(),
    hq_location: String(partner && partner.hq_location || '').trim(),
    created_at: String(partner && partner.created_at || '').trim(),

    transcriptCount: (transcripts || []).length,
    meetingCount: (meetings || []).length,
    standaloneMeetingCount: standaloneMeetings.length,
    documentCount: (documents || []).length,

    eventCount: evts.length,
    upcomingEventCount: upcomingEvents.length,
    completedEventCount: completedEvents.length,
    nextEventDate,
    mostRecentEventDate,

    totalOpps: opps.length,
    activeOppCount: activeOpps.length,
    activePipelineValue,
    wonOppCount: wonOpps.length,
    wonRevenue,
    stageDistribution,
    nearestExpectedClose,

    firstOppId: String((opps[0] || {}).opportunity_id || '').trim(),
    firstActiveOppId: String((activeOpps[0] || {}).opportunity_id || '').trim(),
    firstWonOppId: String((wonOpps[0] || {}).opportunity_id || '').trim(),
    firstCompletedEventId: String((completedEvents[0] || {}).event_id || '').trim(),
    firstUpcomingEventId: String((upcomingEvents[0] || {}).event_id || '').trim(),

    mostRecentActivityDate,
    firstActivityDate,
    today: todayISO,
  };
}

/**
 * Meeting_Index rows that DON'T share a transcript_id with a supplied
 * transcript — i.e. meetings that are their own independent interaction. Used
 * so a Meeting_Index row and its source transcript are not counted twice.
 */
export function dedupeMeetingsAgainstTranscripts(meetings, transcripts) {
  const transcriptIds = new Set((transcripts || [])
    .map(t => String(t && t.transcript_id || '').trim()).filter(Boolean));
  return (meetings || []).filter(m => {
    const tid = String(m && m.transcript_id || '').trim();
    return !(tid && transcriptIds.has(tid));
  });
}

// ── Deterministic + structured criteria facts (parser input) ────────
/**
 * Build the `facts` object the strict parser consumes:
 *   { deterministic: { [criterionId]: {status, source_type, evidence, source_id, source_date, related_entity_id} },
 *     structuredSupport: { [criterionId]: true } }
 *
 * `deterministic` facts are AUTHORITATIVE — overlaid after parsing so hard CRM
 * results (a real won opportunity, active pipeline, linked opps, a scheduled
 * event) are always reflected regardless of what the model said.
 * `structuredSupport` gates a model claim on a STRUCTURED source_type
 * (partner_profile / opportunity / event / event_contacts / saved_event_playbook):
 * the claim survives validation only if the backing fact exists.
 */
export function buildPartnerCriteriaFacts({ partner, kpis, contactsAgg, savedPlaybook, contactRoster } = {}) {
  const p = partner || {};
  const k = kpis || {};
  const contacts = contactsAgg || { total: 0, meetingCount: 0 };
  const saved = savedPlaybook || { found: false, checked: {} };
  const rosterCount = (contactRoster && contactRoster.included && contactRoster.included.length) || 0;

  const deterministic = {};
  const structuredSupport = {};

  // partner_profile_complete — an explicit, documented rule on the Partners row.
  const profileFields = [p.partner_type, p.region, p.hq_location, p.display_name].map(v => String(v || '').trim());
  const profileComplete = profileFields.every(Boolean);
  if (String(p.partner_id || '').trim()) {
    structuredSupport.partner_profile_complete = true; // partner_profile source always available
    if (profileComplete) {
      deterministic.partner_profile_complete = {
        status: 'met',
        source_type: 'partner_profile',
        evidence: `Partner profile documents type (${profileFields[0]}), region (${profileFields[1]}) and HQ/location (${profileFields[2]}).`,
        source_id: String(p.partner_id).trim(),
        source_date: String(p.created_at || '').trim(),
        related_entity_id: String(p.partner_id).trim(),
      };
    }
  }

  // relationship_established — a real, substantive transcript or indexed meeting.
  if ((k.transcriptCount || 0) > 0 || (k.meetingCount || 0) > 0) {
    structuredSupport.relationship_established = true;
    deterministic.relationship_established = {
      status: 'met',
      source_type: (k.transcriptCount || 0) > 0 ? 'transcript' : 'meeting_index',
      evidence: `A substantive partner interaction is on record (${k.transcriptCount || 0} transcript(s), ${k.meetingCount || 0} indexed meeting(s)).`,
      source_id: '',
      source_date: k.mostRecentActivityDate || '',
      related_entity_id: String(p.partner_id || '').trim(),
    };
  }

  // key_stakeholders_identified — meeting attendees, saved event contacts, or
  // saved Partner_Contacts rows (the criterion's own label names "structured
  // CRM records" as valid evidence; a saved roster is exactly that).
  if ((contacts.total || 0) > 0 || (k.meetingCount || 0) > 0 || rosterCount > 0) {
    structuredSupport.key_stakeholders_identified = true;
  }

  // Market engagement — structured support from events/contacts/saved playbook.
  if ((k.eventCount || 0) > 0) structuredSupport.joint_activity_launched = true;
  if ((contacts.total || 0) > 0) structuredSupport.audience_engaged = true;
  const savedFollowup = savedStageChecks(saved, ['followup']);
  if ((contacts.meetingCount || 0) > 0 || savedFollowup > 0) structuredSupport.follow_up_executed = true;

  // joint_activity_launched — a completed/in-progress event is deterministic
  // met; a merely upcoming event is deterministic PARTIAL (planned, not done).
  if ((k.completedEventCount || 0) > 0) {
    deterministic.joint_activity_launched = {
      status: 'met',
      source_type: 'event',
      evidence: `${k.completedEventCount} partner-specific event(s) completed.`,
      source_id: String(k.firstCompletedEventId || '').trim(),
      source_date: k.mostRecentEventDate || '',
      related_entity_id: String(k.firstCompletedEventId || '').trim(),
    };
  } else if ((k.upcomingEventCount || 0) > 0) {
    deterministic.joint_activity_launched = {
      status: 'partial',
      source_type: 'event',
      evidence: `${k.upcomingEventCount} partner-specific event(s) scheduled but not yet held.`,
      source_id: String(k.firstUpcomingEventId || '').trim(),
      source_date: k.nextEventDate || '',
      related_entity_id: String(k.firstUpcomingEventId || '').trim(),
    };
  }

  // opportunities_created — one or more real linked opportunities.
  if ((k.totalOpps || 0) > 0) {
    structuredSupport.opportunities_created = true;
    deterministic.opportunities_created = {
      status: 'met',
      source_type: 'opportunity',
      evidence: `${k.totalOpps} opportunity row(s) linked to this partner.`,
      source_id: String(k.firstOppId || '').trim(),
      source_date: '',
      related_entity_id: String(k.firstOppId || '').trim(),
    };
  }

  // active_pipeline — active count AND deterministic pipeline value > 0.
  if ((k.activeOppCount || 0) > 0 && (k.activePipelineValue || 0) > 0) {
    structuredSupport.active_pipeline = true;
    deterministic.active_pipeline = {
      status: 'met',
      source_type: 'opportunity',
      evidence: `${k.activeOppCount} active opportunity(ies) totaling a deterministic pipeline of ${k.activePipelineValue}.`,
      source_id: String(k.firstActiveOppId || '').trim(),
      source_date: '',
      related_entity_id: String(k.firstActiveOppId || '').trim(),
    };
  }

  // deal_progression — allow a structured opportunity claim only when there is
  // genuinely active pipeline to progress (still needs narrative for "met").
  if ((k.activeOppCount || 0) > 0) structuredSupport.deal_progression = true;

  // revenue_won — at least one explicitly closed-won opportunity.
  if ((k.wonOppCount || 0) > 0) {
    structuredSupport.revenue_won = true;
    deterministic.revenue_won = {
      status: 'met',
      source_type: 'opportunity',
      evidence: `${k.wonOppCount} linked opportunity(ies) explicitly closed won (deterministic won revenue ${k.wonRevenue}).`,
      source_id: String(k.firstWonOppId || '').trim(),
      source_date: '',
      related_entity_id: String(k.firstWonOppId || '').trim(),
    };
  }

  // repeatable_motion — NEVER from a single deal/event. Documented threshold:
  // at least two opportunities, or two completed events, or one of each, or
  // multiple wins.
  const opps = k.totalOpps || 0;
  const doneEvents = k.completedEventCount || 0;
  const wins = k.wonOppCount || 0;
  if (opps >= 2 || doneEvents >= 2 || (opps >= 1 && doneEvents >= 1) || wins >= 2) {
    structuredSupport.repeatable_motion = true;
  }

  return { deterministic, structuredSupport };
}

// Count saved-playbook checked activities whose id starts with one of the
// given stage keys (e.g. 'followup', 'drive'). Partner-scoped saved playbook
// is aggregated across the partner's strictly-assigned events upstream.
function savedStageChecks(saved, stageKeys) {
  const checked = (saved && saved.checked) || {};
  const keys = stageKeys || [];
  return Object.keys(checked).filter(id => keys.some(k => String(id).startsWith(`${k}_`))).length;
}

// ── Bounded, privacy-safe evidence assembly + coverage ──────────────
function truncate(text, cap) {
  const s = String(text || '');
  if (s.length <= cap) return { text: s, truncated: false };
  return { text: `${s.slice(0, cap)} …[truncated]`, truncated: true };
}

/**
 * Assemble bounded, HTML-stripped, privacy-safe evidence for the prompt, plus
 * an explicit COVERAGE object stating what was found, included, and omitted.
 *
 * Selection is newest-first (recent/high-value first); each source has an
 * explicit cap and a per-item length cap; nothing is silently dropped
 * mid-source without a "[truncated]" label. Deterministic aggregates cover the
 * complete history regardless of these caps.
 *
 * @param {object} sources  Partner-scoped rows: { transcripts, meetings,
 *   documents, opportunityDescriptions, eventDescriptions }.
 * @param {object} [limits]  Overrides for EVIDENCE_LIMITS.
 * @returns {{ transcripts, meetings, documents, opportunityDescriptions,
 *   eventDescriptions, coverage }}
 */
export function assemblePartnerEvidence(sources = {}, limits = {}) {
  const L = { ...EVIDENCE_LIMITS, ...limits };
  const found = {};
  const included = {};
  const omitted = {};
  let truncatedItems = 0;
  let totalChars = 0;

  const budgetLeft = () => Math.max(0, L.totalChars - totalChars);

  const take = (rows, cap, mapFn, textOf) => {
    const list = rows || [];
    const out = [];
    let usedFromThisSource = 0;
    for (const row of list) {
      if (usedFromThisSource >= cap) break;
      if (budgetLeft() <= 0) break;
      const item = mapFn(row);
      if (!item || !String(textOf(item) || '').trim()) continue; // skip empty
      const perItemCap = Math.min(L.charsPerItem, budgetLeft());
      const { text, truncated } = truncate(textOf(item), perItemCap);
      if (truncated) truncatedItems += 1;
      const finalItem = { ...item, text };
      totalChars += text.length;
      out.push(finalItem);
      usedFromThisSource += 1;
    }
    return out;
  };

  const nonEmpty = (rows, textOf) => (rows || []).filter(r => String(textOf(r) || '').trim()).length;

  // Transcripts.
  found.transcripts = nonEmpty(sources.transcripts, r => stripHtml(r.transcript_text || ''));
  const transcripts = take(sources.transcripts, L.transcripts,
    t => ({ id: String(t.transcript_id || '').trim(), date: firstDate(t.conversation_date, t.created_at), title: '' , _text: stripHtml(t.transcript_text || '') }),
    it => it._text,
  ).map(it => ({ id: it.id, date: it.date, text: it.text }));
  included.transcripts = transcripts.length;

  // Meeting_Index — structured metadata combined into one prose blob per row.
  const meetingText = (m) => [
    m.meeting_title ? `Title: ${stripHtml(m.meeting_title)}` : '',
    m.attendees ? `Attendees: ${stripHtml(m.attendees)}` : '',
    m.summary ? `Summary: ${stripHtml(m.summary)}` : '',
    m.key_decisions ? `Decisions: ${stripHtml(m.key_decisions)}` : '',
    m.topics_discussed ? `Topics: ${stripHtml(m.topics_discussed)}` : '',
  ].filter(Boolean).join('\n');
  found.meetings = nonEmpty(sources.meetings, meetingText);
  const meetings = take(sources.meetings, L.meetings,
    m => ({ id: String(m.meeting_id || '').trim(), transcript_id: String(m.transcript_id || '').trim(), date: String(m.meeting_date || '').trim(), title: String(m.meeting_title || '').trim(), _text: meetingText(m) }),
    it => it._text,
  ).map(it => ({ id: it.id, transcript_id: it.transcript_id, date: it.date, title: it.title, text: it.text }));
  included.meetings = meetings.length;

  // Partner_Documents — html_content stripped to prose.
  const docText = (d) => stripHtml(d.html_content || '');
  found.documents = nonEmpty(sources.documents, docText);
  const documents = take(sources.documents, L.documents,
    d => ({ id: String(d.document_id || '').trim(), title: String(d.title || '').trim(), doc_type: String(d.doc_type || '').trim(), date: firstDate(d.updated_at, d.created_at), _text: docText(d) }),
    it => it._text,
  ).map(it => ({ id: it.id, title: it.title, doc_type: it.doc_type, date: it.date, text: it.text }));
  included.documents = documents.length;

  // Opportunity_Descriptions — keep BOTH ids so a link opens the right opp.
  const oppDescText = (d) => stripHtml(d.description_text || d.text || '');
  found.opportunityDescriptions = nonEmpty(sources.opportunityDescriptions, oppDescText);
  const opportunityDescriptions = take(sources.opportunityDescriptions, L.opportunityDescriptions,
    d => ({ id: String(d.description_id || '').trim(), opportunity_id: String(d.opportunity_id || '').trim(), date: firstDate(d.description_date, d.created_at), _text: oppDescText(d) }),
    it => it._text,
  ).map(it => ({ id: it.id, opportunity_id: it.opportunity_id, date: it.date, text: it.text }));
  included.opportunityDescriptions = opportunityDescriptions.length;

  // Event_Descriptions — keep the event id so a link opens the right event.
  const evtDescText = (d) => stripHtml(d.description_text || d.text || '');
  found.eventDescriptions = nonEmpty(sources.eventDescriptions, evtDescText);
  const eventDescriptions = take(sources.eventDescriptions, L.eventDescriptions,
    d => ({ id: String(d.description_id || '').trim(), event_id: String(d.event_id || '').trim(), date: firstDate(d.description_date, d.created_at), _text: evtDescText(d) }),
    it => it._text,
  ).map(it => ({ id: it.id, event_id: it.event_id, date: it.date, text: it.text }));
  included.eventDescriptions = eventDescriptions.length;

  for (const key of Object.keys(found)) {
    omitted[key] = Math.max(0, found[key] - included[key]);
  }
  const anyOmitted = Object.values(omitted).some(n => n > 0);

  const coverage = {
    found, included, omitted, truncatedItems,
    failures: [],           // filled by the client from read failures
    hasOmissions: anyOmitted || truncatedItems > 0,
    warnings: buildCoverageWarnings(found, included, omitted, truncatedItems, []),
  };

  return { transcripts, meetings, documents, opportunityDescriptions, eventDescriptions, coverage };
}

const SOURCE_LABELS = {
  transcripts: 'transcript',
  meetings: 'indexed meeting',
  documents: 'partner document',
  opportunityDescriptions: 'opportunity note',
  eventDescriptions: 'event note',
};

/** Human, non-fatal coverage warnings for the UI banner. */
export function buildCoverageWarnings(found, included, omitted, truncatedItems, failures) {
  const warnings = [];
  const omittedBits = Object.keys(omitted || {})
    .filter(k => (omitted[k] || 0) > 0)
    .map(k => `${omitted[k]} ${SOURCE_LABELS[k] || k}${omitted[k] === 1 ? '' : 's'}`);
  if (omittedBits.length) {
    warnings.push(`Evidence limits were reached, so ${omittedBits.join(', ')} were not sent to Randy. Deterministic KPIs still reflect the complete history.`);
  }
  if ((truncatedItems || 0) > 0) {
    warnings.push(`${truncatedItems} long source${truncatedItems === 1 ? ' was' : 's were'} shortened (marked “[truncated]”) to fit the evidence budget.`);
  }
  (failures || []).forEach(f => { if (f) warnings.push(String(f)); });
  return warnings;
}

// Attach read failures to an already-built coverage object (client helper).
export function withCoverageFailures(coverage, failures) {
  const list = (failures || []).map(f => String(f || '').trim()).filter(Boolean);
  const merged = { ...(coverage || {}) };
  merged.failures = [...(coverage && coverage.failures || []), ...list];
  merged.warnings = buildCoverageWarnings(
    merged.found || {}, merged.included || {}, merged.omitted || {}, merged.truncatedItems || 0, merged.failures,
  );
  merged.hasOmissions = !!(merged.hasOmissions || list.length);
  return merged;
}

// ── Parser anchors (valid ids/dates + grounding text) ───────────────
/**
 * Build the anchors the strict parser needs to validate model citations:
 *   • narrativeIds / narrativeDates — the ids/dates the model may cite for a
 *     narrative source (transcript, meeting_index, partner_document,
 *     opportunity_description, event_description).
 *   • textById / textByDate — the exact prose shown, for evidence grounding.
 *   • structuredIds — real opportunity_ids, event_ids, saved contact_ids and
 *     the partner_id, for validating a structured claim's source_id /
 *     related_entity_id.
 *   • contactIds — the saved Partner_Contacts ids from the supplied roster;
 *     the ONLY ids an org-chart node may carry (a fabricated contact_id is
 *     stripped by the parser).
 *   • contactNamesById — contact_id → saved contact name for the roster rows
 *     actually sent; lets the org-chart validator verify a named person
 *     against the roster (and auto-link an unlinked exact match) without the
 *     evidence module leaking anything beyond the already-sent names.
 *   • relatedById — narrative source id → the entity a link should open
 *     (an opportunity_id, an event_id, or the partner_id).
 *
 * Built from the ASSEMBLED (bounded) evidence — the model can only cite what
 * it was shown.
 *
 * @param {object} evidence  Result of assemblePartnerEvidence().
 * @param {object} ids       { opportunityIds:Set, eventIds:Set, partnerId:string,
 *                             contactIds:Set, contacts:Array }
 *                           (contactIds / contacts = roster rows actually sent)
 */
export function collectPartnerAnchors(evidence, ids = {}) {
  const ev = evidence || {};
  const narrativeIds = new Set();
  const narrativeDates = new Set();
  const textById = new Map();
  const textByDate = new Map();
  const relatedById = new Map();
  const partnerId = String(ids.partnerId || '').trim();

  const add = (id, date, text, relatedId) => {
    const cleanId = String(id || '').trim();
    const cleanDate = String(date || '').trim();
    const t = String(text || '').trim();
    if (cleanId) { narrativeIds.add(cleanId); if (t) textById.set(cleanId, t); if (relatedId) relatedById.set(cleanId, String(relatedId).trim()); }
    if (cleanDate) {
      narrativeDates.add(cleanDate);
      if (t) textByDate.set(cleanDate, textByDate.has(cleanDate) ? `${textByDate.get(cleanDate)}\n${t}` : t);
    }
  };

  (ev.transcripts || []).forEach(t => add(t.id, t.date, t.text, partnerId));
  (ev.meetings || []).forEach(m => add(m.id, m.date, m.text, partnerId));
  (ev.documents || []).forEach(d => add(d.id, d.date, d.text, partnerId));
  (ev.opportunityDescriptions || []).forEach(d => add(d.id, d.date, d.text, d.opportunity_id));
  (ev.eventDescriptions || []).forEach(d => add(d.id, d.date, d.text, d.event_id));

  const structuredIds = new Set();
  (ids.opportunityIds instanceof Set ? ids.opportunityIds : new Set(ids.opportunityIds || [])).forEach(id => id && structuredIds.add(String(id)));
  (ids.eventIds instanceof Set ? ids.eventIds : new Set(ids.eventIds || [])).forEach(id => id && structuredIds.add(String(id)));
  if (partnerId) structuredIds.add(partnerId);

  // Saved contact ids are structured entities too (a "partner_contact" claim
  // may cite one), and they gate which org-chart nodes may carry a contact_id.
  const contactIds = new Set();
  (ids.contactIds instanceof Set ? ids.contactIds : new Set(ids.contactIds || [])).forEach(id => id && contactIds.add(String(id)));

  // contact_id → name for the roster rows actually sent (names only — the
  // same field already shown in the prompt; never emails/phones).
  const contactNamesById = new Map();
  (Array.isArray(ids.contacts) ? ids.contacts : []).forEach(c => {
    const cid = String(c && c.contact_id || '').trim();
    const nm = String(c && c.name || '').trim();
    if (cid && nm) {
      contactNamesById.set(cid, nm);
      contactIds.add(cid);
    }
  });
  contactIds.forEach(id => structuredIds.add(id));

  return { narrativeIds, narrativeDates, textById, textByDate, structuredIds, relatedById, partnerId, contactIds, contactNamesById };
}
