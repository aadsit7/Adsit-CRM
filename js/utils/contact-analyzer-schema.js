// ============================================================
// Contact Analyzer schema — Account Intelligence Brief
// ============================================================
// The Contacts tab of the Analyzer produces an "Account Intelligence Brief"
// for ONE individual: an executive summary, a contact assessment, influence
// scores, a missing-stakeholder map, a likely org map, account risk, the
// recommended next move, and a three-column seller-focus list. The exact
// shape mirrors the reference brief the sales team already produces by hand.
//
// Unlike the Opportunity / Event / Partner analyzers — whose value is a
// literal, source-grounded scoring of fixed criteria — this brief is an
// INTERPRETIVE synthesis: its worth is the reasoned inference ("strong
// inference — not the economic buyer"). So this validator does NOT strip
// ungrounded prose. What it DOES guarantee is STRUCTURE: every section is
// present and correctly typed, scores are clamped to 0–10, enums are
// canonical, arrays and strings are bounded, and web-source URLs are
// sanitized — so the on-screen board and the PDF can render any response
// without crashing, and a reply cut off at the token limit is salvaged
// rather than discarded.
//
// No DOM, no network — fully testable under Node.
// ============================================================

// ── Canonical enums ─────────────────────────────────────────────────
export const COVERAGE_LEVELS = new Set(['green', 'yellow', 'red']);
export const RISK_LEVELS = new Set(['LOW', 'MODERATE', 'HIGH']);
export const ORG_NODE_STATUSES = new Set(['engaged', 'identified', 'introduced', 'missing']);
export const CLASSIFICATION_LEVELS = new Set(['verified', 'strong_inference', 'inference']);

// The six influence dimensions the brief scores (the reference set). The
// prompt asks for exactly these; the parser keeps whatever the model returns
// but this is the canonical order the UI falls back to.
export const INFLUENCE_DIMENSIONS = [
  'Technical influence',
  'Operational influence',
  'Commercial influence',
  'Budget authority',
  'Partner influence',
  'Executive visibility',
];

// ── Bounds (keep a response render- and PDF-safe) ───────────────────
const MAX_SHORT = 200;      // headline-ish fields
const MAX_LONG = 1200;      // paragraph fields
const MAX_LIST_ITEM = 600;  // one bullet
const MAX_LIST = 12;        // items per list
const MAX_SCORES = 8;       // influence rows
const MAX_STAKEHOLDERS = 8; // missing-stakeholder rows
const MAX_ORG_NODES = 30;   // org-map rows
const MAX_CLASSIFY = 8;     // why-this-classification rows
const MAX_SOURCES = 30;

// ── Small coercers ──────────────────────────────────────────────────
function str(v, cap = MAX_SHORT) {
  const s = typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
  if (!s) return '';
  return s.length > cap ? `${s.slice(0, cap).trimEnd()}…` : s;
}

const PLACEHOLDER_RE = /^(n\/?a|none|not (specified|provided|applicable|available|assessed)|unknown|tbd|-{1,2}|—)$/i;
function strOrEmpty(v, cap) {
  const s = str(v, cap);
  return PLACEHOLDER_RE.test(s) ? '' : s;
}

// A 0–10 integer score. Accepts 4, "4", "4/10", "4 / 10", 4.6 (rounds).
// Anything unparseable becomes null so the UI can show "—" rather than a
// misleading 0.
export function coerceScore(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return clampScore(v);
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  return clampScore(parseFloat(m[0]));
}
function clampScore(n) {
  const r = Math.round(n);
  if (r < 0) return 0;
  if (r > 10) return 10;
  return r;
}

function list(v, { cap = MAX_LIST, itemCap = MAX_LIST_ITEM } = {}) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = strOrEmpty(item, itemCap);
    if (s) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

// ── URL sanitize (web-source citations) ─────────────────────────────
export function sanitizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  try {
    const parsed = new URL(s);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch { /* not a URL */ }
  return '';
}

// ── Enum canonicalizers (map loose model language → canonical value) ─
// Word-boundary matches on purpose — a substring match would misfire on
// look-alikes ("thin" inside "anything", "active" inside "inactive").
export function canonCoverage(v) {
  const s = String(v || '').trim().toLowerCase();
  if (COVERAGE_LEVELS.has(s)) return s;
  if (/\b(green|strong|good|broad|healthy)\b/.test(s)) return 'green';
  if (/\b(red|weak|thin|poor|single|narrow|single-threaded)\b/.test(s)) return 'red';
  return 'yellow'; // the honest middle default
}

export function canonRisk(v) {
  const s = String(v || '').trim().toUpperCase();
  if (RISK_LEVELS.has(s)) return s;
  if (/\b(CRITICAL|SEVERE|HIGH)\b/.test(s)) return 'HIGH';
  if (/\b(LOW|MINIMAL|MINOR)\b/.test(s)) return 'LOW';
  return 'MODERATE';
}

export function canonOrgStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  if (ORG_NODE_STATUSES.has(s)) return s;
  if (/\b(engaged|active|working)\b/.test(s)) return 'engaged';
  if (/\bintroduc/.test(s)) return 'introduced';
  if (/\b(missing|gap|absent|not)\b/.test(s)) return 'missing';
  return 'identified';
}

export function canonClassification(v) {
  const s = String(v || '').trim().toLowerCase();
  if (CLASSIFICATION_LEVELS.has(s)) return s;
  if (/\b(verif|confirm|fact)/.test(s)) return 'verified';
  if (/\bstrong/.test(s)) return 'strong_inference';
  return 'inference';
}

// ── Schema example handed to the model (documents the contract) ─────
export const CONTACT_BRIEF_SCHEMA_EXAMPLE = `{
  "contact": { "name": "string", "title": "string", "company": "string" },
  "executive_summary": {
    "company": "string — company, incl. legal name if known",
    "contact": "string — 'Name — Title'",
    "primary_icp_bucket": "string — e.g. 'Revenue / GTM Owner (with strong secondary Business Decision-Maker influence)'",
    "coverage_status": { "level": "green | yellow | red", "note": "string — one line on who is / isn't engaged" },
    "account_maturity": "string — stage label + one line, e.g. 'Stage 6 — Strategic partnership design. Premier terms in negotiation'",
    "likely_is": "string — what this person likely IS (their real role in the deal)",
    "likely_is_not": "string — what this person likely IS NOT",
    "biggest_gap": "string — the single biggest coverage gap",
    "best_next_move": "string — the single best next move"
  },
  "contact_assessment": {
    "likely_responsibility": "string",
    "confidence": "string — how firmly this is established and why",
    "what_they_care_about": "string",
    "recast_focus": "string — the Recast motion to run with this person"
  },
  "influence_scores": [
    { "dimension": "Technical influence", "score": 4, "reason": "string" },
    { "dimension": "Operational influence", "score": 5, "reason": "string" },
    { "dimension": "Commercial influence", "score": 8, "reason": "string" },
    { "dimension": "Budget authority", "score": 5, "reason": "string" },
    { "dimension": "Partner influence", "score": 9, "reason": "string" },
    { "dimension": "Executive visibility", "score": 7, "reason": "string" }
  ],
  "why_this_classification": [
    { "level": "verified | strong_inference | inference", "text": "string — the claim + the evidence behind it" }
  ],
  "missing_stakeholders": [
    { "role": "string — 'Name — Title' or a role if unnamed", "icp_bucket": "string", "why_needed": "string", "recommended_conversation": "string" }
  ],
  "org_map": [
    { "name": "string — 'Name — Title'", "status": "engaged | identified | introduced | missing", "depth": 0 }
  ],
  "account_risk": { "overall": "LOW | MODERATE | HIGH", "factors": ["string"] },
  "recommended_next_move": {
    "immediate_objective": "string",
    "next_role_to_engage": "string",
    "next_meeting": "string",
    "suggested_ask": "string — a verbatim ask the seller can use"
  },
  "seller_focus": {
    "discuss_now": ["string"],
    "do_not_force_yet": ["string"],
    "evidence_to_obtain": ["string"]
  },
  "sources": [ { "label": "string", "url": "https://…" } ]
}`;

// ── JSON extraction + truncation salvage ────────────────────────────
// Pull the first balanced {…} object out of a reply that may be wrapped in
// prose or a ```json fence. If the reply was cut off at the token limit the
// object never closes — walk it and append the missing closers so the tail
// we did receive still parses (any field that didn't arrive is simply
// absent, and the canonicalizers below fill it).
export function extractJsonObject(raw) {
  let body = String(raw || '').trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('{');
  if (start === -1) return null;

  let inString = false;
  let escaped = false;
  const stack = [];
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) {
        // Clean close of the top-level object.
        try { return JSON.parse(body.slice(start, i + 1)); } catch { break; }
      }
    }
  }

  // No clean close — best-effort repair of a truncated tail.
  let tail = body.slice(start);
  if (inString) tail += '"';
  for (let i = stack.length - 1; i >= 0; i -= 1) tail += stack[i] === '{' ? '}' : ']';
  try { return JSON.parse(tail); } catch { /* fall through */ }

  // Last resort: drop a dangling trailing fragment after the final comma.
  const lastComma = tail.lastIndexOf(',');
  if (lastComma > 0) {
    let repaired = tail.slice(0, lastComma);
    for (let i = stack.length - 1; i >= 0; i -= 1) repaired += stack[i] === '{' ? '}' : ']';
    try { return JSON.parse(repaired); } catch { /* give up */ }
  }
  return null;
}

// ── Section validators ──────────────────────────────────────────────
function validExecSummary(v) {
  const o = v && typeof v === 'object' ? v : {};
  const cov = o.coverage_status && typeof o.coverage_status === 'object' ? o.coverage_status : {};
  return {
    company: str(o.company, MAX_SHORT),
    contact: str(o.contact, MAX_SHORT),
    primary_icp_bucket: str(o.primary_icp_bucket, MAX_SHORT),
    coverage_status: {
      level: canonCoverage(cov.level),
      note: str(cov.note, MAX_LONG),
    },
    account_maturity: str(o.account_maturity, MAX_LONG),
    likely_is: str(o.likely_is, MAX_LONG),
    likely_is_not: str(o.likely_is_not, MAX_LONG),
    biggest_gap: str(o.biggest_gap, MAX_LONG),
    best_next_move: str(o.best_next_move, MAX_LONG),
  };
}

function validAssessment(v) {
  const o = v && typeof v === 'object' ? v : {};
  return {
    likely_responsibility: str(o.likely_responsibility, MAX_LONG),
    confidence: str(o.confidence, MAX_LONG),
    what_they_care_about: str(o.what_they_care_about, MAX_LONG),
    recast_focus: str(o.recast_focus, MAX_LONG),
  };
}

function validScores(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    const dimension = str(row.dimension, MAX_SHORT);
    if (!dimension) continue;
    out.push({ dimension, score: coerceScore(row.score), reason: str(row.reason, MAX_LONG) });
    if (out.length >= MAX_SCORES) break;
  }
  return out;
}

function validClassification(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    const text = str(row.text, MAX_LONG);
    if (!text) continue;
    out.push({ level: canonClassification(row.level), text });
    if (out.length >= MAX_CLASSIFY) break;
  }
  return out;
}

function validStakeholders(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    const role = str(row.role, MAX_SHORT);
    if (!role) continue;
    out.push({
      role,
      icp_bucket: str(row.icp_bucket, MAX_SHORT),
      why_needed: str(row.why_needed, MAX_LONG),
      recommended_conversation: str(row.recommended_conversation, MAX_LONG),
    });
    if (out.length >= MAX_STAKEHOLDERS) break;
  }
  return out;
}

function validOrgMap(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    const name = str(row.name, MAX_SHORT);
    if (!name) continue;
    let depth = Number.parseInt(row.depth, 10);
    if (!Number.isFinite(depth) || depth < 0) depth = 0;
    if (depth > 6) depth = 6;
    out.push({ name, status: canonOrgStatus(row.status), depth });
    if (out.length >= MAX_ORG_NODES) break;
  }
  return out;
}

function validRisk(v) {
  const o = v && typeof v === 'object' ? v : {};
  return { overall: canonRisk(o.overall), factors: list(o.factors) };
}

function validNextMove(v) {
  const o = v && typeof v === 'object' ? v : {};
  return {
    immediate_objective: str(o.immediate_objective, MAX_LONG),
    next_role_to_engage: str(o.next_role_to_engage, MAX_SHORT),
    next_meeting: str(o.next_meeting, MAX_LONG),
    suggested_ask: str(o.suggested_ask, MAX_LONG),
  };
}

function validSellerFocus(v) {
  const o = v && typeof v === 'object' ? v : {};
  return {
    discuss_now: list(o.discuss_now),
    do_not_force_yet: list(o.do_not_force_yet),
    evidence_to_obtain: list(o.evidence_to_obtain),
  };
}

function validSources(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    const url = sanitizeUrl(row.url);
    const label = str(row.label, MAX_SHORT) || url;
    if (!label && !url) continue;
    const key = `${label}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, url });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/**
 * Parse and structurally validate the model's raw text into a brief.
 * Never throws on a shape problem — a missing or malformed section becomes
 * its empty form so the board and PDF always render. Throws only when the
 * reply is completely unusable (no JSON object at all).
 *
 * @param {string} rawText  The model's final text block.
 * @param {object} [ctx]
 * @param {object} [ctx.contact]   The selected contact (name/role/company/partner) — used to
 *   backfill the brief's own contact block if the model omitted it.
 * @param {boolean} [ctx.truncated] Caller saw stop_reason "max_tokens".
 * @returns {object} the validated brief (see CONTACT_BRIEF_SCHEMA_EXAMPLE)
 */
export function parseContactBriefResponse(rawText, { contact = {}, truncated = false } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    const err = new Error('The contact analysis returned an empty response.');
    err.code = 'CONTACT_BRIEF_EMPTY';
    throw err;
  }

  const parsed = extractJsonObject(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const hint = truncated ? ' (the reply was cut off at the output-token limit)' : '';
    const err = new Error(`Contact analysis JSON could not be parsed${hint}.`);
    err.code = 'CONTACT_BRIEF_INVALID';
    throw err;
  }

  const c = parsed.contact && typeof parsed.contact === 'object' ? parsed.contact : {};
  const contactBlock = {
    name: str(c.name, MAX_SHORT) || str(contact.name, MAX_SHORT),
    title: str(c.title, MAX_SHORT) || str(contact.role, MAX_SHORT),
    company: str(c.company, MAX_SHORT) || str(contact.company, MAX_SHORT) || str(contact.partner_name, MAX_SHORT),
  };

  return {
    version: 1,
    contact: contactBlock,
    executive_summary: validExecSummary(parsed.executive_summary),
    contact_assessment: validAssessment(parsed.contact_assessment),
    influence_scores: validScores(parsed.influence_scores),
    why_this_classification: validClassification(parsed.why_this_classification),
    missing_stakeholders: validStakeholders(parsed.missing_stakeholders),
    org_map: validOrgMap(parsed.org_map),
    account_risk: validRisk(parsed.account_risk),
    recommended_next_move: validNextMove(parsed.recommended_next_move),
    seller_focus: validSellerFocus(parsed.seller_focus),
    sources: validSources(parsed.sources),
    // "partial" means fields at the tail may be missing (reply was cut off).
    partial: !!truncated,
  };
}

// ── Board derivation (light — the brief is mostly render-ready) ──────
// A couple of derived conveniences the view and PDF both use, so they can
// never disagree: the average influence score (a headline number) and the
// count of engaged vs. total org nodes (a coverage read-out).
export function deriveContactBriefBoard(brief) {
  const b = brief || {};
  const scores = (b.influence_scores || []).map(s => s.score).filter(n => typeof n === 'number');
  const avgInfluence = scores.length
    ? Math.round((scores.reduce((a, n) => a + n, 0) / scores.length) * 10) / 10
    : null;

  const org = b.org_map || [];
  const engaged = org.filter(n => n.status === 'engaged').length;
  const missing = org.filter(n => n.status === 'missing').length;

  return {
    avgInfluence,
    orgTotal: org.length,
    orgEngaged: engaged,
    orgMissing: missing,
    stakeholderGaps: (b.missing_stakeholders || []).length,
  };
}
