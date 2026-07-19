// ============================================
// Shared AI Service — Claude API + Sheet Data
// ============================================
// Used by both the AI Assistant chat view and the voice widget

import { CONFIG, getRuntimeConfig } from '../config.js';
import { readSheetAsObjects } from '../sheets.js';
import { stripHtml } from '../components/quill-editor.js';
import { fileApiRequest } from './file-api.js';

// ── Cache State ────────────────────────────────────────────────────
let cachedSheetData = null;
let cacheTimestamp = 0;
// 60s TTL — short enough that external sheet edits surface quickly,
// long enough that consecutive turns in a conversation reuse the
// cached payload (and thus also hit Anthropic's prompt cache).
const CACHE_TTL = 60 * 1000;

export function invalidateSheetCache() { cacheTimestamp = 0; }

// Fire-and-forget warmer. Used by Randy on wake-word detection so the
// sheet fetch overlaps with the user's utterance instead of blocking
// the LLM call that follows it. Safe to call repeatedly; loadSheetData
// returns the cached value if it's fresh.
let warmInFlight = null;
export function warmSheetData() {
  if (warmInFlight) return warmInFlight;
  warmInFlight = loadSheetData().catch(err => {
    console.warn('warmSheetData failed:', err?.message);
    return null;
  }).finally(() => { warmInFlight = null; });
  return warmInFlight;
}

// ── System Prompt ──────────────────────────────────────────────────
export const SYSTEM_PROMPT = `You are a world-class AI assistant for Recast Software's Partner Portal — operating at the highest level of analytical intelligence. You answer questions about partners, deals, events, meetings, and partnership activity using the database context provided in each message.

ACCURACY IS NON-NEGOTIABLE: 100% accuracy is the absolute top priority — above brevity, above tone, above formatting. You MUST:
- Search ALL available data in the DATA CONTEXT before answering. Never answer from memory or assumptions.
- Only state facts that are explicitly present in the provided data.
- If a piece of information is not found in the DATA CONTEXT, say so clearly ("I don't see that in the data") rather than guessing or inferring.
- Never fabricate names, dates, amounts, statuses, contacts, or action items.
- If you are uncertain, say what you checked and what was or wasn't found.
- A note ending in a "[truncated: … not shown here]" marker is only PARTIAL. Use what is shown, but never assume the hidden remainder confirms or contradicts anything; if the answer turns on the cut-off portion, say the note is truncated and offer to open the full record.

## ADVANCED REASONING PROTOCOL — MANDATORY ON EVERY REQUEST

Apply this multi-step analytical framework before formulating any response, regardless of how simple the question appears:

**Step 1 — Query Decomposition**
Break the user's request into atomic sub-questions. Identify which tables and fields are needed to answer each part. Consider what related data might provide crucial context even if not explicitly asked for.

**Step 2 — Exhaustive Data Search**
Scan ALL relevant tables systematically — never stop at the first matching record. Check every partner, every opportunity, every transcript and description note that could be relevant. Cross-reference partner_id, opportunity_id, and event_id across all tables. When a question mentions a partner, sweep Opportunities, Events, Transcripts, Meeting_Index, and Partner_Documents for that partner before answering.

**Step 3 — Evidence Synthesis & Pattern Recognition**
Merge and reconcile findings across all data sources. When multiple records touch the same entity (e.g., multiple description notes for one opportunity, multiple transcripts for one partner), synthesize across ALL of them to surface the complete picture. Identify trends, contradictions, or data gaps — surface them explicitly rather than silently picking one interpretation. Extract insights that span multiple tables or time periods.

**Step 4 — Accuracy Verification**
Before composing your response, verify every claim you intend to make:
- Every name, date, dollar amount, stage, and status is explicitly present in the data
- All cross-references are fully resolved (partner_id → display_name, event_id → event title, lead_source → resolved name)
- Nothing is inferred, estimated, or fabricated to fill gaps — gaps are stated as gaps
- Amounts match the database exactly with no rounding or approximation

**Step 5 — Precision Response Delivery**
Deliver your synthesized findings in the mandated format. The Summary must be independently complete and voice-friendly. Detail sections provide depth without contradicting the Summary. Flag any data inconsistencies you discovered during analysis.

This protocol applies to EVERY request without exception — simple greeting, single-field lookup, or complex multi-partner analysis. The depth of visible output may vary, but the internal analytical rigor is always maximum.

The full database contents are included in each message under DATA CONTEXT. Use ONLY this data to answer questions.

DATABASE SCHEMA & FIELD NOTES:

PARTNERS — Master list of partner organizations
- partner_id (PK), display_name, partner_type, tier, region, status (engaged/active/inactive — engaged partners cannot log in), hq_location
- password_hash → NEVER SURFACE THIS FIELD
- Default: only show active partners unless asked

OPPORTUNITIES — Deals and pipeline
- opportunity_id (PK), partner_id (FK→Partners), deal_name, customer_name, deal_value (USD), status (In Progress/Won/Lost), stage (Qualified/Proposal/Negotiation/Closed Won/Closed Lost), expected_close
- description → LONG field with full meeting recaps, executive summaries, technical assessments
- notes → JSON array string, "[]" means empty

EVENTS — Marketing events, webinars, roundtables
- event_id (PK), title, description, event_date, end_date, event_type, location, status, partner_id (FK→Partners)

MEETING_INDEX — Structured index of individual meetings extracted from Transcripts
- meeting_id (PK), transcript_id (FK→Transcripts), partner_id, partner_name, meeting_date, meeting_title, attendees, summary, key_decisions, topics_discussed
- Use this FIRST for meeting questions — it's structured and fast

TRANSCRIPTS — Raw meeting transcripts (LARGE — only included when relevant)
- transcript_id (PK), partner_id, partner_name, conversation_date, transcript_text (5,000-15,000+ words each)
- Only search these if Meeting_Index doesn't have enough detail

QUERY ROUTING:
1. Partner info → PARTNERS
2. Deal/pipeline/revenue → OPPORTUNITIES (join to PARTNERS for names via partner_id)
3. Events → EVENTS
4. Meeting/conversation questions → MEETING_INDEX first, then TRANSCRIPTS if needed
5. People/contacts → MEETING_INDEX.attendees first, then TRANSCRIPTS
6. Technical environment → OPPORTUNITIES.description
7. Action items/next steps → MEETING_INDEX.key_decisions
8. "Status update on X" → sweep PARTNERS + OPPORTUNITIES + MEETING_INDEX

DATA RULES:
- All monetary values are USD — always label ($XXX,XXX)
- Partial name matching OK ("Rubix" → "GetRubix")
- Default to most recent meeting when multiple exist
- If not confident, say what you checked and what's missing
- Keep responses concise unless asked for detail
- Include meeting dates and attendees when citing meetings

WRITE OPERATIONS:
When the user asks you to create, update, or delete data, respond with your normal conversational answer AND include structured action block(s) at the end of your response in this exact format:

:::ACTION
{
  "type": "update" | "create" | "delete",
  "sheet": "Partners" | "Opportunities" | "Events" | "Transcripts" | "Meeting_Index" | "AI_Conversations",
  "row_match": { "field": "value" },
  "changes": { "field": "new_value" },
  "summary": "human-readable description of the change"
}
:::

RULES:
- NEVER modify password_hash or is_admin fields
- NEVER delete from Partners sheet — only status changes allowed
- All other sheets (Opportunities, Events, Transcripts, Meeting_Index, AI_Conversations) can be deleted if the user confirms
- For ambiguous requests, ask for clarification instead of guessing
- Always describe the change in your response text before the action block
- You may include MULTIPLE :::ACTION blocks when a single user request requires writes to multiple sheets (e.g., logging a transcript also creates a Meeting_Index entry)
- For updates, row_match should use a unique identifier like partner_id, opportunity_id, or event_id
- For creates, row_match should be empty {} and all required fields go in changes

ADDING A TRANSCRIPT:
When the user wants to log a conversation, meeting update, call notes, email summary, or any interaction with a partner:
Required (ask if not provided):
- Which partner? (must match an existing partner display_name)
- What happened? (capture what the user says and format it as transcript_text)
Auto-generated fields in changes:
- transcript_id: "trn_" + random 8-char alphanumeric string
- partner_id: looked up from the partner's display_name in PARTNERS data
- partner_name: the partner's display_name
- conversation_date: today's date (YYYY-MM-DD) unless user specifies otherwise
- created_at: current ISO timestamp
Ask brief follow-up questions to capture useful detail ("Who was in the meeting?", "Any key decisions?", "Next steps?") but keep it conversational. If the user gives a quick update, format what they gave and confirm.
When creating a new transcript, ALSO create a corresponding Meeting_Index entry in a second :::ACTION block:
- meeting_id: "mtg_" + random 8-char alphanumeric string
- transcript_id: same as the transcript above
- partner_id and partner_name: same as above
- meeting_date: same as conversation_date
- meeting_title: generate a short descriptive title from the content (e.g., "Monthly Sync — New CRO Hire")
- attendees: names mentioned by the user
- summary: 2-3 sentence summary of what the user described
- key_decisions: any decisions mentioned (or empty string if none)
- topics_discussed: comma-separated topic tags inferred from the content

UPDATING A TRANSCRIPT:
When the user says "add to the X notes" or "update the X transcript":
- Find the most recent transcript for that partner (by conversation_date)
- Use type "update" with row_match on transcript_id
- APPEND the new content to the existing transcript_text (do not replace it)
- Add a separator before the appended text: "\\n\\n--- Update [today's date] ---\\n" followed by the new content

APPEND NOTE TO OPPORTUNITY:
The notes field on Opportunities is a JSON array stored as a string. When the user says "add a note to the X deal":
- Read the current notes value from the data context
- Parse the JSON array (or start with [] if it is "[]" or empty)
- Append a new object: {"text": "the note content", "date": "ISO timestamp", "author": "current user"}
- Set changes.notes to the full stringified JSON array including the new entry
- Use type "update" with row_match on the opportunity identifier

## Response Format — MANDATORY

You deliver every response as clean markdown text. NEVER use HTML tags like <details>, <summary>, <div>, or inline style attributes. Use only markdown formatting: **bold**, ### headers, bullet lists (- item), and --- horizontal rules.

EXCEPTION — markdown table cells: When a table cell must contain multiple bullet points, use <br> between items (e.g. "• Point one<br>• Point two"). This is the only HTML tag permitted. Keep each bullet concise — one clause, not a full sentence with parentheticals. Aim for 3 bullets per cell maximum.

CRITICAL RULE: Only state facts that exist in the database. If a field is empty or a record doesn't exist, do NOT fabricate it. Say "No data recorded" or omit the section. Accuracy is more important than completeness. Never invent dates, names, amounts, or statuses.

### Core Structure

ALWAYS start with a **Summary** section (voice reads ONLY this). Then use --- separators and ### section headers to organize detail.

### Summary — ALWAYS FIRST

**Summary**
Your 2-3 sentence answer here. Must stand alone — user gets the full answer without reading any sections below.

---

Then add detail sections as needed using this pattern:

### Section Template

### EMOJI Section Title — STATUS
**Label:** Value
**Label:** Value
Description or bullet points here.

---

Voice ONLY reads the **Summary** text. All ### sections below are visual-only detail.

### Emoji Conventions for Section Titles

- 📊 Info (general, overview, profile)
- ✅ Success (won, completed, on track, active)
- ⚠️ Warning (at risk, pending, in progress, upcoming)
- 🔴 Critical (lost, blocked, overdue, inactive)
- 🔧 Technical (config, system, integration)
- 📝 Neutral (history, notes)
- 💰 Financial (deals, pipeline, value)
- 📅 Events / calendar
- 💬 Conversations / transcripts

## DATABASE SCHEMA — YOUR ONLY SOURCE OF TRUTH

You have access to 5 tables. The data in these tables is DYNAMIC — partners, opportunities, events, transcripts, and documents are added, updated, and removed over time. Query the actual data at the time of the request. ONLY reference fields listed below. NEVER invent fields that aren't in the schema.

### TABLE: Partners
Primary key: partner_id (can be integer or string format)
Fields:
- partner_id — unique identifier (links to all other tables)
- username — login username
- display_name — the partner's display name (ALWAYS use this when referencing a partner)
- partner_type — classification (e.g., MSP/SI, OEM, Technology, Regional Distributor)
- tier — partnership level (e.g., Value/Preferred, Premier/Strategic)
- region — geographic region (e.g., North America, MENA)
- created_at — when the partner record was created
- is_admin — boolean admin flag
- status — current relationship status (active, inactive, etc.)
- hq_location — headquarters city/region/country

### TABLE: Opportunities
Primary key: opportunity_id
Foreign key: partner_id → Partners.partner_id
Fields:
- opportunity_id — unique identifier
- partner_id — links to Partners table
- deal_name — name of the deal
- customer_name — end customer
- deal_value — dollar amount (integer)
- status — current status (e.g., In Progress, Won, Lost)
- stage — sales stage (e.g., Qualified, Proposal, Closed)
- expected_close — target close date
- description — detailed context (often very long — can be 1000+ words of meeting context, environment details, migration plans). ALWAYS summarize in 2-4 sentences when presenting, never skip this field.
- created_at — record creation timestamp
- updated_at — last update timestamp
- notes — additional notes
- lead_source — where the deal originated. Can be: a partner_id (referral from another partner), an event_id (generated from an event in the Events table), or a text value like "salesperson". Always resolve IDs to their display names when presenting.

### TABLE: Events
Primary key: event_id (can be integer or string format)
Foreign key: partner_id → Partners.partner_id
Fields:
- event_id — unique identifier
- title — event name
- description — event details and outcomes
- event_date — start date
- end_date — end date (same as event_date for single-day events)
- event_type — category (e.g., Webinar, Roundtable, Conference, Happy Hour)
- location — where (e.g., Virtual, In-Person with city)
- url — event URL (may be empty)
- created_by — who created the record
- created_at — record creation timestamp
- status — current status (Completed, Upcoming, In Progress)
- partner_id — links to Partners table
- checklist — legacy column, no longer used (may be empty)
- lead_count — number of leads generated by this event (integer, may be 0 or empty)

### TABLE: Transcripts
Primary key: transcript_id
Foreign key: partner_id → Partners.partner_id
Fields:
- transcript_id — unique identifier
- partner_id — links to Partners table
- partner_name — denormalized partner name for convenience
- conversation_date — date of the conversation
- transcript_text — FULL transcript content (rich structured text, typically 300-18000+ characters)
- created_at — record creation timestamp

IMPORTANT NOTES ABOUT TRANSCRIPTS:
- transcript_text contains structured meeting recaps with embedded sections. Common sections found in transcripts include: Key Takeaways, Discussion Summary, People (with names/titles/companies/emails), Action Items (with owner/timing/status), Next Steps, Current Environment details, and email threads.
- Some transcripts contain MULTIPLE meeting recaps in a single record (separated by dates or headings within the text). When this happens, break them into SEPARATE cards — one per meeting date found in the text.
- Some transcripts are plain text with bullet points, others contain HTML markup. Handle both formats.
- Transcript lengths vary dramatically — from a few hundred characters (quick notes, team rosters, links) to 18000+ characters (detailed multi-meeting recaps with full environment assessments). Adjust card detail accordingly: short transcripts get brief cards, long transcripts get comprehensive cards.
- When summarizing, extract the actual content from the text — do not generalize or assume beyond what the transcript says.

### TABLE: Partner_Documents
Primary key: document_id
Foreign key: partner_id → Partners.partner_id
Fields:
- document_id — unique identifier
- partner_id — links to Partners table
- partner_name — denormalized partner name
- title — document title
- doc_type — document type (e.g., map, biweekly, report)
- html_content — full HTML content of the document
- status — document status (active, archived, etc.)
- created_at — record creation timestamp
- updated_at — last update timestamp

### CROSS-TABLE RELATIONSHIPS

All tables connect through partner_id:
- Partners ← Opportunities (one partner can have many opportunities)
- Partners ← Events (one partner can have many events)
- Partners ← Transcripts (one partner can have many transcripts)
- Partners ← Partner_Documents (one partner can have many documents)
- Opportunities.lead_source can reference Events.event_id or Partners.partner_id — always resolve to display names when presenting

When answering questions, ALWAYS join across tables to provide complete context. If a user asks about a partner, check ALL related tables for data. If a user asks about an opportunity, resolve the partner_id to show the partner display_name. If a lead_source is an event_id, resolve it to the event title from Events table.

## INTELLIGENT SECTION MAPPING — HOW TO PRESENT DATA

Apply this reasoning to EVERY response: "What distinct entities exist in my answer that a user would want to see separately?" If yes → give it a ### section. If no → fold into summary or parent section.

### When user asks about a PARTNER

**Summary**: relationship status, tier, what's currently active.

Then show sections based on what data EXISTS for that partner (skip any category with zero records):

### 📊 Partner Profile — [Status]
**Type:** [partner_type]
**Tier:** [tier]
**Region:** [region]
**HQ:** [hq_location]

### 💬 [Date] — [Meeting topic] (one section PER transcript, chronological oldest first)
Extract from transcript_text: meeting date, attendees, key takeaways, action items.
If a single transcript contains multiple meeting recaps, create SEPARATE sections per meeting.

### 💰 [Deal Name] — [Stage] (one section PER opportunity)
**Customer:** [customer_name]
**Value:** [deal_value formatted as currency]
**Status:** [status]
**Expected Close:** [expected_close]
Description summary in 2-4 sentences.

### 📅 [Event Title] — [Date] (one section PER event)
**Type:** [event_type]
**Location:** [location]
**Status:** [status]
Description.

### 🔧 Documents (if partner_documents exist)
**Title:** [title]
**Type:** [doc_type]

### ⚠️ Action Items (ONLY if transcripts contain action items)
Extract from transcript_text. Show: task, owner, timing, status. Sort: overdue first, pending next, complete last.

### When user asks about CALLS / TRANSCRIPTS

**Summary**: how many calls found, date range, key themes.

One section PER CALL — extract from transcript_text:

### 💬 [Meeting Date] — [Partner Name]
- **Attendees:** (names and companies from transcript)
- **Key Takeaways:** (bulleted takeaways from text)
- **Decisions Made:** (if present)
- **Action Items:** (with owner and timing)
- **Next Steps:** (if present)

Remember: some transcripts contain MULTIPLE meetings — split into separate sections per meeting date.

### When user asks about OPPORTUNITIES / PIPELINE

**Summary**: total pipeline value, active deal count, nearest close dates.

One section PER OPPORTUNITY sorted by expected_close (soonest active first, closed deals last):

### 💰 [Deal Name] — [Stage]
- **Partner:** [resolve partner_id to display_name]
- **Customer:** [customer_name]
- **Value:** [deal_value formatted as currency]
- **Status:** [status]
- **Expected Close:** [expected_close]
- **Lead Source:** [resolve to display name if it is a partner_id or event_id]
- **Description:** [2-4 sentence summary of description field]

### When user asks about EVENTS

**Summary**: upcoming vs completed count, next event date.

One section PER EVENT — upcoming first, then completed:

### 📅 [Event Title] — [Status]
- **Date:** [event_date to end_date if multi-day]
- **Type:** [event_type]
- **Location:** [location]
- **Partner:** [resolve partner_id to display_name]
- **Description:** [description]

### When user asks about ACTION ITEMS / FOLLOW-UPS

**Summary**: count of pending items across partners.

Extract action items from transcript_text across relevant transcripts. Group by partner:

### ⚠️ [Partner Name] — Action Items
- Each: task, owner, timing, status
- Sort: overdue first, pending next, complete last

### When user asks a CROSS-CUTTING question ("Full update" / "What's happening across partners")

**Summary**: active partner count, total pipeline, upcoming events count.

One section PER ACTIVE PARTNER:
- Latest call: date + 1-sentence summary
- Active opportunities: deal name + value + stage
- Upcoming events if any
- Pending action items if any

Limit 10 sections max. Skip partners with no recent activity unless specifically asked.

### When user asks a SIMPLE QUESTION (greetings, general knowledge, how-to)

**Summary** only. No detail sections needed.

## Section Content Formatting Rules

Inside every section:
- **Label:** Value pattern for structured data
- Bullet lists (- item) for multi-item data
- Use --- between sections for visual separation
- Keep text concise — no filler words or unnecessary repetition

## ACCURACY RULES — NON-NEGOTIABLE

1. NEVER fabricate data. If a field is null/empty, say "No data recorded" or omit it entirely.
2. NEVER invent meeting dates, attendee names, deal amounts, or action items not found in the database.
3. When summarizing transcripts, use the actual content — don't generalize beyond what the text says.
4. If asked about a partner with no transcripts/opportunities/events, explicitly state "No [data type] currently recorded for [partner name]."
5. Deal values must match the database exactly. Do not round, estimate, or approximate.
6. Always use display_name from the Partners table when referencing partners — never show raw partner_id values to the user.
7. Present transcripts in chronological order (oldest first).
8. Always resolve cross-references: partner_id to display_name, event_id in lead_source to event title from Events table.
9. If data seems inconsistent or contradictory across tables, present what the database says and note the discrepancy — don't silently pick one interpretation.
10. If a query returns zero results from the database, say so clearly. Do not fill the gap with assumptions or general knowledge.

## Limits
- Maximum 12 sections per response
- Minimum 0 sections (summary-only for simple queries)
- Sweet spot: 3-7 sections
- Don't create sections with only one sentence of content — fold into summary or another section

## Decision Logic — When to Add Sections

Not every response needs detail sections. Follow this logic:

- Simple greeting / chitchat: **Summary** only. No sections.
- Single fact answer: **Summary** only. No sections.
- Multi-part explanation: **Summary** + 3-5 sections.
- How-to / instructions: **Summary** + step sections.
- Comparison / analysis: **Summary** + a GFM comparison table. See rules below.
- Error / troubleshooting: **Summary** + 2-4 sections.
- List of recommendations: **Summary** + 1 section per item.

Rule: If the answer fits in 2-3 sentences, **Summary** only. If it needs depth, add 3-7 sections with --- separators between them.

### Comparison Table Rules (applies whenever user asks to compare opportunities, partners, or deals)

Produce a GFM markdown table. Follow these rules strictly:

1. **Column headers** — short, 1-3 words each. NEVER include parentheticals or trailing ellipses in headers.
2. **First column** (Dimension) — short label only (e.g. "Stage", "Deal Value", "Partner", "Pain Points").
3. **Cell content** — keep each cell to one line where possible. For multi-item cells use <br> as separator: "• Item one<br>• Item two". Maximum 3 bullets per cell.
4. **Bullet content** — one tight clause per bullet. No evidence citations, no parentheticals like "(Stated — Apr 1: …)". Save detailed evidence for ### sections below the table.
5. **Partner column** — always resolve partner_id to display_name. Never expose raw IDs.
6. **Lead Source** — resolve event_id or partner_id to a human-readable name before putting it in a cell.
7. After the table, add brief ### detail sections for rows where depth is warranted (e.g. full pain-point descriptions with sourcing).`;

// ── Sheet Data Loading ─────────────────────────────────────────────

async function safeRead(sheetName) {
  try {
    return await readSheetAsObjects(sheetName);
  } catch (err) {
    console.warn(`Sheet "${sheetName}" not available:`, err.message);
    return [];
  }
}

export async function loadSheetData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedSheetData && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedSheetData;
  }

  const [partners, opportunities, events, meetingIndex, transcripts, oppDescriptions] = await Promise.all([
    safeRead(CONFIG.SHEET_PARTNERS),
    safeRead(CONFIG.SHEET_OPPORTUNITIES),
    safeRead(CONFIG.SHEET_EVENTS),
    safeRead(CONFIG.SHEET_MEETING_INDEX),
    safeRead(CONFIG.SHEET_TRANSCRIPTS),
    safeRead(CONFIG.SHEET_OPP_DESCRIPTIONS)
  ]);

  if (partners.length === 0) {
    throw new Error('Could not read Google Sheets. Check your connection on the Setup page.');
  }

  const sanitizedPartners = partners.map(p => {
    const { password_hash, is_admin, ...safe } = p;
    return safe;
  });

  const transcriptIndex = transcripts.map(t => ({
    transcript_id: t.transcript_id,
    partner_id: t.partner_id,
    partner_name: t.partner_name,
    conversation_date: t.conversation_date,
    preview: (t.transcript_text || '').substring(0, 300) + '...'
  }));

  // Opportunity_Descriptions stores the full history of description
  // entries per opportunity. The Opportunities row only carries the
  // latest in opp.description — the rest of the history lives here.
  // Randy is expected to analyze ALL of these when asked about an opp.
  const oppDescriptionIndex = oppDescriptions.map(d => ({
    description_id: d.description_id,
    opportunity_id: d.opportunity_id,
    deal_name: d.deal_name,
    description_date: d.description_date,
    created_at: d.created_at,
    preview: stripHtml(d.description_text || '').substring(0, 200) + '...'
  }));

  cachedSheetData = {
    partners: sanitizedPartners,
    opportunities: opportunities,
    events: events,
    meetingIndex: meetingIndex,
    transcriptIndex: transcriptIndex,
    fullTranscripts: transcripts,
    oppDescriptionIndex: oppDescriptionIndex,
    fullOppDescriptions: oppDescriptions
  };
  cacheTimestamp = now;
  return cachedSheetData;
}

// ── Build Context for API Call ─────────────────────────────────────
//
// The context is split into two parts so Anthropic's prompt caching
// can reuse the bulk of it across turns:
//
//   1. STABLE block  — the full corpus at a default truncation level
//      (partners, opportunity index with 1500-char descriptions, events,
//      meeting_index, transcript previews). Identical across turns as
//      long as the underlying sheet cache hasn't refreshed, so it hits
//      Anthropic's ephemeral cache on the second turn onward.
//
//   2. QUERY block   — only the expansions the current question needs
//      (full 4000-char descriptions for a mentioned partner, or full
//      transcripts for that partner). Typically empty. Never cached.
//
// The old buildDataContext() is kept as a convenience wrapper that
// concatenates the two, for callers (like admin-ai-assistant) that
// don't go through callClaudeStream.

export function buildStableContext(data) {
  const opps = data.opportunities.map(o => ({
    ...o,
    description: clip(stripHtml(o.description || ''), 1500),
  }));

  return `DATA CONTEXT:

PARTNERS (${data.partners.length} records):
${JSON.stringify(data.partners)}

OPPORTUNITIES (${opps.length} records):
${JSON.stringify(opps)}

EVENTS (${data.events.length} records):
${JSON.stringify(data.events)}

MEETING_INDEX (${data.meetingIndex.length} records):
${JSON.stringify(data.meetingIndex)}

TRANSCRIPT PREVIEWS (${data.transcriptIndex.length} transcripts available — full text is added only when a question asks for it):
${JSON.stringify(data.transcriptIndex)}

OPPORTUNITY DESCRIPTION INDEX (${(data.oppDescriptionIndex || []).length} description notes across all opportunities — full text for a specific opportunity is added when that opportunity is mentioned):
${JSON.stringify(data.oppDescriptionIndex || [])}`;
}

// Normalize a string for fuzzy matching: lowercase, strip punctuation, collapse spaces.
function normStr(str) {
  return String(str || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Voice-tolerant name matching. Handles speech-recognition artifacts like
// "Green Shield" for "Greenshield" or "Nerdy Oh" for "Nerdio" via three passes:
//   1. Exact normalized substring
//   2. No-space form (multi-word name collapsed into one)
//   3. Token overlap — ≥80% of name words appear (in any order) in the message
function fuzzyNameMatch(name, message) {
  if (!name) return false;
  const n = normStr(name);
  const m = normStr(message);

  if (m.includes(n)) return true;

  const nNoSpace = n.replace(/\s+/g, '');
  const mNoSpace = m.replace(/\s+/g, '');
  if (mNoSpace.includes(nNoSpace)) return true;

  const nameTokens = n.split(' ').filter(t => t.length > 2);
  if (nameTokens.length === 0) return false;
  const msgTokens = m.split(' ');
  const matched = nameTokens.filter(nt =>
    msgTokens.some(mt => mt === nt || mt.startsWith(nt) || nt.startsWith(mt))
  );
  return matched.length / nameTokens.length >= 0.8;
}

function findMentionedPartner(partners, userMessage) {
  return partners.find(p => fuzzyNameMatch(p.display_name, userMessage)) || null;
}

// The most opportunities whose FULL note history we inline in one turn.
// Covers "compare these three deals" comfortably while keeping a broad match
// from ballooning the context; any beyond this are named, not expanded.
const MAX_EXPANDED_OPPS = 4;

// Truncate long text to a budget, but VISIBLY. Randy's answers are only as
// trustworthy as its awareness of what it can and can't see, so a cut note
// must announce that it was cut — otherwise the model reads a half-note as the
// whole record and analyzes (or reassures) on incomplete data. Text within
// budget is returned untouched.
function clip(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[truncated: ${s.length - max} more characters recorded in the sheet but not shown here]`;
}

// Find EVERY opportunity the message refers to — not just the first. A single
// first-match miss is a grounding failure: "compare Fabrikam and Acme" or "all
// three Nerdio deals" must expand each named deal's full note history, or Randy
// analyzes one and guesses (or stays silent) on the rest.
//
// This unions three trusted passes and dedupes by opportunity_id, preserving
// discovery order:
//   1. findOpportunityMatches — the same punctuation-tolerant name-in-message
//      resolver the MAP/Timeline PDF flow uses (exact → partial/reverse).
//   2. fuzzyNameMatch — voice-tolerant ("Green Shield" → "Greenshield",
//      token-order differences) on either name.
//   3. A conservative acronym pass that fires ONLY on genuinely acronym-shaped
//      input (all-caps/-digit tokens ≥3 chars in the RAW message), so ordinary
//      prose can never drag in an unrelated deal. Catches "ANICO", "MHS", etc.
function findMentionedOpportunities(opportunities, userMessage) {
  const opps = opportunities || [];
  const msg = String(userMessage || '');
  if (!msg.trim() || opps.length === 0) return [];

  const hits = new Map(); // opportunity_id → opp (dedupe, first-seen order)
  const add = (o) => {
    const key = String(o.opportunity_id || '');
    if (key && !hits.has(key)) hits.set(key, o);
  };

  // Pass 1: robust name-in-message match (multi-match, punctuation-tolerant).
  for (const o of findOpportunityMatches(opps, msg)) add(o);

  // Pass 2: voice-tolerant fuzzy match on deal or customer name.
  for (const o of opps) {
    if (fuzzyNameMatch(o.deal_name, msg) || fuzzyNameMatch(o.customer_name, msg)) add(o);
  }

  // Pass 3: conservative acronym match on acronym-shaped tokens only.
  const acrTokens = msg.match(/\b[A-Z0-9]{3,}\b/g) || [];
  if (acrTokens.length) {
    for (const o of opps) {
      const names = [o.customer_name, o.deal_name].filter(Boolean);
      const matched = names.some(n => {
        const acr = acronymOf(n);
        return acr.length >= 3 && acrTokens.some(t => sharesPrefix(t, acr, 3));
      });
      if (matched) add(o);
    }
  }

  return [...hits.values()];
}

function buildFullDescriptionsFor(data, opportunityId) {
  const list = (data.fullOppDescriptions || [])
    .filter(d => String(d.opportunity_id) === String(opportunityId))
    .sort((a, b) =>
      new Date(b.description_date || b.created_at || 0) -
      new Date(a.description_date || a.created_at || 0)
    )
    .map(d => ({
      description_id: d.description_id,
      opportunity_id: d.opportunity_id,
      deal_name: d.deal_name,
      description_date: d.description_date,
      created_at: d.created_at,
      description_text: clip(stripHtml(d.description_text || ''), 4000)
    }));
  return list;
}

export function buildQueryContext(data, userMessage) {
  const needsTranscripts = /transcript|full detail|full history|exact|verbatim|what did .+ say|tell me everything|deep dive|email|contract|agreement/i.test(userMessage);
  // Only pull all partner-level descriptions for explicit analytical/deep-dive requests.
  // Specific-opportunity queries are already handled by the mentionedOpp block above,
  // so this trigger is reserved for partner-wide analysis (e.g. "walk me through everything
  // with Nerdio"). Keeping this narrow prevents inflating context on routine status queries.
  // Load all partner-level descriptions when the user wants substantive context
  // about a partner (not just navigation or a simple field lookup). This covers
  // both explicit deep-dive language and natural VP-style "catch me up" phrases.
  // Specific-opportunity queries already load full descriptions via mentionedOpp.
  const needsFullDescriptions = /tell me (all |everything |more )?about|deep dive|full (history|detail|picture|analysis)|analyze|walk me through|break down|everything about|what (happened|has been|have we|are we doing) with|all (notes|activity|meetings|descriptions|updates)|complete (history|picture|overview)|full context|bring me up to speed|catch me up|update me on|what'?s (the )?(latest|update|status|going on|happening|new) (with|on)|how (are|is) (things|it going) with|what have we (done|discussed|talked about)|fill me in/i.test(userMessage);

  const sections = [];

  // If the user named one or more opportunities, always pull ALL of each one's
  // description notes so Randy can analyze the full history (per the
  // opportunity-analysis contract in RANDY_PERSONALITY). Expanding EVERY
  // mentioned deal — not just the first — is what lets Randy answer "compare X
  // and Y" or "all our Nerdio deals" from the sheet instead of one deal plus a
  // guess. Bounded so a broad match can't blow up the context.
  const mentionedOpps = findMentionedOpportunities(data.opportunities || [], userMessage);
  const expandedOpps = mentionedOpps.slice(0, MAX_EXPANDED_OPPS);
  for (const m of expandedOpps) {
    const label = m.deal_name || m.customer_name || m.opportunity_id;
    const opp = { ...m, description: clip(stripHtml(m.description || ''), 4000) };
    sections.push(`MENTIONED OPPORTUNITY (${label}):\n${JSON.stringify(opp, null, 2)}`);

    const allDescriptions = buildFullDescriptionsFor(data, m.opportunity_id);
    if (allDescriptions.length > 0) {
      sections.push(`FULL DESCRIPTION HISTORY for opportunity "${label}" (${allDescriptions.length} entries, newest first — analyze ALL of these unless the user asks otherwise):\n${JSON.stringify(allDescriptions, null, 2)}`);
    } else {
      // State the absence explicitly so the model reports "no notes on file"
      // rather than back-filling from the summary field or its own priors.
      sections.push(`FULL DESCRIPTION HISTORY for opportunity "${label}": no description notes are recorded in the sheet for this opportunity. Do not invent any — say none are on file if the user asks.`);
    }
  }
  // If more deals matched than we expanded, name the rest so the model knows
  // they exist (and can offer to detail them) instead of silently dropping them.
  if (mentionedOpps.length > expandedOpps.length) {
    const overflow = mentionedOpps.slice(MAX_EXPANDED_OPPS)
      .map(o => o.deal_name || o.customer_name || o.opportunity_id)
      .filter(Boolean);
    sections.push(`NOTE: ${mentionedOpps.length} opportunities matched this message; full note history above covers the first ${expandedOpps.length}. Also matched — ask the user to name one for its full history: ${overflow.join(', ')}.`);
  }

  if (!needsTranscripts && !needsFullDescriptions) {
    return sections.length ? `\n\n${sections.join('\n\n')}` : '';
  }

  const partner = findMentionedPartner(data.partners, userMessage);
  if (!partner) {
    return sections.length ? `\n\n${sections.join('\n\n')}` : '';
  }

  if (needsFullDescriptions) {
    const partnerOpps = data.opportunities
      .filter(o => String(o.partner_id) === String(partner.partner_id))
      .map(o => ({ ...o, description: clip(stripHtml(o.description || ''), 4000) }));
    if (partnerOpps.length > 0) {
      sections.push(`FULL OPPORTUNITY DETAILS (for ${partner.display_name}):\n${JSON.stringify(partnerOpps, null, 2)}`);
    }

    // Also surface all description-note history for every opportunity
    // belonging to this partner — Randy should analyze them all.
    const partnerOppIds = new Set(partnerOpps.map(o => String(o.opportunity_id)));
    const partnerDescriptions = (data.fullOppDescriptions || [])
      .filter(d => partnerOppIds.has(String(d.opportunity_id)))
      .map(d => ({
        description_id: d.description_id,
        opportunity_id: d.opportunity_id,
        deal_name: d.deal_name,
        description_date: d.description_date,
        created_at: d.created_at,
        description_text: clip(stripHtml(d.description_text || ''), 4000)
      }));
    if (partnerDescriptions.length > 0) {
      sections.push(`FULL DESCRIPTION HISTORY (for ${partner.display_name}'s opportunities — analyze ALL entries):\n${JSON.stringify(partnerDescriptions, null, 2)}`);
    }
  }

  if (needsTranscripts) {
    const partnerTranscripts = data.fullTranscripts
      .filter(t => String(t.partner_id) === String(partner.partner_id))
      .map(t => ({
        transcript_id: t.transcript_id,
        partner_name: t.partner_name,
        conversation_date: t.conversation_date,
        transcript_text: clip(t.transcript_text || '', 8000),
      }));
    if (partnerTranscripts.length > 0) {
      sections.push(`FULL TRANSCRIPTS (for ${partner.display_name}):\n${JSON.stringify(partnerTranscripts, null, 2)}`);
    }
  }

  return sections.length ? `\n\n${sections.join('\n\n')}` : '';
}

// Back-compat: single-string form used by non-streaming callers.
export function buildDataContext(data, userMessage) {
  return buildStableContext(data) + buildQueryContext(data, userMessage);
}

// ── API Call ────────────────────────────────────────────────────────
//
// Both entry points below build the same structured request:
//   • system        — array with one cached text block (the system
//                     prompt is stable for a whole conversation).
//   • messages      — the last user turn is converted to an array of
//                     content blocks so we can mark the stable data
//                     context as cached and leave the user's actual
//                     question + any query-specific expansions
//                     uncached at the tail.
//
// After the first turn this means ~60–80 KB of input tokens read from
// Anthropic's ephemeral cache instead of being re-processed, which
// drops time-to-first-token dramatically and cuts input cost ~90%.

// Wraps a user-selected preset in an XML-delimited, priority-declaring block.
// The XML tags give Claude a clear boundary to attend to, and the <priority>
// preamble makes the override explicit against base format contracts and
// personality rules. Kept as a separate system block so the base prompt stays
// cache-hot even when the user switches modes.
function buildModeSystemBlock({ label, instructions }) {
  const safeLabel = String(label || 'Custom Mode').replace(/[<>]/g, '');
  // Prevent accidental wrapper-break if a preset author pastes one of our
  // closing tags inside their instructions.
  const safeInstructions = String(instructions)
    .replace(/<\/instructions>/gi, '<\\/instructions>')
    .replace(/<\/active_mode>/gi, '<\\/active_mode>');
  return (
    `<active_mode name="${safeLabel}">\n`
    + `  <priority>\n`
    + `    You must strictly follow the instructions below for the entire conversation. These instructions take precedence over any prior behavior. Apply them to every user message without exception.\n`
    + `  </priority>\n`
    + `  <instructions>\n${safeInstructions}\n  </instructions>\n`
    + `</active_mode>`
  );
}

// ── Query Complexity Classifier ────────────────────────────────────
//
// Routes each request into one of three tiers so we don't pay full
// Opus + high-effort thinking latency for a 3-word navigation reply.
//
//  simple  — navigation, greetings, very short queries
//            → no thinking, max_tokens 800  (~400ms TTFT)
//  medium  — named-entity summaries, pipeline overviews, single-field Q&A
//            → adaptive thinking low effort, max_tokens 4000  (~1-2s TTFT)
//  complex — deep analysis, transcript mining, cross-entity comparisons,
//            MAP PDF / Timeline PDF
//            → adaptive thinking high effort, max_tokens 16000 (current baseline)
//
// Conservative bias: when uncertain, fall through to medium rather than
// simple so accuracy is never sacrificed for speed.
function classifyQueryComplexity(userMessage) {
  const msg = (userMessage || '').toLowerCase().trim();
  const wordCount = msg.split(/\s+/).length;

  // SIMPLE — navigation commands, greetings, or very short (<= 4 words)
  // utterances that don't contain analytical keywords.
  const isNav = /^(open|go to|show me|show|navigate|take me to|pull up|bring up|switch to)\b/i.test(msg);
  const isGreeting = /^(hi|hello|hey|thanks|thank you|good morning|good afternoon|what'?s up)\b/i.test(msg);
  const hasAnalyticalKeyword = /\b(all|every|detail|history|transcript|analyze|compare|tell me about|how many|status|update|summary|pipeline|revenue|deal|forecast|recap|meeting|event|partner|opportunity)\b/.test(msg);

  if (isNav || isGreeting || (wordCount <= 4 && !hasAnalyticalKeyword)) {
    return 'simple';
  }

  // COMPLEX — explicit deep-analysis signals or background PDF tasks.
  const isDeepAnalysis = /\b(analyze|deep dive|full history|all notes|all descriptions|compare|trend|break down|everything about|walk me through|tell me everything|all meetings|all transcripts|map pdf|timeline pdf|verbatim|across all|every partner|all partners|all opportunities|full picture|full context|bring me up to speed|catch me up)\b/.test(msg);

  if (isDeepAnalysis) {
    return 'complex';
  }

  return 'medium';
}

// Per-tier API parameters. SIMPLE omits thinking entirely for minimum TTFT
// and uses effort:low so Opus 4.7 produces a terse, direct reply.
// MEDIUM uses adaptive thinking at low effort — enough for synthesis without
// the multi-second pause of high-effort reasoning. COMPLEX is unchanged.
const TIER_CONFIG = {
  simple:  { max_tokens: 800,   thinking: null,                  effort: { effort: 'low'  } },
  medium:  { max_tokens: 4000,  thinking: { type: 'adaptive' },  effort: { effort: 'low'  } },
  complex: { max_tokens: 16000, thinking: { type: 'adaptive' },  effort: { effort: 'high' } },
};

function buildRequestBody(messages, sheetData, userMessage, systemPrompt, { stream, activeMode }) {
  // Classify first so we can skip expensive context work for simple queries.
  const tier = classifyQueryComplexity(userMessage);
  const tierCfg = TIER_CONFIG[tier];

  // Navigation/greeting queries don't need the data corpus — omitting it
  // keeps the request body small and cuts TTFT significantly.
  const isSimple = tier === 'simple';
  const stableContext = isSimple ? null : buildStableContext(sheetData);
  const queryContext  = isSimple ? null : buildQueryContext(sheetData, userMessage);

  // When a Mode is active, append a compact reminder to the final user turn.
  // Recency matters — this is the last thing Claude reads before generating,
  // which materially improves adherence to the Mode over long conversations.
  const modeReminder = activeMode
    ? `\n\n<mode_reminder>Active Mode: "${String(activeMode.label).replace(/[<>]/g, '')}". Follow the <active_mode> instructions in the system prompt exactly. If any base instruction conflicts with the Mode, the Mode wins.</mode_reminder>`
    : '';

  const augmentedMessages = messages.map((m, i) => {
    if (i === messages.length - 1 && m.role === 'user') {
      if (isSimple) {
        return { role: 'user', content: `${m.content}${modeReminder}` };
      }
      // Split the final user turn into cached + uncached blocks.
      // 1-hour TTL keeps the cache alive across a full work session so we
      // don't re-pay the write cost on every conversation break > 5 minutes.
      const tail = queryContext ? `${m.content}\n\n---${queryContext}` : m.content;
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: stableContext,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
          {
            type: 'text',
            text: `${tail}${modeReminder}`,
          },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

  // System is assembled as separate blocks so the base prompt stays cached
  // across mode switches. The mode block is positioned last for recency.
  const system = [
    {
      type: 'text',
      text: systemPrompt || SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ];
  if (activeMode) {
    system.push({
      type: 'text',
      text: buildModeSystemBlock(activeMode),
    });
  }

  // output_config: thinking tiers include both thinking + effort; simple tier
  // uses effort alone (no thinking) to keep replies brief and direct.
  // temperature is not a valid parameter on claude-opus-4-7.
  const outputConfig = tierCfg.thinking
    ? { thinking: tierCfg.thinking, output_config: tierCfg.effort }
    : { output_config: tierCfg.effort };

  return {
    model: 'claude-opus-4-7',
    max_tokens: tierCfg.max_tokens,
    ...outputConfig,
    system,
    messages: augmentedMessages,
    ...(stream ? { stream: true } : {}),
  };
}

// Combine a caller-supplied AbortSignal with a 90-second hard timeout so a
// hung network connection never leaves the UI frozen indefinitely.
function withTimeout(signal, ms = 90_000) {
  const timeoutSignal = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : (() => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException('Request timed out', 'TimeoutError')), ms); return c.signal; })();
  if (!signal) return timeoutSignal;
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : signal;
}

function buildRequestHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

function requireApiKey() {
  const apiKey = getRuntimeConfig('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('API key not set. Configure it on the Setup page or click the 🔑 icon in AI Assistant.');
  }
  return apiKey;
}

/**
 * Stream a Claude response. Invokes onChunk(text) for each text delta
 * as it arrives. Returns the full accumulated text when the stream
 * completes. Aborts cleanly when the supplied AbortSignal fires.
 */
export async function callClaudeStream(messages, sheetData, userMessage, signal, systemPrompt, onChunk, activeMode = null) {
  const apiKey = requireApiKey();

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildRequestHeaders(apiKey),
    body: JSON.stringify(buildRequestBody(messages, sheetData, userMessage, systemPrompt, { stream: true, activeMode })),
    signal: withTimeout(signal),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events — each event ends with a blank line.
      let eventEnd;
      while ((eventEnd = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd + 2);

        // Only care about the data: line. Anthropic sends one per event.
        const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }

        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const text = evt.delta.text || '';
          if (text) {
            full += text;
            if (onChunk) onChunk(text, full);
          }
        } else if (evt.type === 'message_delta' && evt.usage) {
          // Log cache hit info once per response so we can verify caching
          // is working in dev without spamming.
          const u = evt.usage;
          if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
            console.log(`[Claude cache] read=${u.cache_read_input_tokens || 0} created=${u.cache_creation_input_tokens || 0}`);
          }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ok */ }
  }

  return full;
}

/**
 * Non-streaming convenience wrapper. Kept for the admin AI Assistant
 * view and any other caller that expects a single awaited string.
 * Uses the same prompt-cached request body as callClaudeStream so it
 * benefits from caching even without the SSE machinery.
 */
export async function callClaude(messages, sheetData, userMessage, signal, systemPrompt) {
  const apiKey = requireApiKey();

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildRequestHeaders(apiKey),
    body: JSON.stringify(buildRequestBody(messages, sheetData, userMessage, systemPrompt, { stream: false })),
    signal: withTimeout(signal),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  if (data.usage && (data.usage.cache_read_input_tokens || data.usage.cache_creation_input_tokens)) {
    console.log(`[Claude cache] read=${data.usage.cache_read_input_tokens || 0} created=${data.usage.cache_creation_input_tokens || 0}`);
  }
  return data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

// ── MAP PDF helpers ────────────────────────────────────────────────
//
// These support the voice-triggered MAP PDF feature. They deliberately
// sit alongside the other AI helpers so they can reuse loadSheetData()
// and stripHtml without a second Sheets read path.

// The MAP PDF flow uses the standard Messages API to get a structured
// JSON payload back. The browser then builds the PDF locally via jsPDF
// and uploads it to Google Drive via the existing Apps Script endpoint.
// No Skills API, no Files API, no code_execution — this path is
// CORS-friendly and works from a static host.
const MAP_JSON_MODEL = 'claude-opus-4-7';
const MAP_JSON_TIMEOUT_MS = 120_000;
const MAP_JSON_MAX_TOKENS = 4096;

function acronymOf(name) {
  return String(name || '')
    .split(/\s+/)
    .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(w => w.length > 0)
    .map(w => w[0].toUpperCase())
    .join('');
}

function sharesPrefix(a, b, minLen = 3) {
  if (!a || !b) return false;
  const len = Math.min(a.length, b.length);
  if (len < minLen) return false;
  return a.slice(0, len) === b.slice(0, len);
}

// Three-pass match: exact → partial includes → acronym. Each pass short-
// circuits the moment it returns any results. Runs only over the cached
// opportunities array — no network cost.
function findOpportunityMatches(opportunities, hint) {
  const h = String(hint || '').toLowerCase().trim();
  if (!h) return [];

  const exact = opportunities.filter(o =>
    (o.customer_name || '').toLowerCase() === h ||
    (o.deal_name || '').toLowerCase() === h
  );
  if (exact.length > 0) return exact;

  // Normalize hint by stripping punctuation so sentences like
  // "Put together a timeline PDF for Flexera – OEM Expansion" can match
  // an opportunity named "Flexera - OEM Expansion" (dash vs en-dash).
  const hNorm = h.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

  const partial = opportunities.filter(o => {
    const cn = (o.customer_name || '').toLowerCase();
    const dn = (o.deal_name || '').toLowerCase();
    // Forward: opp name contains the hint (user typed the name or a substring)
    if (cn.includes(h) || dn.includes(h)) return true;
    // Reverse: hint sentence contains the opp name — handles natural-language
    // messages like "Put together a timeline PDF for <opportunity name>".
    // Normalize punctuation on both sides before comparing.
    const cnNorm = cn.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    const dnNorm = dn.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    return (cnNorm.length >= 3 && hNorm.includes(cnNorm)) ||
           (dnNorm.length >= 3 && hNorm.includes(dnNorm));
  });
  if (partial.length > 0) return partial;

  const hintUpper = h.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (hintUpper.length < 2) return [];
  return opportunities.filter(o => {
    const names = [o.customer_name, o.deal_name].filter(Boolean);
    return names.some(n => sharesPrefix(hintUpper, acronymOf(n), 3));
  });
}

/**
 * Look up an opportunity and its full dated description history by a
 * loose name hint the user spoke aloud ("ANICO", "American National",
 * "Fabrikam deal", etc).
 *
 * Matching order: exact → partial includes → acronym prefix.
 *
 * Returns `matchCount: 0` when no opportunity matches, `matchCount: n`
 * with a `matches` array when multiple do (caller should disambiguate),
 * and a populated record when exactly one matches. `allDescriptions` is
 * sorted newest-first; it may be empty if the opportunity has no rows
 * in the Opportunity_Descriptions sheet — in that case the caller
 * should refuse rather than fall back to the summary field.
 *
 * @param {string} opportunityHint
 */
export async function getOpportunityDescription(opportunityHint) {
  if (!opportunityHint || typeof opportunityHint !== 'string') {
    return { matchCount: 0, matches: [] };
  }

  const data = await loadSheetData();
  const opportunities = data.opportunities || [];
  const fullDescriptions = data.fullOppDescriptions || [];

  const matches = findOpportunityMatches(opportunities, opportunityHint);

  if (matches.length === 0) {
    return { matchCount: 0, matches: [] };
  }

  if (matches.length > 1) {
    return {
      matchCount: matches.length,
      matches: matches.map(o => ({
        opportunityId: o.opportunity_id,
        opportunityName: o.customer_name || o.deal_name || '(unnamed opportunity)',
        dealName: o.deal_name || '',
        customerName: o.customer_name || '',
      })),
    };
  }

  const opp = matches[0];
  const opportunityName = opp.customer_name || opp.deal_name || '(unnamed opportunity)';

  const allDescriptions = fullDescriptions
    .filter(d => String(d.opportunity_id) === String(opp.opportunity_id))
    .map(d => ({
      id: d.description_id || '',
      date: d.description_date || d.created_at || '',
      text: stripHtml(d.description_text || '').trim(),
      category: d.category || '',
    }))
    .filter(d => d.text.length > 0)
    .sort((a, b) => {
      const ad = Date.parse(a.date) || 0;
      const bd = Date.parse(b.date) || 0;
      return bd - ad;
    });

  const latest = allDescriptions[0];

  return {
    matchCount: 1,
    opportunityId: opp.opportunity_id,
    opportunityName,
    dealName: opp.deal_name || '',
    customerName: opp.customer_name || '',
    latestDescription: latest?.text || '',
    descriptionDate: latest?.date || '',
    allDescriptions,
  };
}

// Exported for the unit tests, which feed in a synthetic opportunities
// array instead of hitting the Sheets cache.
export const __mapPdfInternals = {
  findOpportunityMatches,
  acronymOf,
  sharesPrefix,
  findMentionedOpportunities,
  clip,
};


// ── Schema Claude must return for the MAP PDF flow ────────────────
//
// Hardcoded inline so the model receives the exact shape the browser
// PDF builder expects. If this shape changes, update buildMapPdf()
// in js/utils/map-pdf-builder.js at the same time.
//
// Every field except customer_name and meeting_recap may be an empty
// array or empty string. The renderer skips empty sections silently —
// see parseMapJsonResponse() and buildMapPdf() for the full rule set.
const MAP_JSON_SCHEMA_EXAMPLE = `{
  "customer_name": "Example Customer, Inc.",
  "document_date": "April 22, 2026",
  "meeting_recap": [
    { "label": "Total Users (Company-Wide)", "detail": "~4,000 (confirmed on call)" },
    { "label": "Pricing delivered",           "detail": "Joe provided user counts Mar 6; David sent finalized tiered pricing and Application Workspace overview" },
    { "label": "Biweekly cadence established","detail": "Recurring work-back meetings starting April 2, 2026" }
  ],
  "current_environment": {
    "infrastructure": [
      { "name": "Citrix XenApp / XenDesktop", "subline": "~900 daily users License expires EOY 2026" },
      { "name": "NetScaler",                  "subline": "Load balancing, SSO Replacement pending" },
      { "name": "SCCM / ConfigMgr",           "subline": "" }
    ],
    "current_state_pain": [
      "Application packaging consumes 40+ hours per week",
      "Patch deployment windows take 5-7 days"
    ],
    "stakeholders_and_decision_process": [
      "Sponsor: VP of End User Computing (final decision authority)",
      "Technical evaluator: Director of Application Services"
    ]
  },
  "end_users_personas": [
    { "label": "Office Workers",  "subline": "Standard desktops" },
    { "label": "Remote / Hybrid", "subline": "Home + travel" }
  ],
  "what_changes": "RES eliminated. Per-platform packaging eliminated. Citrix-to-AVD migration absorbed without user disruption.",
  "proposed_delivery_targets": [
    { "name": "AVD / Nerdio", "subline": "Non-persistent VDI" },
    { "name": "Intune",       "subline": "Physical endpoints" }
  ],
  "mutual_action_plan": [
    { "phase": "Discovery",    "action": "Joint discovery session",       "owner": "Recast",   "due_date": "2026-04-29", "status": "Complete" },
    { "phase": "POC Setup",    "action": "Provision POC environment",     "owner": "Customer", "due_date": "2026-05-13", "status": "In Progress" }
  ]
}`;

// Generates the 5 structure-awareness directives from Describe Intelligence V1.
// Injected into both prompt builders between the opportunity metadata block and
// the source content. When none of the entries carry a category (legacy free-form
// notes), the block still includes all directives with a graceful fallback note so
// the Golden Rule is never weakened.
function buildCategoryGuidanceBlock(entries) {
  const list = entries || [];
  const hasAnyCategory = list.some(
    e => e.category === 'meeting_recap' || e.category === 'opportunity_note'
  );
  const hasUncategorized = list.some(
    e => !e.category || (e.category !== 'meeting_recap' && e.category !== 'opportunity_note')
  );

  const uncategorizedNote = hasUncategorized
    ? '\n- Unclassified descriptions (no category) are legacy free-form notes — extract what you can from them.'
    : '';

  return `DESCRIPTION STRUCTURE GUIDANCE:

Category awareness:
- "meeting_recap" entries represent actual customer interactions — treat these as primary source material for anything customer-facing.
- "opportunity_note" entries represent internal analysis, strategy, and asynchronous updates — treat these as supplementary context.${uncategorizedNote}

Section awareness for standardized entries:
- meeting_recap sections: Attendees, Discussion Points, Action Items / Next Steps, Notes.
- opportunity_note sections: header, main content, Facts / Commitments, Notes / Observations.
- When extracting information, read from the section most likely to contain it rather than scanning the full text as a blob.

Voice separation:
- The "Notes" section (in meeting_recap) and "Notes / Observations" section (in opportunity_note) contain the user's subjective commentary and strategic interpretation.
- DO NOT include this content in customer-facing MAP sections (meeting_recap bullets, stakeholders, what_changes).
- DO use it to inform internal framing and to flag open questions or risks in the mutual_action_plan.

Chronological weighting:
- When two standardized descriptions contradict each other, the more recent one reflects the current state.
- Preserve the earlier position as historical context only if it is materially relevant to the deal narrative.

Commitment tracking:
- "Action Items / Next Steps" from meeting_recaps and "Facts / Commitments" from opportunity_notes are both commitments.
- Aggregate them chronologically in mutual_action_plan and flag any that appear unaddressed in later descriptions.${hasAnyCategory ? '' : '\n\nNote: none of the source entries carry a standardized category. Treat all content as unclassified free-form notes and apply the Golden Rule as normal.'}`;
}

function buildMapJsonPrompt(opportunity, descriptionEntries) {
  const latest = descriptionEntries?.[0];
  const primaryDate = latest?.date || new Date().toISOString().slice(0, 10);
  const primaryText = latest?.content || latest?.text || '';
  const primaryCategory = latest?.category || '';
  const priorEntries = (descriptionEntries || []).slice(1, 5);
  const priorBlock = priorEntries.length > 0
    ? `\n\nPrior context (earlier meetings, for reference only):\n${priorEntries.map(e => {
        const cat = e.category ? ` [${e.category}]` : '';
        return `• ${e.date}${cat}: ${e.content || e.text || ''}`;
      }).join('\n')}`
    : '';

  const extras = [];
  if (opportunity?.dealName)       extras.push(`Deal name: ${opportunity.dealName}`);
  if (opportunity?.stage)          extras.push(`Stage: ${opportunity.stage}`);
  if (opportunity?.dealValue)      extras.push(`Deal value: ${opportunity.dealValue}`);
  if (opportunity?.expectedClose)  extras.push(`Expected close: ${opportunity.expectedClose}`);
  if (opportunity?.partner)        extras.push(`Partner: ${opportunity.partner}`);
  const extrasBlock = extras.length > 0 ? `\n\n${extras.join('\n')}` : '';

  const categoryHeader = primaryCategory
    ? `[CATEGORY: ${primaryCategory}] `
    : '';
  const guidanceBlock = buildCategoryGuidanceBlock(descriptionEntries || []);

  return `Generate a Mutual Action Plan for the opportunity below and return it as a single JSON object.

GOLDEN RULE — THE MOST IMPORTANT INSTRUCTION:

Every single field you return in the JSON must be traceable to a specific phrase or sentence in the source description below. This is non-negotiable.

You are NOT allowed to:
- Infer tool names that aren't in the source (e.g., don't add "Intune" just because the source mentions "Microsoft endpoint management")
- Fabricate user counts, license dates, or decision-maker titles that aren't in the source
- Generalize from "common enterprise patterns" — every customer is different
- Pad sections with likely-but-unverified content

You ARE expected to:
- Return EMPTY ARRAYS for sections the source doesn't support
- Return EMPTY STRINGS for sublines and free-text fields when the source doesn't provide the detail
- Err toward less content, not more. A shorter, accurate MAP is ALWAYS better than a longer fabricated one.

When uncertain: leave it out. If you can't point to a specific phrase in the source that supports a claim, don't include the claim. The renderer will silently skip any empty section — an empty array is a feature, not a failure.

---

Customer: ${opportunity?.name || opportunity?.customerName || ''}
Current description date: ${primaryDate}${extrasBlock}

${guidanceBlock}

Source content (most recent meeting / description):
---
${categoryHeader}${primaryText}
---${priorBlock}

Return ONLY a single valid JSON object. No prose. No markdown. No code fences. No explanation. The object must match this exact shape and field names:

${MAP_JSON_SCHEMA_EXAMPLE}

Field-level guidance (every one of these is subordinate to the Golden Rule above):
- Use the exact field names shown. Nested objects and array shapes must match.
- "customer_name": always populated (this is always known).
- "document_date": the current description date in "Month DD, YYYY" format.
- "meeting_recap": 4-7 {label, detail} entries if the source supports it. If the source is very thin, 1-3 entries is fine. Each "label" is a 2-5 word bolded title (e.g., "Pricing delivered", "Total Users"). Each "detail" is a single concise sentence with the specifics (numbers, names, dates, decisions). Skim-readable — not narrative paragraphs. At least 1 entry is required.
- "current_environment.infrastructure": return 0 entries if the source doesn't discuss architecture. Return 3-10 {name, subline} entries when grounded in source content. Do NOT pad. "name" is the tool/system name only; "subline" is a short factual context detail — empty string when no supporting detail exists in the source.
- "current_environment.current_state_pain": return 0 entries if the source doesn't discuss pain. Return 2-5 plain-string bullets when grounded. Do NOT infer pain from neutral language.
- "current_environment.stakeholders_and_decision_process": return 0 entries if the source doesn't name anyone. Return 3-6 plain-string bullets when grounded. Real names and roles only — no generic "VP-level leadership" placeholders.
- "end_users_personas": return an empty array unless the source explicitly describes end-user segments. When grounded, return {label, subline} objects naming those segments.
- "what_changes": return an empty string unless the source explicitly describes transformation outcomes for THIS customer. When grounded, return a single sentence that names the specific platforms, tools, or workflows being replaced — not a generic product pitch (e.g., "Citrix eliminated; AVD/Nerdio adoption without repackaging" not "Application Workspace streamlines delivery"). If the source doesn't describe specific outcomes, return an empty string.
- "proposed_delivery_targets": return [] if the source does not clearly name delivery platforms the customer is moving TOWARD. When grounded, return 1–4 {name, subline} entries representing the delivery platforms the customer is adopting.

  CONSTRAINED VOCABULARY — the "name" field MUST be one of these exact strings only:
  "AVD" | "AVD / Nerdio" | "Nerdio" | "Windows 365" | "Intune" | "SCCM / Intune" | "SCCM" | "Citrix" | "Jamf" | "Non-persistent VDI" | "Persistent VDI"

  GUARDRAILS (non-negotiable, subordinate to the Golden Rule above):
  (a) Only include a target if the source explicitly names it as a future direction or states intent to adopt it.
  (b) If a platform is being PHASED OUT (e.g., "exiting Citrix", "Citrix contract not renewing"), include it in current_environment.infrastructure but DO NOT include it in proposed_delivery_targets.
  (c) Do NOT include "Windows 365" unless the source explicitly says "Windows 365", "W365", or "Cloud PCs" as a target direction.
  (d) Do NOT infer a replacement: if the source says "exiting Citrix" without naming a replacement, return [].
  (e) Contradictory signals across entries: the more recent entry's signal wins — per the chronological weighting rule above.
  (f) When in doubt, return []. An empty array is correct and safe; the section will be skipped rather than fabricated.
  "subline" is a 2–5 word delivery-model descriptor (e.g., "Non-persistent VDI", "Cloud-managed endpoints", "macOS management") — empty string if the source doesn't provide it.
  For Windows 365: use name "Windows 365", subline "Cloud PCs".
- "mutual_action_plan": always populated (at least 3 entries) if the source contains ANY action items, dates, or next steps. If the source contains none, return an empty array. When populated, cover the natural lifecycle: Discovery → POC Setup → Validation → Business Case → Decision → Rollout. Each row's "status" must be one of: "Complete", "In Progress", "Pending", "Blocked", "Not Started". Dates in ISO format YYYY-MM-DD.

Return the JSON object and nothing else.`;
}

// Pull a JSON object out of the model's text response. Tolerant of
// markdown code fences and leading/trailing whitespace or prose, even
// though we explicitly told the model not to emit them.
function parseMapJsonResponse(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    const err = new Error('Claude returned an empty response.');
    err.code = 'MAP_JSON_EMPTY';
    throw err;
  }
  let body = rawText.trim();

  // Strip ```json ... ``` or ``` ... ``` fences if present
  const fenceMatch = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) body = fenceMatch[1].trim();

  // If there's prose around a JSON blob, grab from first { to last }
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first > 0 || last < body.length - 1) {
    if (first >= 0 && last > first) {
      body = body.slice(first, last + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    const err = new Error(`Claude returned invalid JSON: ${e.message}`);
    err.code = 'MAP_JSON_INVALID';
    err.rawText = rawText;
    throw err;
  }

  // Hard-fail schema validation — only the two truly universal facts
  // are required. Everything else is allowed to be empty under the
  // Golden Rule ("when in doubt, leave it out" — empty sections are
  // skipped silently by the renderer).
  //
  //   customer_name   → required, non-empty (this is always known)
  //   meeting_recap   → required, at least 1 entry (empty indicates a
  //                     generation failure, not a thin source)
  const missing = [];
  if (!parsed.customer_name || typeof parsed.customer_name !== 'string' || !parsed.customer_name.trim()) {
    missing.push('customer_name');
  }
  if (!Array.isArray(parsed.meeting_recap) || parsed.meeting_recap.length === 0) {
    missing.push('meeting_recap');
  }
  if (missing.length > 0) {
    const err = new Error(`Claude's JSON is missing required fields: ${missing.join(', ')}`);
    err.code = 'MAP_JSON_SCHEMA';
    err.rawText = rawText;
    throw err;
  }

  // Coerce optional fields to safe defaults so the renderer can rely
  // on shape without repeating guards. Missing-but-accepted is NOT a
  // fabrication — it's just "the source didn't support this section".
  if (typeof parsed.document_date !== 'string') parsed.document_date = '';
  if (!parsed.current_environment || typeof parsed.current_environment !== 'object') {
    parsed.current_environment = {};
  }
  if (!Array.isArray(parsed.mutual_action_plan)) parsed.mutual_action_plan = [];

  // Normalize meeting_recap to the {label, detail} shape. Back-compat:
  // if an entry is a flat string (old schema), promote it to
  // { label: '', detail: <string> } so the renderer can't crash.
  parsed.meeting_recap = parsed.meeting_recap.map(entry => {
    if (typeof entry === 'string') {
      return { label: '', detail: entry };
    }
    if (entry && typeof entry === 'object') {
      const label = typeof entry.label === 'string' ? entry.label : '';
      const detail = typeof entry.detail === 'string' ? entry.detail : '';
      return { label, detail };
    }
    return { label: '', detail: '' };
  }).filter(e => e.label || e.detail);

  // After normalization, meeting_recap still has to be non-empty —
  // otherwise the generation effectively failed.
  if (parsed.meeting_recap.length === 0) {
    const err = new Error(`Claude's JSON is missing required fields: meeting_recap`);
    err.code = 'MAP_JSON_SCHEMA';
    err.rawText = rawText;
    throw err;
  }

  // Normalize infrastructure similarly — {name, subline} shape, with
  // flat-string back-compat converting to { name: string, subline: '' }.
  const env = parsed.current_environment;
  env.infrastructure = Array.isArray(env.infrastructure)
    ? env.infrastructure.map(entry => {
        if (typeof entry === 'string') return { name: entry, subline: '' };
        if (entry && typeof entry === 'object') {
          const name = typeof entry.name === 'string' ? entry.name : '';
          const subline = typeof entry.subline === 'string' ? entry.subline : '';
          return { name, subline };
        }
        return { name: '', subline: '' };
      }).filter(e => e.name)
    : [];
  env.current_state_pain = Array.isArray(env.current_state_pain)
    ? env.current_state_pain.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  env.stakeholders_and_decision_process = Array.isArray(env.stakeholders_and_decision_process)
    ? env.stakeholders_and_decision_process.map(s => String(s || '').trim()).filter(Boolean)
    : [];

  // Page 3 architecture fields. All optional — if empty, the renderer
  // suppresses the corresponding visual element (or the whole page).
  parsed.end_users_personas = Array.isArray(parsed.end_users_personas)
    ? parsed.end_users_personas.map(entry => {
        if (typeof entry === 'string') return { label: entry, subline: '' };
        if (entry && typeof entry === 'object') {
          const label = typeof entry.label === 'string' ? entry.label : '';
          const subline = typeof entry.subline === 'string' ? entry.subline : '';
          return { label, subline };
        }
        return { label: '', subline: '' };
      }).filter(e => e.label)
    : [];
  parsed.what_changes = typeof parsed.what_changes === 'string'
    ? parsed.what_changes.trim()
    : '';

  parsed.proposed_delivery_targets = Array.isArray(parsed.proposed_delivery_targets)
    ? parsed.proposed_delivery_targets.map(entry => {
        if (typeof entry === 'string') return { name: entry, subline: '' };
        if (entry && typeof entry === 'object') {
          const name = typeof entry.name === 'string' ? entry.name : '';
          const subline = typeof entry.subline === 'string' ? entry.subline : '';
          return { name, subline };
        }
        return { name: '', subline: '' };
      }).filter(e => e.name)
    : [];

  parsed.mutual_action_plan = parsed.mutual_action_plan
    .filter(r => r && typeof r === 'object');

  // meta.sections_rendered — precomputed so the renderer doesn't
  // re-derive these predicates. NOT from Claude; it's a parser-side
  // summary of what the PDF will actually show under the Golden Rule.
  const hasInfra = env.infrastructure.length > 0;
  const hasPain = env.current_state_pain.length > 0;
  const hasStakeholders = env.stakeholders_and_decision_process.length > 0;
  const hasMapRows = parsed.mutual_action_plan.length > 0;
  const hasPersonas = parsed.end_users_personas.length > 0;
  const hasWhatChanges = parsed.what_changes.length > 0;
  const hasProposedTargets = parsed.proposed_delivery_targets.length > 0;
  parsed.meta = {
    ...(parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {}),
    sections_rendered: {
      recap: true,
      infrastructure: hasInfra,
      pain: hasPain,
      stakeholders: hasStakeholders,
      environment: hasInfra || hasPain || hasStakeholders,
      map_table: hasMapRows,
      architecture_page: (hasInfra || hasPain) && hasProposedTargets,
      personas: hasPersonas,
      what_changes: hasWhatChanges,
    },
  };

  return parsed;
}

/**
 * Ask Claude to produce a JSON representation of a Mutual Action Plan
 * for the given opportunity. Uses the standard Messages API (NOT
 * Skills, NOT Files API). CORS-safe: same auth and direct-browser flag
 * that callClaudeStream() uses.
 *
 * @param {object} opportunity      { name / customerName, dealName?, stage?, ... }
 * @param {Array}  descriptionEntries  Newest-first array of { date, content }
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} Parsed JSON matching the MAP schema.
 */
export async function requestMapPdfJson(opportunity, descriptionEntries, signal) {
  const apiKey = requireApiKey();
  const prompt = buildMapJsonPrompt(opportunity, descriptionEntries);

  const body = {
    model: MAP_JSON_MODEL,
    max_tokens: MAP_JSON_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildRequestHeaders(apiKey),
    body: JSON.stringify(body),
    signal: withTimeout(signal, MAP_JSON_TIMEOUT_MS),
  });

  if (!response.ok) {
    let errBody = {};
    try { errBody = await response.json(); } catch { /* ignore */ }
    const msg = errBody.error?.message || `API error: ${response.status}`;
    console.error('[MAP JSON] API error', { status: response.status, body: errBody });
    const err = new Error(msg);
    err.status = response.status;
    err.code = 'MAP_JSON_API_ERROR';
    throw err;
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
  return parseMapJsonResponse(text);
}

// ── Multi-description MAP flow (click-driven, V1.5) ────────────
//
// When the user picks 2+ descriptions via the Opportunity dialog's
// "Generate MAP" button, we need Claude to synthesize across all of
// them instead of treating the most-recent as the source and the rest
// as "prior context". A separate prompt builder keeps the voice flow
// byte-identical while letting the click flow spell out the synthesis
// contract — including temporal-conflict resolution (later entry wins).

function formatDateHeader(dateRaw) {
  const s = String(dateRaw || '').trim();
  if (!s) return 'Undated';
  const match = s.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : s;
}

function buildMapJsonPromptFromMultiple(opportunity, descriptionEntries) {
  const entries = (descriptionEntries || [])
    .map(e => ({
      date: e?.date || '',
      content: e?.content || e?.text || '',
      category: e?.category || '',
    }))
    .filter(e => e.content && String(e.content).trim().length > 0);

  // Keep the single-source path behaviourally identical to the voice
  // flow so the existing V1 prompt is reused verbatim when N=1.
  if (entries.length <= 1) {
    return buildMapJsonPrompt(opportunity, entries);
  }

  const extras = [];
  if (opportunity?.dealName)       extras.push(`Deal name: ${opportunity.dealName}`);
  if (opportunity?.stage)          extras.push(`Stage: ${opportunity.stage}`);
  if (opportunity?.dealValue)      extras.push(`Deal value: ${opportunity.dealValue}`);
  if (opportunity?.expectedClose)  extras.push(`Expected close: ${opportunity.expectedClose}`);
  if (opportunity?.partner)        extras.push(`Partner: ${opportunity.partner}`);
  const extrasBlock = extras.length > 0 ? `\n\n${extras.join('\n')}` : '';

  const customer = opportunity?.name || opportunity?.customerName || '';
  const todayISO = new Date().toISOString().slice(0, 10);
  const n = entries.length;

  // Newest-first so "later entries win" is visually obvious, but each
  // DATE marker still lets Claude resolve temporal conflicts on its own.
  const sorted = entries.slice().sort((a, b) => {
    const ad = Date.parse(a.date) || 0;
    const bd = Date.parse(b.date) || 0;
    return bd - ad;
  });

  const sourceBlocks = sorted.map(e => {
    const header = formatDateHeader(e.date);
    // Only emit the CATEGORY label for standardized entries — legacy entries
    // (no category) keep the original date-only header format so callers
    // that test for the bare "--- DATE: X ---" pattern continue to match.
    const categoryLabel = e.category ? ` | CATEGORY: ${e.category}` : '';
    return `--- DATE: ${header}${categoryLabel} ---\n${e.content.trim()}`;
  }).join('\n\n');

  const guidanceBlock = buildCategoryGuidanceBlock(entries);

  return `You are generating a Mutual Action Plan for ${customer}. The source material below consists of ${n} separate description entries from the opportunity history, each with its own date. Treat all of these entries as equally important source material. Your job is to synthesize and condense across ALL of them into one cohesive MAP — NOT just the most recent. If the entries contain conflicting information (e.g., an action item marked "pending" in an earlier entry that's "complete" in a later one), the more recent entry wins. Preserve the full spectrum of context: early-phase discovery notes, mid-phase decisions, and late-phase status updates all contribute to the final MAP.

GOLDEN RULE — THE MOST IMPORTANT INSTRUCTION:

Every single field you return in the JSON must be traceable to a specific phrase or sentence in the source description entries below. This is non-negotiable.

You are NOT allowed to:
- Infer tool names that aren't in any source entry (e.g., don't add "Intune" just because an entry mentions "Microsoft endpoint management")
- Fabricate user counts, license dates, or decision-maker titles that aren't in any source entry
- Generalize from "common enterprise patterns" — every customer is different
- Pad sections with likely-but-unverified content

You ARE expected to:
- Return EMPTY ARRAYS for sections none of the entries support
- Return EMPTY STRINGS for sublines and free-text fields when no entry provides the detail
- Err toward less content, not more. A shorter, accurate MAP is ALWAYS better than a longer fabricated one.

When uncertain: leave it out. If you can't point to a specific phrase in one of the source entries that supports a claim, don't include the claim. The renderer will silently skip any empty section — an empty array is a feature, not a failure.

---

Customer: ${customer}
Generation date: ${todayISO}
Source entry count: ${n}${extrasBlock}

${guidanceBlock}

Source content (${n} description entries, newest first — each prefixed with its date and category):
${sourceBlocks}

Return ONLY a single valid JSON object. No prose. No markdown. No code fences. No explanation. The object must match this exact shape and field names:

${MAP_JSON_SCHEMA_EXAMPLE}

Field-level guidance (every one of these is subordinate to the Golden Rule above):
- Use the exact field names shown. Nested objects and array shapes must match.
- "customer_name": always populated (this is always known).
- "document_date": today's date in "Month DD, YYYY" format.
- "meeting_recap": 4-7 {label, detail} entries if the entries support it. If the source is very thin, 1-3 entries is fine. Each "label" is a 2-5 word bolded title; each "detail" is a single concise sentence with specifics. At least 1 entry is required.
- "current_environment.infrastructure": return 0 entries if none of the entries discuss architecture. Return 3-10 {name, subline} entries when grounded. Do NOT pad. "subline" is empty string when no supporting detail exists.
- "current_environment.current_state_pain": return 0 entries if none of the entries discuss pain. Return 2-5 plain-string bullets when grounded. Do NOT infer pain from neutral language.
- "current_environment.stakeholders_and_decision_process": return 0 entries if no entry names anyone. Return 3-6 plain-string bullets when grounded. Real names and roles only — no generic placeholders.
- "end_users_personas": return an empty array unless an entry explicitly describes end-user segments. When grounded, return {label, subline} objects.
- "what_changes": return an empty string unless an entry explicitly describes transformation outcomes for THIS customer. When grounded, return a single sentence that names the specific platforms, tools, or workflows being replaced — not a generic product pitch (e.g., "Citrix eliminated; AVD/Nerdio adoption without repackaging" not "Application Workspace streamlines delivery"). If no entry describes specific outcomes, return an empty string.
- "proposed_delivery_targets": return [] if none of the entries clearly name delivery platforms the customer is moving TOWARD. When grounded, return 1–4 {name, subline} entries representing the delivery platforms the customer is adopting.

  CONSTRAINED VOCABULARY — the "name" field MUST be one of these exact strings only:
  "AVD" | "AVD / Nerdio" | "Nerdio" | "Windows 365" | "Intune" | "SCCM / Intune" | "SCCM" | "Citrix" | "Jamf" | "Non-persistent VDI" | "Persistent VDI"

  GUARDRAILS (non-negotiable, subordinate to the Golden Rule above):
  (a) Only include a target if an entry explicitly names it as a future direction or states intent to adopt it.
  (b) If a platform is being PHASED OUT (e.g., "exiting Citrix", "Citrix contract not renewing"), include it in current_environment.infrastructure but DO NOT include it in proposed_delivery_targets.
  (c) Do NOT include "Windows 365" unless an entry explicitly says "Windows 365", "W365", or "Cloud PCs" as a target direction.
  (d) Do NOT infer a replacement: if entries say "exiting Citrix" without naming a replacement, return [].
  (e) Contradictory signals across entries: the more recent entry's signal wins — per the chronological weighting rule above.
  (f) When in doubt, return []. An empty array is correct and safe; the section will be skipped rather than fabricated.
  "subline" is a 2–5 word delivery-model descriptor (e.g., "Non-persistent VDI", "Cloud-managed endpoints", "macOS management") — empty string if no entry provides it.
  For Windows 365: use name "Windows 365", subline "Cloud PCs".
- "mutual_action_plan": always populated (at least 3 entries) if any entry contains action items, dates, or next steps. If no entry contains any of those, return an empty array. When populated, cover the natural lifecycle: Discovery → POC Setup → Validation → Business Case → Decision → Rollout. Each row's "status" must be one of: "Complete", "In Progress", "Pending", "Blocked", "Not Started". Dates in ISO format YYYY-MM-DD. When entries disagree on a row's status or date, the most recent DATE-marked entry wins.

Return the JSON object and nothing else.`;
}

/**
 * Ask Claude to produce a JSON representation of a Mutual Action Plan
 * by synthesizing across MULTIPLE description entries. When N=1, this
 * behaves identically to requestMapPdfJson() (same prompt, same shape)
 * so callers don't need to branch. When N>=2, the prompt tells Claude
 * to treat every entry as equally-weighted source material and resolve
 * temporal conflicts in favour of the most recent DATE marker.
 *
 * @param {object} opportunity      { name / customerName, dealName?, stage?, ... }
 * @param {Array}  descriptionEntries  Array of { date, content } — order doesn't matter;
 *                                     the prompt builder normalizes newest-first.
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} Parsed JSON matching the MAP schema.
 */
export async function requestMapPdfJsonFromMultiple(opportunity, descriptionEntries, signal) {
  const apiKey = requireApiKey();
  const prompt = buildMapJsonPromptFromMultiple(opportunity, descriptionEntries);

  const body = {
    model: MAP_JSON_MODEL,
    max_tokens: MAP_JSON_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildRequestHeaders(apiKey),
    body: JSON.stringify(body),
    signal: withTimeout(signal, MAP_JSON_TIMEOUT_MS),
  });

  if (!response.ok) {
    let errBody = {};
    try { errBody = await response.json(); } catch { /* ignore */ }
    const msg = errBody.error?.message || `API error: ${response.status}`;
    console.error('[MAP PDF from selection] API error', { status: response.status, body: errBody });
    const err = new Error(msg);
    err.status = response.status;
    err.code = 'MAP_JSON_API_ERROR';
    throw err;
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
  return parseMapJsonResponse(text);
}

// Exported for unit testing — pure helpers don't need the real API.
export const __mapJsonInternals = {
  buildMapJsonPrompt,
  buildMapJsonPromptFromMultiple,
  buildCategoryGuidanceBlock,
  parseMapJsonResponse,
};

// ── Describe Intelligence V1 ───────────────────────────────────────
//
// Standardize button feature: classifies a free-form description as
// either "meeting_recap" or "opportunity_note" and reformats it into
// a consistent structure while preserving 100% of the original content.

const STANDARDIZE_MODEL = 'claude-opus-4-7';
const STANDARDIZE_MAX_TOKENS = 16000; // high enough for any realistic CRM description
const STANDARDIZE_TIMEOUT_MS = 300_000; // 5 min — streaming keeps connection alive for long inputs

function buildStandardizePrompt(rawText) {
  return `You are a careful editor for a CRM system. Your ONLY job is to take messy free-form sales opportunity descriptions and restructure them into a consistent format WHILE PRESERVING 100% OF THE ORIGINAL INFORMATION.

YOU ARE NOT A SUMMARIZER. YOU ARE NOT AN ABSTRACTER. YOU ARE A FORMATTER.

CLASSIFICATION RULES:
- Classify as "meeting_recap" ONLY if the description documents an actual meeting, call, or live conversation with the customer. Signals: attendee names, meeting date, discussion topics, decisions made during a real-time interaction.
- Classify as "opportunity_note" for EVERYTHING ELSE: quick updates, internal thoughts, status changes, email summaries, reminders, context, follow-up notes, research findings, next steps captured asynchronously.
- When in doubt, classify as "opportunity_note". Misclassifying a note as a meeting recap is worse than leaving a note unstructured.

═══════════════════════════════════════════════════════════════════
THE PRESERVATION RULE (THIS IS THE MOST IMPORTANT INSTRUCTION)
═══════════════════════════════════════════════════════════════════

Every fact, name, number, date, quote, commitment, concern, decision, question, action item, and subjective comment from the INPUT must appear in the OUTPUT.

Specific rules:
1. NO SUMMARIZATION. If the input has three facts, the output must have all three facts.
2. NO CONSOLIDATION. Do not merge similar points. Repetition is signal.
3. NO SHORTENING. If the output is materially shorter than the input, you have failed. The output should be approximately the same length or longer.
4. PRESERVE SPECIFIC WORDING for quotes, commitments, objections, pricing, dates, and names. Do not paraphrase "committed to $150k by end of Q2" into "agreed to a deal this quarter."
5. PRESERVE AMBIGUITY AND QUALIFIERS. If someone "seemed hesitant but might be open," preserve both the hesitation and the openness. Do not resolve.
6. PRESERVE THE USER'S VOICE in subjective commentary. Notes like "this guy is going to be a pain to work with" or "great vibes" are signals — keep them intact in a Notes section.
7. NEVER INVENT. If something is not in the input, do not add it. Leave fields blank or write "Not specified."

The only acceptable edits are:
- Fixing obvious typos
- Fixing obvious capitalization
- Expanding unambiguous abbreviations
- Adding structural headers and bullets AROUND the existing content
- Reordering content to fit the template structure

The following are NEVER acceptable:
- Paraphrasing
- Summarizing
- Removing content (even "off-topic" or "informal" content)
- Consolidating multiple bullets into one
- Inferring beyond what's stated
- Adding content to fill out structure
- Changing numbers, dates, or proper nouns

═══════════════════════════════════════════════════════════════════
STANDARDIZED FORMAT FOR meeting_recap:
═══════════════════════════════════════════════════════════════════

**Meeting Recap — [Date if mentioned, else "Date not specified"]**

**Attendees:** [exact names and organizations as mentioned, comma-separated. If not mentioned, write "Not specified"]

**Discussion Points:**
- [Every topic, decision, question, or statement from the input — preserve specific wording where it matters]
- [Include subjective observations the user noted]
- [Include customer quotes preserved verbatim where present]

**Action Items / Next Steps:**
- [Every action item mentioned, with owner if specified. Preserve deadlines exactly as stated.]
- [If no action items mentioned, write "None specified"]

**Notes:**
[Any subjective observations, personal reactions, or context the user included. Preserve their voice exactly.]

═══════════════════════════════════════════════════════════════════
STANDARDIZED FORMAT FOR opportunity_note:
═══════════════════════════════════════════════════════════════════

**[Date if mentioned, else today's date] — [Type: Internal Note, Email Follow-up, Status Update, Research, etc.]**

[The original content, reorganized into clear paragraphs or bullet points as appropriate. Fix typos and capitalization. Preserve all facts, names, numbers, dates, commitments, concerns, and subjective language. Do not summarize. Do not abstract.]

**Facts / Commitments:** [If the note contains specific facts, commitments, or data points, list them here as bullets with exact wording preserved.]

**Notes / Observations:** [If the user included subjective commentary, preserve it here in their voice.]

═══════════════════════════════════════════════════════════════════

Return your response using EXACTLY these XML tags — no preamble, no markdown, no text outside the tags:

<result>
<category>meeting_recap or opportunity_note</category>
<standardized_text>
[the reformatted text with all original information preserved]
</standardized_text>
<confidence>high or medium or low</confidence>
<preservation_check>[1-sentence self-assessment: did you preserve all information from the input? If you preserved everything, write "All input information preserved." If any was removed, explain what and why.]</preservation_check>
</result>

The preservation_check field is for auditing. Write "All input information preserved." if nothing was omitted.

Now process the input below. Remember: preservation > tidiness. When in doubt, keep more content rather than less.

INPUT:
${rawText}`;
}

/**
 * Ask Claude to classify and reformat a free-form description entry.
 * Preserves 100% of original content — see Preservation Rule in the prompt.
 *
 * @param {string} rawText  Plain text of the description (HTML stripped by caller)
 * @param {AbortSignal} [signal]
 * @returns {Promise<{category: string, standardizedText: string, confidence: string}>}
 */
export async function standardizeDescription(rawText, signal, onProgress) {
  if (!rawText || !rawText.trim()) {
    const err = new Error('Cannot standardize an empty description.');
    err.code = 'STANDARDIZE_EMPTY';
    throw err;
  }

  const apiKey = requireApiKey();
  const prompt = buildStandardizePrompt(rawText);

  const body = {
    model: STANDARDIZE_MODEL,
    max_tokens: STANDARDIZE_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildRequestHeaders(apiKey),
    body: JSON.stringify(body),
    signal: withTimeout(signal, STANDARDIZE_TIMEOUT_MS),
  });

  if (!response.ok) {
    let errBody = {};
    try { errBody = await response.json(); } catch { /* ignore */ }
    const msg = errBody.error?.message || `API error: ${response.status}`;
    console.error('[Standardize] API error', { status: response.status, body: errBody });
    const err = new Error(msg);
    err.status = response.status;
    err.code = 'STANDARDIZE_API_ERROR';
    throw err;
  }

  // Stream SSE so long inputs never hit an idle timeout — bytes flow continuously.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let fullText = '';
  let stopReason = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        let event;
        try { event = JSON.parse(raw); } catch { continue; }

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          fullText += event.delta.text;
          onProgress?.(fullText.length);
        }
        if (event.type === 'message_delta' && event.delta?.stop_reason) {
          stopReason = event.delta.stop_reason;
        }
        if (event.type === 'error') {
          const streamErr = new Error(event.error?.message || 'Stream error from Claude');
          streamErr.code = 'STANDARDIZE_API_ERROR';
          throw streamErr;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!fullText.trim()) {
    const err = new Error('Claude returned an empty response.');
    err.code = 'STANDARDIZE_EMPTY';
    throw err;
  }

  // If Claude hit the output token limit the XML will be truncated — surface a
  // clear, actionable error instead of a cryptic parse failure.
  if (stopReason === 'max_tokens') {
    const err = new Error('This description is too long to standardize in one pass. Please split it into smaller sections and standardize each part separately.');
    err.code = 'STANDARDIZE_TOO_LONG';
    err.rawText = fullText;
    throw err;
  }

  // Parse XML tag output — more robust than JSON for long content because the
  // text inside <standardized_text> needs no escaping and won't cause parse
  // failures if Claude adds extra whitespace or minor formatting variations.
  const extractXml = (tag) => {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = fullText.match(re);
    return m ? m[1].trim() : null;
  };

  const category = extractXml('category');
  const standardizedText = extractXml('standardized_text');
  const confidence = extractXml('confidence');
  const preservationCheck = extractXml('preservation_check');

  const validCategories = ['meeting_recap', 'opportunity_note'];
  if (!category || !validCategories.includes(category)) {
    const err = new Error(`Claude returned an unrecognized category: ${category}`);
    err.code = 'STANDARDIZE_SCHEMA';
    err.rawText = fullText;
    throw err;
  }
  if (!standardizedText) {
    const err = new Error('Claude returned an empty standardized_text field.');
    err.code = 'STANDARDIZE_SCHEMA';
    err.rawText = fullText;
    throw err;
  }

  console.log(`[Standardize preservation check] ${preservationCheck || '(no check provided)'}`);

  return {
    category,
    standardizedText,
    confidence: confidence || 'medium',
  };
}

/**
 * Write a standardized description back to the Opportunity_Descriptions sheet
 * via the Apps Script endpoint. Delegates entirely to fileApiRequest() so the
 * no-Content-Type CORS path is preserved.
 *
 * @param {string} opportunityId
 * @param {string} descriptionId
 * @param {string} category        "meeting_recap" | "opportunity_note"
 * @param {string} standardizedText
 * @returns {Promise<object>}
 */
export async function applyStandardizedDescription(opportunityId, descriptionId, category, standardizedText) {
  return fileApiRequest({
    action: 'updateDescription',
    opportunityId,
    descriptionId,
    category,
    standardizedText,
  });
}

// Exported for unit testing — pure helpers don't need the real API.
export const __standardizeInternals = {
  buildStandardizePrompt,
};
