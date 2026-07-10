// ============================================================
// Timeline PDF prompt builder
// ============================================================

import { TIMELINE_SCHEMA_EXAMPLE } from './timeline-pdf-schema.js';

export function buildTimelinePrompt(opportunity, descriptionEntries) {
  const customer = String(
    opportunity?.name || opportunity?.customerName || opportunity?.customer_name || ''
  ).trim() || 'the customer';

  const today = new Date().toISOString().slice(0, 10);

  const entries = (descriptionEntries || [])
    .map(e => ({
      date:    String(e?.date    || e?.description_date || '').trim(),
      content: String(e?.content || e?.text             || '').trim(),
    }))
    .filter(e => e.content.length > 0)
    .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0)); // oldest first

  const sourceBlocks = entries.map(e => {
    const header = e.date || 'Undated';
    return `--- DATE: ${header} ---\n${e.content}`;
  }).join('\n\n');

  return `You are generating a deal timeline document for ${customer}. The source material below consists of opportunity description entries in chronological order. Synthesize them into a structured timeline JSON that traces the full arc of the opportunity from first contact to current state.

GOLDEN RULE — THE MOST IMPORTANT INSTRUCTION:

Every field you return must be traceable to a specific phrase or sentence in the source entries below. You are NOT allowed to:
- Invent names, dates, tools, or decisions not mentioned in the source
- Generalize from common enterprise patterns
- Pad sections with likely-but-unverified content

You ARE expected to:
- Return EMPTY ARRAYS for sections the source doesn't support
- Return EMPTY STRINGS for optional fields with no source evidence
- Err toward less content, not more

---

Customer: ${customer}
Generation date: ${today}
Source entry count: ${entries.length}

Source entries (oldest first):
${sourceBlocks}

Return ONLY a single valid JSON object. No prose. No markdown. No code fences. The object must match this exact shape:

${TIMELINE_SCHEMA_EXAMPLE}

Field-level guidance (subordinate to the Golden Rule):
- "title": always "${customer} Opportunity Timeline" or similar.
- "subtitle": 4–8 words describing the type of engagement, e.g. "Recast Application Workspace Evaluation".
- "date_range": the full span from earliest to latest date mentioned in the sources, e.g. "January 2024 – April 2026". Use approximate ranges if exact dates are sparse.
- "executive_summary": 2–4 sentences describing the opportunity arc from first contact to current state. Only use facts from the source.
- "key_facts": 3–6 {label, value} rows for quick-glance facts (e.g. "Stage", "Partner", "Deal Value", "Primary Contact"). Return [] if the source has too few facts.
- "phases": Group entries into natural phases (Discovery, POC Setup, POC Validation, Business Case, Decision, etc.). Each phase must have at least 1 entry. Each entry needs a "date", "title" (bold headline), 1–5 "bullets" drawn from that source entry, and an "outcome" if the entry describes a concrete result or decision. Return [] if the source lacks enough structure to form phases.
- "status_tracker": 3–8 rows representing the current deal checklist. Status must be one of: "completed", "in_progress", "next", "planned". Only include items with source support.
- "stakeholders": name every person mentioned by name in any entry. Infer role ("Champion", "Decision Maker", "Technical Lead", "Economic Buyer", "Contact") from context. Leave "title" and "company" empty strings if not mentioned.
- "closing_summary": 1–2 italic-ready sentences stating the current position and single most important next step. Empty string if unclear.

Return the JSON object and nothing else.`;
}
