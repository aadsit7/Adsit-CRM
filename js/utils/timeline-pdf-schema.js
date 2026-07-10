// ============================================================
// Timeline PDF JSON schema — shared between prompt builder and parser
// ============================================================

export const TIMELINE_SCHEMA_EXAMPLE = `{
  "title": "string — e.g. 'ANICO Opportunity Timeline'",
  "subtitle": "string — 4–8 word subtitle, e.g. 'Recast Application Workspace Evaluation'",
  "date_range": "string — e.g. 'January 2024 – April 2026'",
  "customer_name": "string — always the opportunity/customer name",
  "executive_summary": "string — 2–4 sentence narrative of the full opportunity arc",
  "key_facts": [
    { "label": "string — 2–4 word label", "value": "string — concise fact" }
  ],
  "phases": [
    {
      "phase_name": "string — e.g. 'Discovery', 'POC', 'Business Case', 'Decision'",
      "date_range": "string — e.g. 'Jan 2024 – Mar 2024'",
      "entries": [
        {
          "date": "string — e.g. 'January 15, 2024'",
          "title": "string — 3–8 word bold headline",
          "bullets": ["string"],
          "outcome": "string — green outcome line, empty string if none"
        }
      ]
    }
  ],
  "status_tracker": [
    {
      "item": "string",
      "status": "completed | in_progress | next | planned",
      "detail": "string — 1 sentence"
    }
  ],
  "stakeholders": [
    {
      "name": "string",
      "title": "string",
      "company": "string",
      "role": "string — e.g. 'Champion', 'Decision Maker', 'Technical Lead'"
    }
  ],
  "closing_summary": "string — 1–2 sentence italic closing, e.g. 'ANICO is well positioned for a Q3 decision.'"
}`;

// Parse and validate Claude's raw text response into a timeline JSON object.
export function parseTimelineJsonResponse(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    const err = new Error('Claude returned an empty timeline response.');
    err.code = 'TIMELINE_JSON_EMPTY';
    throw err;
  }

  let body = rawText.trim();

  // Strip markdown code fences if present
  const fenceMatch = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) body = fenceMatch[1].trim();

  // Extract JSON object if surrounded by prose
  const first = body.indexOf('{');
  const last  = body.lastIndexOf('}');
  if (first >= 0 && last > first) body = body.slice(first, last + 1);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    const err = new Error(`Timeline JSON parse failed: ${e.message}`);
    err.code = 'TIMELINE_JSON_INVALID';
    throw err;
  }

  if (!parsed || typeof parsed !== 'object') {
    const err = new Error('Timeline response is not a JSON object.');
    err.code = 'TIMELINE_JSON_SCHEMA';
    throw err;
  }

  // Normalize top-level strings
  parsed.title            = typeof parsed.title === 'string'            ? parsed.title.trim()            : '';
  parsed.subtitle         = typeof parsed.subtitle === 'string'         ? parsed.subtitle.trim()         : '';
  parsed.date_range       = typeof parsed.date_range === 'string'       ? parsed.date_range.trim()       : '';
  parsed.customer_name    = typeof parsed.customer_name === 'string'    ? parsed.customer_name.trim()    : '';
  parsed.executive_summary = typeof parsed.executive_summary === 'string' ? parsed.executive_summary.trim() : '';
  parsed.closing_summary  = typeof parsed.closing_summary === 'string'  ? parsed.closing_summary.trim()  : '';

  // key_facts
  parsed.key_facts = Array.isArray(parsed.key_facts)
    ? parsed.key_facts
        .map(f => ({
          label: typeof f?.label === 'string' ? f.label.trim() : '',
          value: typeof f?.value === 'string' ? f.value.trim() : '',
        }))
        .filter(f => f.label || f.value)
    : [];

  // phases
  parsed.phases = Array.isArray(parsed.phases)
    ? parsed.phases
        .filter(p => p && typeof p === 'object')
        .map(p => ({
          phase_name: typeof p.phase_name === 'string' ? p.phase_name.trim() : '',
          date_range: typeof p.date_range === 'string' ? p.date_range.trim() : '',
          entries: Array.isArray(p.entries)
            ? p.entries
                .filter(e => e && typeof e === 'object')
                .map(e => ({
                  date:    typeof e.date    === 'string' ? e.date.trim()    : '',
                  title:   typeof e.title   === 'string' ? e.title.trim()   : '',
                  bullets: Array.isArray(e.bullets)
                    ? e.bullets.map(b => String(b || '').trim()).filter(Boolean)
                    : [],
                  outcome: typeof e.outcome === 'string' ? e.outcome.trim() : '',
                }))
            : [],
        }))
        .filter(p => p.phase_name || p.entries.length > 0)
    : [];

  // status_tracker
  const VALID_STATUSES = new Set(['completed', 'in_progress', 'next', 'planned']);
  parsed.status_tracker = Array.isArray(parsed.status_tracker)
    ? parsed.status_tracker
        .filter(s => s && typeof s === 'object')
        .map(s => ({
          item:   typeof s.item   === 'string' ? s.item.trim()   : '',
          status: VALID_STATUSES.has(String(s.status || '').toLowerCase())
            ? String(s.status).toLowerCase()
            : 'planned',
          detail: typeof s.detail === 'string' ? s.detail.trim() : '',
        }))
        .filter(s => s.item)
    : [];

  // stakeholders
  parsed.stakeholders = Array.isArray(parsed.stakeholders)
    ? parsed.stakeholders
        .filter(s => s && typeof s === 'object')
        .map(s => ({
          name:    typeof s.name    === 'string' ? s.name.trim()    : '',
          title:   typeof s.title   === 'string' ? s.title.trim()   : '',
          company: typeof s.company === 'string' ? s.company.trim() : '',
          role:    typeof s.role    === 'string' ? s.role.trim()    : '',
        }))
        .filter(s => s.name)
    : [];

  return parsed;
}
