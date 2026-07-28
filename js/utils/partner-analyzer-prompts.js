// ============================================================
// Partner analyzer prompt builder
// ============================================================
// Assembles the partner-analysis prompt: the seven stages + 21 stable
// criterion ids, partner profile CONTEXT (tier/status shown as context, never
// as evidence), deterministic KPI facts, the selected transcripts / meeting
// records / partner documents (the narrative evidence), strictly
// partner-specific opportunity + event facts, aggregated contact/playbook
// signals, coverage information and today's date — ending with the strict JSON
// schema example and the anti-hallucination contract.
//
// HTML is already stripped by the evidence assembler; this builder only lays
// the clean prose out and never emits PII, passwords, event passwords, contact
// emails or API keys.
// ============================================================

import { PARTNER_STAGES } from './partner-analyzer-stages.js';
import { PARTNER_ANALYZER_SCHEMA_EXAMPLE } from './partner-analyzer-schema.js';

// ── Small formatters ────────────────────────────────────────────────
function money(n) {
  const num = Number(n) || 0;
  return `$${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
function orNone(v) { const s = String(v || '').trim(); return s || '(none)'; }

// Present bounded evidence oldest-first for display (it arrives newest-first
// from selection) so the model can reason about progression; dates are always
// shown so recency is explicit.
function chronological(items) {
  return (items || []).slice().sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
}

// ── Stage / criterion definitions ───────────────────────────────────
function buildStageDefinitionsBlock() {
  return PARTNER_STAGES.map((stage, i) => {
    const header = `${i + 1}. ${stage.name}  [stage_id: ${stage.id}]`;
    const rows = stage.criteria.map(c => `   - [${c.id}] ${c.label}`).join('\n');
    return `${header}\n${rows}`;
  }).join('\n\n');
}

// ── Partner profile (CONTEXT — tier/status are not maturity evidence) ─
function buildProfileBlock(partner, kpis) {
  const p = partner || {};
  const k = kpis || {};
  const lines = [];
  lines.push(`Partner ID: ${orNone(p.partner_id)}`);
  lines.push(`Name: ${orNone(p.display_name)}`);
  lines.push(`Partner type: ${orNone(p.partner_type)}`);
  lines.push(`Region: ${orNone(p.region)}`);
  lines.push(`HQ / location: ${orNone(p.hq_location)}`);
  lines.push(`Created: ${orNone(p.created_at)}`);
  lines.push('');
  lines.push('CRM CLASSIFICATIONS (contextual only — these are NOT maturity evidence):');
  lines.push(`- CRM tier: ${orNone(p.tier)}  (a commercial classification; a high tier does NOT imply a high maturity stage)`);
  lines.push(`- CRM status: ${orNone(p.status)}  (an administrative status; “active” does NOT prove maturity)`);
  lines.push('If the CRM tier looks more advanced than the evidence supports, SAY SO in the summary or a gap (e.g. “CRM tier is Premier/Strategic, but the available evidence only supports Pipeline Execution maturity.”).');
  return lines.join('\n');
}

// ── Deterministic KPI facts (app-computed; never reinterpret them) ───
function buildKpiBlock(kpis) {
  const k = kpis || {};
  const lines = [];
  lines.push('These numbers are computed deterministically by the application from the CRM. Treat them as ground truth. Do NOT recompute, inflate, or contradict them, and never invent a metric.');
  lines.push(`- Partner transcripts: ${k.transcriptCount || 0}`);
  lines.push(`- Indexed meetings (Meeting_Index): ${k.meetingCount || 0}`);
  lines.push(`- Partner documents: ${k.documentCount || 0}`);
  lines.push(`- Partner-specific events: ${k.eventCount || 0} (${k.upcomingEventCount || 0} upcoming/in-progress, ${k.completedEventCount || 0} completed)`);
  lines.push(`- Next partner event date: ${orNone(k.nextEventDate)}; most recent past event: ${orNone(k.mostRecentEventDate)}`);
  lines.push(`- Total linked opportunities: ${k.totalOpps || 0}`);
  lines.push(`- Active opportunities: ${k.activeOppCount || 0}; ACTIVE PIPELINE value: ${money(k.activePipelineValue)}`);
  lines.push(`- WON opportunities: ${k.wonOppCount || 0}; WON REVENUE: ${money(k.wonRevenue)}`);
  const stagePairs = Object.keys(k.stageDistribution || {}).map(s => `${s}: ${k.stageDistribution[s]}`);
  if (stagePairs.length) lines.push(`- Opportunity stage distribution: ${stagePairs.join(', ')}`);
  lines.push(`- Nearest expected close (active): ${orNone(k.nearestExpectedClose)}`);
  lines.push(`- Most recent meaningful activity date: ${orNone(k.mostRecentActivityDate)}`);
  lines.push('Reminder: active pipeline is NOT won revenue, and a scheduled (upcoming) event is NOT a completed activity.');
  return lines.join('\n');
}

// ── Generic narrative-source block ──────────────────────────────────
function buildNarrativeBlock(items, { emptyLine, header }) {
  const list = chronological(items);
  if (list.length === 0) return emptyLine;
  return [header, ...list.map(formatNarrativeItem)].join('\n\n');
}

function formatNarrativeItem(it) {
  const id = it.id || '(no id)';
  const date = it.date || 'Undated';
  const extra = [];
  if (it.title) extra.push(`title: ${it.title}`);
  if (it.doc_type) extra.push(`type: ${it.doc_type}`);
  if (it.opportunity_id) extra.push(`opportunity_id: ${it.opportunity_id}`);
  if (it.event_id) extra.push(`event_id: ${it.event_id}`);
  const meta = extra.length ? ` | ${extra.join(' | ')}` : '';
  return `--- SOURCE id: ${id} | date: ${date}${meta} ---\n${it.text}`;
}

// ── Aggregated contact + saved-playbook signals ─────────────────────
function buildContactsBlock(agg) {
  const a = agg || { total: 0 };
  if (!a.total) {
    return '(No saved event contacts for this partner’s events. Audience engagement has no structured backing unless a note documents it.)';
  }
  const lines = [];
  lines.push(`Aggregated event contacts across this partner’s events: ${a.total} total (counts only — no names or emails supplied).`);
  lines.push(`- With an owner assigned: ${a.withOwner || 0} (coverage ${a.ownerCoveragePct || 0}%)`);
  lines.push(`- With a booked-meeting status: ${a.meetingCount || 0}`);
  const statusPairs = Object.keys(a.byStatus || {}).map(s => `${s}: ${a.byStatus[s]}`);
  if (statusPairs.length) lines.push(`- Status breakdown: ${statusPairs.join(', ')}`);
  lines.push('Use source_type "event_contacts" for audience claims backed by these counts. Thin coverage means at most "partial".');
  return lines.join('\n');
}

// ── Saved partner-contact roster (org-chart + stakeholder evidence) ──
function buildContactRosterBlock(roster) {
  const r = roster || { total: 0, included: [], omittedCount: 0 };
  const rows = r.included || [];
  if (!rows.length) {
    return '(No saved partner contacts on file for this partner. Build the org chart only from people explicitly NAMED in the evidence above — or return an empty org_map if none are named.)';
  }
  const lines = [];
  lines.push(`Saved partner-side people on this partner’s record: ${r.total} (structured CRM records — names and roles only; emails and phones are withheld by design).`);
  lines.push('These rows may back a criterion claim (e.g. key stakeholders identified): use source_type "partner_contact" and put the contact_id in source_id.');
  rows.forEach(c => lines.push(`- [contact_id: ${c.contact_id}] ${c.name}${c.role ? ` — ${c.role}` : ''}`));
  if (r.omittedCount > 0) lines.push(`(+${r.omittedCount} more saved contact(s) not listed due to size limits.)`);
  return lines.join('\n');
}

function buildSavedPlaybookBlock(saved) {
  const s = saved || { found: false, checked: {} };
  const ids = Object.keys(s.checked || {});
  if (!s.found && ids.length === 0) {
    return '(No saved event-playbook state for this partner’s events — continue with the other evidence.)';
  }
  if (!ids.length) return 'Saved event-playbook state exists for this partner’s events but no activities are checked yet.';
  return [
    'Checked activities in the saved event playbook for this partner’s events (operational confirmation — use source_type "saved_event_playbook" with an EMPTY evidence string; never invent a quote for a checkbox):',
    ...ids.map(id => `- ${id}`),
  ].join('\n');
}

// ── Coverage ────────────────────────────────────────────────────────
function buildCoverageBlock(coverage) {
  const c = coverage || {};
  const found = c.found || {};
  const included = c.included || {};
  const parts = Object.keys(found).map(k => `${k}: ${included[k] || 0}/${found[k] || 0} included`);
  const lines = [`Evidence coverage — ${parts.join('; ')}.`];
  if (c.hasOmissions) lines.push('Some evidence was omitted or shortened due to size limits; the deterministic KPIs above still reflect the COMPLETE history.');
  (c.warnings || []).forEach(w => lines.push(`- ${w}`));
  return lines.join('\n');
}

/**
 * Build the partner-analysis prompt.
 *
 * @param {object} params
 * @param {object} params.partner       Partners row.
 * @param {object} params.kpis          buildPartnerKpis() result.
 * @param {object} params.evidence      assemblePartnerEvidence() result.
 * @param {object} [params.contactsAgg] buildContactAggregates() result.
 * @param {object} [params.savedPlaybook] parseSavedPlaybook() result (partner-scoped).
 * @param {object} [params.contactRoster] buildPartnerContactRoster() result (org-chart roster).
 * @param {string} [params.today]       Injectable YYYY-MM-DD.
 * @returns {string}
 */
export function buildPartnerAnalyzerPrompt({ partner, kpis, evidence, contactsAgg, savedPlaybook, contactRoster, today } = {}) {
  const p = partner || {};
  const name = String(p.display_name || '').trim() || 'this partner';
  const ev = evidence || {};
  const todayISO = String(today || new Date().toISOString().slice(0, 10)).slice(0, 10);

  const transcripts = buildNarrativeBlock(ev.transcripts, {
    header: 'TRANSCRIPTS (primary narrative evidence — use source_type "transcript"; cite the transcript id in source_id and its date in source_date):',
    emptyLine: '(No transcripts exist for this partner. Every criterion relying on conversation evidence must be "no_evidence".)',
  });
  const meetings = buildNarrativeBlock(ev.meetings, {
    header: 'INDEXED MEETINGS (Meeting_Index — structured meeting metadata; use source_type "meeting_index". A meeting whose transcript_id matches a transcript above is the SAME conversation — do not double-count it):',
    emptyLine: '(No indexed meetings for this partner.)',
  });
  const documents = buildNarrativeBlock(ev.documents, {
    header: 'PARTNER DOCUMENTS (Partner_Documents content — use source_type "partner_document"; cite the document id in source_id):',
    emptyLine: '(No partner documents for this partner.)',
  });
  const oppNotes = buildNarrativeBlock(ev.opportunityDescriptions, {
    header: 'OPPORTUNITY NOTES (Opportunity_Descriptions for this partner’s opportunities — use source_type "opportunity_description"; cite the description id in source_id and set related_entity_id to the opportunity_id so a link opens the right deal):',
    emptyLine: '(No opportunity notes for this partner’s opportunities.)',
  });
  const eventNotes = buildNarrativeBlock(ev.eventDescriptions, {
    header: 'EVENT NOTES (Event_Descriptions for this partner’s events — use source_type "event_description"; set related_entity_id to the event_id):',
    emptyLine: '(No event notes for this partner’s events.)',
  });

  return `You are assessing a PARTNER MATURITY board for "${name}". You will be given the seven-stage Partner Maturity framework, this partner’s profile context, deterministic CRM facts, and this partner’s saved evidence. Score each of the 21 criteria using ONLY the supplied evidence.

This is NOT a sales forecast and NOT an event countdown. Do not emit sales win-percentages, pipeline stage-probabilities, or event day-counters. Maturity is a checklist of criteria proven by evidence.

GOLDEN RULE — THE MOST IMPORTANT INSTRUCTION:

Every met or partial criterion must be supported by a supplied source.
Use no_evidence whenever the available CRM records are silent. Partner tier,
status, longevity, reputation, or typical channel behavior are not evidence.

You are NOT allowed to:
- Mark a criterion "met" because the partner has a high tier, is marked active, or has existed a long time
- Infer a criterion from what is typical for a partner of this type or brand
- Assume later-stage work implies earlier stages are complete
- Confuse ACTIVE PIPELINE with WON REVENUE
- Confuse a SCHEDULED (upcoming) event with a COMPLETED activity
- Treat one isolated deal or one isolated event as proof of a repeatable motion
- Browse the web or use any outside knowledge about a named partner or its brand/company name

You ARE expected to:
- Use "no_evidence" liberally. It is the correct answer whenever the sources are silent.
- Return an empty "evidence" string rather than inventing one
- Prefer an open question over a guess
- Surface discrepancies (e.g. a high CRM tier not backed by the evidence)
- Err toward less confidence, not more

A maturity board with honest gaps is useful. A board with invented checkmarks is worse than
useless — it will make the team believe a relationship is further along than it is.

---

PARTNER MATURITY FRAMEWORK (score criteria against these — use the exact stage_id and criterion_id strings):

${buildStageDefinitionsBlock()}

---

PARTNER PROFILE CONTEXT:

${buildProfileBlock(p, kpis)}

---

DETERMINISTIC CRM FACTS (ground truth — the application overlays the hard ones after your answer):

${buildKpiBlock(kpis)}

---

${transcripts}

---

${meetings}

---

${documents}

---

${oppNotes}

---

${eventNotes}

---

AGGREGATED EVENT CONTACTS (privacy-safe counts — no names or emails):

${buildContactsBlock(contactsAgg)}

---

SAVED PARTNER CONTACTS (Partner_Contacts — the partner-side people saved on this partner’s record; the org-chart roster):

${buildContactRosterBlock(contactRoster)}

---

SAVED EVENT PLAYBOOK:

${buildSavedPlaybookBlock(savedPlaybook)}

---

COVERAGE:

${buildCoverageBlock(ev.coverage)}

---

Today is ${todayISO}.

SCORING GUIDANCE (subordinate to the Golden Rule):
- For every criterion choose one status: "met", "partial", "not_met", or "no_evidence", and set "source_type" to where the support came from ("none" for no_evidence).
- "met" = a source clearly shows the criterion is satisfied. "partial" = a source shows progress but not completion. "not_met" = a source shows it was attempted and did NOT happen (rare). "no_evidence" = the sources say nothing (the common case).
- For a NARRATIVE "met"/"partial" (transcript, meeting_index, partner_document, opportunity_description, event_description), quote or closely paraphrase ONE source in "evidence" and set "source_id"/"source_date" to that source. A claim you cannot tie to a real supplied source id or date will be dropped.
- For a STRUCTURED "met"/"partial" (partner_profile, opportunity, event, event_contacts, partner_contact, saved_event_playbook), rely on the deterministic facts / structured records above; the app validates and overlays these. Do not fabricate counts.
- A stage's "status" is "complete" only when ALL three criteria are "met"; "in_progress" if at least one is met or partial; otherwise "not_started". The app recomputes this.
- "operational_stage_id" is the FIRST stage that is not complete; "furthest_demonstrated_stage_id" is the furthest stage with at least one met criterion. The app recomputes both — do not let a completed later stage hide an unfinished earlier one.
- "summary" (2-3 sentences), "next_actions", "gaps", "open_questions", "risks", "momentum" describe THIS partnership. Return [] for any list you cannot support.
- Echo the given Partner ID and name back in "partner_id" and "partner_name".

ORG CHART ("org_map") — a LIKELY org chart of the partner organization (separate from criterion scoring; it never makes a criterion met):
- TRUTH OVER COMPLETENESS: a verified partial chart beats a plausible complete one. Sketch the partner-side reporting structure from the SAVED PARTNER CONTACTS roster plus any partner-side people explicitly NAMED in the evidence above. It is an inferred, best-effort map of who we know and who we are missing — NOT an official org chart.
- PEOPLE — never invent a named person. Use ONLY people from the roster or the evidence. The app removes any named node it cannot find in the saved roster or the supplied evidence text, so an invented or remembered name will not survive. What you know about who publicly runs a company with this name is NOT usable here.
- Return a flat top-down list, each person listed ONCE. "depth" 0 is the most senior person known; a report’s depth is one more than its likely manager’s, and it must appear AFTER its manager in the list. Peers share a depth under the same manager.
- "name": "Name — Title" when the role is known, otherwise just the name. For a structural gap add an UNNAMED role node such as "CTO (not yet identified)" with status "missing" — a known gap is useful data (a prospecting target), never a place for a guessed name.
- "status" rates the PERSON relationship: "engaged" (an active working relationship is evidenced) | "introduced" (met at least once, no active thread) | "identified" (known to exist, not yet met) | "missing" (an unfilled structural gap worth closing).
- THE PERSON AND THE REPORTING LINE ARE RATED SEPARATELY — a confirmed person never implies a confirmed line. "line_confidence" rates ONLY the line to the manager above, on this ladder; stop at the HIGHEST rung the supplied evidence actually earns:
  * "explicit" — a supplied source states the line outright ("reports to", "her team", "my boss").
  * "observed" — deference, sign-off, approval or cc patterns in the evidence imply it.
  * "inferred" — only title seniority + shared function suggest it. This is the honest default; most lines land here.
  * "scaffold" — shape only, from how comparable partner orgs are typically structured. Every "missing" gap node is scaffold.
  A saved contact's title alone can never earn "explicit" or "observed" — those require the evidence text. Leave "" for a depth-0 root.
- "line_basis": one short phrase saying what earned that rung, naming the source date when you can (e.g. "reports to Dana — 2026-05-12 transcript"). Prefer the most RECENT evidence — org structure goes stale. Empty for a root or when nothing supports the line.
- "contact_id": the contact_id from the roster when the node IS that saved contact; "" for everyone else. Never fabricate a contact_id.
- If neither the roster nor the evidence names any partner-side person, return [].

Return ONLY a single valid JSON object. No prose. No markdown. No code fences. The object must match this exact shape:

${PARTNER_ANALYZER_SCHEMA_EXAMPLE}

Return the JSON object and nothing else.`;
}

// Exposed for tests — pure helpers with no network cost.
export const __partnerPromptInternals = {
  buildStageDefinitionsBlock, buildProfileBlock, buildKpiBlock, buildCoverageBlock, chronological,
};
