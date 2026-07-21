// ============================================================
// Event analyzer prompt builder
// ============================================================
// Assembles the event-analysis prompt: the seven stages + 21 stable
// activity ids, event metadata, the event's description notes (the primary
// textual evidence), privacy-safe contact aggregates, linked-opportunity
// facts, saved-playbook state and timing context — ending with the strict
// JSON schema example.
//
// The GOLDEN RULE block is the anti-hallucination contract, included
// verbatim. It is the event-execution analogue of the Opportunity
// Analyzer's Golden Rule: no completion may be inferred from timing,
// industry norms, the status field, or the fact that later activities are
// done.
//
// HTML in notes is stripped with the SAME stripHtml() the Opportunity
// Analyzer uses (imported from forecast-prompts.js), so the model sees the
// clean prose a human reads and its quotes can be grounded against it.
// ============================================================

import {
  EVENT_STAGES,
  ownerLabel,
  ACTIVITY_BY_ID,
} from './event-analyzer-stages.js';
import { EVENT_ANALYZER_SCHEMA_EXAMPLE } from './event-analyzer-schema.js';
import { stripHtml } from './forecast-prompts.js';

// The standalone playbook mirrors stage notes into the Events row's
// `description` under this marker. Those notes usually already exist in
// Event_Descriptions, so the metadata block strips this section to avoid
// double-counting the same text as two separate sources.
const TEAM_NOTES_MARKER = '⸻ Team Notes ⸻';

function stripTeamNotes(description) {
  const text = String(description || '');
  const idx = text.indexOf(TEAM_NOTES_MARKER);
  return (idx >= 0 ? text.slice(0, idx) : text).trim();
}

// Normalize Event_Descriptions rows: strip HTML, keep id/date/title, drop
// empties, sort OLDEST FIRST (so the recency rule below can reason about
// which note describes the current state).
export function normalizeEventDescriptions(descriptions) {
  return (descriptions || [])
    .map(d => ({
      id: String(d?.description_id || '').trim(),
      date: String(d?.description_date || d?.created_at || '').trim(),
      title: String(d?.title || '').trim(),
      text: stripHtml(d?.description_text || d?.text || ''),
    }))
    .filter(d => d.text.length > 0)
    .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
}

// The stage/activity checklist with the exact stage ids and activity ids
// the model must score against — plus timing and owner, which are useful
// context but never evidence of completion.
function buildStageDefinitionsBlock() {
  return EVENT_STAGES.map((stage, i) => {
    const header = `${i + 1}. ${stage.name}  [stage_id: ${stage.id}]  ·  ${stage.timing}`;
    const rows = stage.activities
      .map(a => `   - [${a.id}] ${a.label}  (owner: ${ownerLabel(a.owner)})`)
      .join('\n');
    return `${header}\n${rows}`;
  }).join('\n\n');
}

function buildMetadataBlock(event, timing) {
  const ev = event || {};
  const lines = [];
  lines.push(`Event ID: ${String(ev.event_id || '(unknown)').trim()}`);
  lines.push(`Title: ${String(ev.title || '(untitled)').trim()}`);
  if (String(ev.event_type || '').trim()) lines.push(`Type: ${String(ev.event_type).trim()}`);
  if (String(ev.status || '').trim()) lines.push(`Status field (NOT evidence of execution): ${String(ev.status).trim()}`);
  if (String(ev.location || '').trim()) lines.push(`Location: ${String(ev.location).trim()}`);
  lines.push(`Timing: today is ${timing.today}. Event start ${timing.start || '(none)'}, end ${timing.end || '(none)'}. ${timing.daysLabel}`);

  const desc = stripTeamNotes(ev.description);
  if (desc) {
    lines.push('');
    lines.push('Event description (metadata context — the mere existence of an event row is NOT evidence a topic was strategically defined or the event happened):');
    lines.push(stripHtml(desc));
  }
  return lines.join('\n');
}

function buildNotesBlock(entries) {
  if (entries.length === 0) {
    return '(No description notes exist for this event. Every activity that would rely on note evidence must be "no_evidence".)';
  }
  return entries.map(e => {
    const id = e.id || '(no id)';
    const date = e.date || 'Undated';
    const title = e.title ? ` | title: ${e.title}` : '';
    return `--- NOTE id: ${id} | date: ${date}${title} ---\n${e.text}`;
  }).join('\n\n');
}

function buildContactsBlock(agg) {
  const a = agg || { total: 0 };
  if (!a.total) {
    return '(No saved Event_Contacts for this event. "Upload target accounts and contacts" has no structured backing unless a note says otherwise.)';
  }
  const lines = [];
  lines.push(`Saved contacts: ${a.total} total (aggregate counts only — no personal data supplied).`);
  lines.push(`- With an ICP role classified: ${a.withRole}`);
  lines.push(`- With a seniority tier: ${a.withSeniority}`);
  lines.push(`- With an owner assigned: ${a.withOwner} (owner coverage ${a.ownerCoveragePct}% — low coverage means "assign owners" is at most partial)`);
  lines.push(`- With a booked-meeting status: ${a.meetingCount}`);
  const statusPairs = Object.keys(a.byStatus || {}).map(k => `${k}: ${a.byStatus[k]}`);
  if (statusPairs.length) lines.push(`- Status breakdown: ${statusPairs.join(', ')}`);
  const rolePairs = Object.keys(a.byRole || {}).map(k => `${k}: ${a.byRole[k]}`);
  if (rolePairs.length) lines.push(`- ICP role breakdown: ${rolePairs.join(', ')}`);
  lines.push('These counts SUPPORT audience activities but do not by themselves prove missing stakeholders were identified or owners fully assigned — use partial when coverage is thin.');
  return lines.join('\n');
}

function buildLinkedOppsBlock(facts) {
  const f = facts || { count: 0 };
  if (!f.count) {
    return '(No opportunities are linked to this event. "Confirm opportunities created" and "Confirm closed-won deals" are handled deterministically by the app — leave them no_evidence unless a note documents them.)';
  }
  const lines = [];
  lines.push(`Linked opportunities (lead_source = this event): ${f.count} total, ${f.closedWonCount} closed-won, ${f.openCount} open.`);
  const pairs = Object.keys(f.byStatus || {}).map(k => `${k}: ${f.byStatus[k]}`);
  if (pairs.length) lines.push(`- Status breakdown: ${pairs.join(', ')}`);
  lines.push('The app overlays these as deterministic evidence after your answer — do not treat open pipeline as closed-won revenue.');
  return lines.join('\n');
}

function buildSavedPlaybookBlock(saved) {
  const s = saved || { found: false, checked: {}, notes: {} };
  const checkedIds = Object.keys(s.checked || {});
  if (!s.found && checkedIds.length === 0) {
    return '(No saved playbook state was loaded — continue with the other evidence.)';
  }
  const lines = [];
  if (checkedIds.length) {
    lines.push('Manually checked activities in the saved playbook (operational confirmation — mark these met with source_type "saved_playbook" and an EMPTY evidence string; never invent a quote for a checkbox):');
    checkedIds.forEach(id => {
      const def = ACTIVITY_BY_ID[id];
      const date = String((s.checked[id] || {}).date || '').trim();
      lines.push(`- [${id}] ${def ? def.label : id}${date ? ` (checked ${date})` : ''}`);
    });
  } else {
    lines.push('Saved playbook state was loaded but no activities are checked yet.');
  }
  return lines.join('\n');
}

/**
 * Compute timing context. `today` is injectable for deterministic tests.
 * @returns {{ today:string, start:string, end:string, daysLabel:string }}
 */
export function computeEventTiming(event, today) {
  const ev = event || {};
  const todayISO = String(today || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const start = String(ev.event_date || '').trim();
  const end = String(ev.end_date || '').trim() || start;

  let daysLabel = 'Event date unknown.';
  const startMs = Date.parse(start);
  const todayMs = Date.parse(todayISO);
  if (!Number.isNaN(startMs) && !Number.isNaN(todayMs)) {
    const diff = Math.round((startMs - todayMs) / 86400000);
    if (diff > 0) daysLabel = `${diff} day${diff === 1 ? '' : 's'} until the event.`;
    else if (diff === 0) daysLabel = 'The event is today.';
    else daysLabel = `${-diff} day${diff === -1 ? '' : 's'} since the event.`;
  }
  return { today: todayISO, start, end, daysLabel };
}

/**
 * Build the event-analysis prompt.
 *
 * @param {object} event         Events row.
 * @param {Array}  descriptions  Event_Descriptions rows for this event.
 * @param {object} facts         { contacts, linkedOpps, savedPlaybook } aggregates/state.
 * @param {object} [options]     { today } — injectable date for tests.
 * @returns {string}
 */
export function buildEventAnalyzerPrompt(event, descriptions, facts = {}, options = {}) {
  const ev = event || {};
  const title = String(ev.title || '').trim() || 'this event';
  const entries = normalizeEventDescriptions(descriptions);
  const timing = computeEventTiming(ev, options.today);

  return `You are scoring an EVENT EXECUTION lifecycle board for "${title}". You will be given the seven-stage playbook definitions and this event's saved evidence. Score each of the 21 activities using ONLY the supplied evidence.

This is NOT a sales forecast. Events are scored as a checklist of execution activities — there are no win percentages and no pipeline buckets. Do not borrow sales-stage or percentage-to-close language.

GOLDEN RULE — THE MOST IMPORTANT INSTRUCTION:

Every activity you mark as "met" or "partial" must be supported by a supplied source.
Use "no_evidence" whenever the sources are silent. Never infer completion merely because
an event has reached or passed a date.

You are NOT allowed to:
- Mark an activity "met" because it is typical for an event at this point in time
- Infer an activity from the event's status field, type, or scheduled date
- Assume the event happened just because its date is in the past
- Fill in an activity because the activities around it (or in a later stage) are done
- Generalize from how events usually run

You ARE expected to:
- Use "no_evidence" liberally. It is the correct answer whenever the sources are silent.
- Return an empty "evidence" string rather than inventing one
- Err toward less confidence, not more

An event board with honest gaps is useful. An event board with invented checkmarks is worse
than useless — it will make the team skip a step that never actually happened.

---

STAGE DEFINITIONS (score activities against these — use the exact stage_id and activity_id strings):

${buildStageDefinitionsBlock()}

---

EVENT METADATA:

${buildMetadataBlock(ev, timing)}

---

DESCRIPTION NOTES (the PRIMARY textual evidence; oldest first — each note carries the id you cite in "source_id" and the date you cite in "source_date". Use source_type "event_description" for these):

${buildNotesBlock(entries)}

---

EVENT CONTACTS (privacy-safe aggregate counts — use source_type "event_contacts". No names or emails are supplied and none should appear in your answer):

${buildContactsBlock(facts.contacts)}

---

LINKED OPPORTUNITIES (structured facts — use source_type "linked_opportunities"):

${buildLinkedOppsBlock(facts.linkedOpps)}

---

SAVED PLAYBOOK STATE:

${buildSavedPlaybookBlock(facts.savedPlaybook)}

---

SOURCE PRECEDENCE (how to weigh the evidence — still subordinate to the Golden Rule; this never manufactures evidence, it only decides which real evidence wins):
- DETERMINISTIC CRM facts (a scheduled date, linked-opportunity counts, closed-won deals) override your interpretation. The app recomputes these after your answer, so do not fight them.
- Among description notes, the notes are oldest first: when two notes disagree about the CURRENT state, the more recent note wins; a later note can document a regression. A dated accomplishment stays "met" unless a later note shows it reversed.
- Manually checked saved-playbook activities are operational confirmation — mark them "met" with source_type "saved_playbook" and an EMPTY evidence string. This is labelled differently from note-backed evidence; never manufacture a quote for a manual check.
- The event description may repeat the playbook's "Team Notes" — do NOT double-count it when the same content already appears in the description notes above.

SCORING GUIDANCE (subordinate to the Golden Rule):
- For every activity, choose one status: "met", "partial", "not_met", or "no_evidence", and set "source_type" to where the support came from ("none" for no_evidence).
- "met" = a source clearly shows the activity is done. "partial" = a source shows it is underway but not finished. "not_met" = a source shows it was attempted and did NOT happen (rare). "no_evidence" = the sources say nothing (the common case).
- For a note-backed "met"/"partial", quote or closely paraphrase ONE note in "evidence" and set "source_id"/"source_date" to that note. A claim you cannot tie to a real note id or date is "no_evidence".
- A stage's "status" is "complete" only if every activity is "met"; "in_progress" if at least one is met or partial; otherwise "not_started". The app recomputes this — keep it consistent.
- "current_stage_id" is the FIRST stage that is not complete. The app recomputes it; do not let a completed later stage hide an unfinished earlier one.
- "summary" (2-3 sentences), "next_actions", "gaps" (what's missing to finish the current stage) and "open_questions" describe THIS event's execution. Return [] for any list you cannot support.
- Echo the given Event ID and title back in "event_id" and "event_title".

Return ONLY a single valid JSON object. No prose. No markdown. No code fences. The object must match this exact shape:

${EVENT_ANALYZER_SCHEMA_EXAMPLE}

Return the JSON object and nothing else.`;
}

// Exposed for tests — pure helpers with no network cost.
export const __eventPromptInternals = { normalizeEventDescriptions, stripTeamNotes, computeEventTiming, buildStageDefinitionsBlock };
