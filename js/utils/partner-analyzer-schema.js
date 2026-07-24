// ============================================================
// Partner analysis JSON schema — shared between prompt builder and parser
// ============================================================
// Parallels event-analyzer-schema.js: one example string shown to the model,
// plus a STRICT parser that strips fences, extracts the JSON, validates every
// field, drops anything malformed, and coerces bad values to safe defaults.
// The parser — NOT the model — enforces correctness.
//
// The Partner framework has two families of evidence source, validated
// differently:
//   • NARRATIVE  (transcript, meeting_index, partner_document,
//     opportunity_description, event_description) — held to the full GOLDEN
//     RULE bar: a met/partial needs a non-empty quote AND a real anchor (a
//     source id or date that matches a supplied source) AND the quote must
//     overlap the cited source's prose (grounding). A fabricated quote — even
//     one pinned to a real source — is downgraded to no_evidence.
//   • STRUCTURED (partner_profile, opportunity, event, event_contacts,
//     saved_event_playbook) — DETERMINISTIC facts. The model is never trusted
//     to interpret a count: a structured claim survives only if a supplied
//     fact supports it, and hard facts (a real won opportunity, active
//     pipeline, linked opps, a scheduled event) are OVERLAID after parsing so
//     they are always reflected regardless of what the model said.
//
// Stage status, the operational + furthest-demonstrated stages and the
// completion percentage are ALWAYS recomputed from the validated criteria —
// the model can never self-award its stage, its CRM metrics, its health label,
// its tier or its status.
// ============================================================

import {
  PARTNER_STAGES,
  CRITERION_IDS,
  CRITERION_TO_STAGE,
  getPartnerStageById,
  stageStatusFromCriteria,
} from './partner-analyzer-stages.js';
// The org-chart node statuses are SHARED with the Contact Analyzer's likely
// org map (a leaf module — no import cycle), so both analyzers speak one
// canonical engagement vocabulary and the tested canonicalizer is reused.
import { ORG_NODE_STATUSES, canonOrgStatus } from './contact-analyzer-schema.js';

// Re-exported so the Partner view / PDF / tests never need to know where the
// canonical org-status set lives.
export { ORG_NODE_STATUSES, canonOrgStatus };

export const PARTNER_ANALYZER_SCHEMA_EXAMPLE = `{
  "partner_id": "string — echo back the ID given",
  "partner_name": "string",
  "operational_stage_id": "string — the first stage NOT complete (the app recomputes this; you may estimate)",
  "furthest_demonstrated_stage_id": "string — the furthest stage with at least one met criterion (the app recomputes this)",
  "confidence": "high | medium | low",
  "summary": "string — 2-3 sentences on where this partnership actually stands",
  "stages": [
    {
      "stage_id": "string — must exactly match a stage id from the definitions",
      "status": "complete | in_progress | not_started",
      "notes": "string — 1-3 sentences on this stage. Empty string if no evidence.",
      "criteria": [
        {
          "criterion_id": "string — must exactly match a criterion id from the definitions",
          "status": "met | partial | not_met | no_evidence",
          "evidence": "string — a short quote or close paraphrase from ONE supplied source. Empty string if no_evidence or a structured fact.",
          "source_type": "partner_profile | transcript | meeting_index | partner_document | opportunity | opportunity_description | event | event_description | event_contacts | partner_contact | saved_event_playbook | none",
          "source_id": "string — the id of the cited source (transcript_id / meeting_id / document_id / description_id / opportunity_id / event_id / contact_id / partner_id). Empty string if none.",
          "source_date": "string — the date of the cited source. Empty string if none.",
          "related_entity_id": "string — the opportunity_id or event_id a link should open, or the partner_id. Empty string if none."
        }
      ]
    }
  ],
  "next_actions": ["string — the most useful next best actions"],
  "gaps": ["string — maturity gaps blocking the current stage"],
  "open_questions": ["string — questions the evidence leaves unanswered"],
  "risks": ["string — relationship risks"],
  "momentum": ["string — positive momentum"],
  "org_map": [
    { "name": "string — 'Name — Title' for a person named in the roster or evidence, or 'Role (not yet identified)' for a structural gap", "status": "engaged | identified | introduced | missing", "depth": 0, "contact_id": "string — the saved contact_id when this node is a saved partner contact, else empty string", "line_confidence": "explicit | observed | inferred | scaffold — how the reporting line to the manager above was earned (empty for a depth-0 root)", "line_basis": "string — one short phrase saying what earned that rung, with the source date when known. Empty for a root or when nothing supports the line." }
  ]
}`;

const VALID_STAGE_STATUSES = new Set(['complete', 'in_progress', 'not_started']);
const VALID_CRITERION_STATUSES = new Set(['met', 'partial', 'not_met', 'no_evidence']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

export const VALID_SOURCE_TYPES = new Set([
  'partner_profile', 'transcript', 'meeting_index', 'partner_document',
  'opportunity', 'opportunity_description', 'event', 'event_description',
  'event_contacts', 'partner_contact', 'saved_event_playbook', 'none',
]);

// Narrative sources are held to the grounding bar; structured sources need a
// supplied deterministic/structured fact to stand. `partner_contact` (a saved
// Partner_Contacts row) is STRUCTURED: a claim resting on the saved roster
// stands only when the roster was actually supplied and non-empty.
const NARRATIVE_SOURCE_TYPES = new Set([
  'transcript', 'meeting_index', 'partner_document', 'opportunity_description', 'event_description',
]);
const STRUCTURED_SOURCE_TYPES = new Set([
  'partner_profile', 'opportunity', 'event', 'event_contacts', 'partner_contact', 'saved_event_playbook',
]);

// Statuses that assert a criterion is (at least partly) satisfied and so must
// be backed by a real, validated source.
const CLAIMED_STATUSES = new Set(['met', 'partial']);

// ── Evidence grounding (narrative guard) ────────────────────────────
const EVIDENCE_GROUNDING_MIN_OVERLAP = 0.5;
const GROUNDING_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'been', 'being', 'has', 'have',
  'had', 'its', 'this', 'that', 'these', 'those', 'they', 'them', 'their',
  'with', 'from', 'will', 'would', 'can', 'could', 'should', 'may', 'might',
  'not', 'but', 'our', 'your', 'his', 'her', 'she', 'him', 'who', 'whom',
  'which', 'what', 'when', 'where', 'into', 'onto', 'per', 'via', 'about',
]);

function groundingTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !GROUNDING_STOPWORDS.has(w));
}

function isEvidenceGrounded(evidence, sourceText) {
  const evWords = [...new Set(groundingTokens(evidence))];
  if (evWords.length === 0) return true;
  const noteSet = new Set(groundingTokens(sourceText));
  if (noteSet.size === 0) return true;
  let hits = 0;
  for (const w of evWords) if (noteSet.has(w)) hits += 1;
  return (hits / evWords.length) >= EVIDENCE_GROUNDING_MIN_OVERLAP;
}

function resolveAnchorText(sourceId, sourceDate, anchors) {
  if (!anchors) return null;
  if (sourceId && anchors.textById && anchors.textById.has(sourceId)) return anchors.textById.get(sourceId);
  if (sourceDate && anchors.textByDate && anchors.textByDate.has(sourceDate)) return anchors.textByDate.get(sourceDate);
  return null;
}

// ── Small coercers ──────────────────────────────────────────────────
function cleanStr(v) { return typeof v === 'string' ? v.trim() : ''; }
function cleanStrArray(v) {
  return Array.isArray(v) ? v.map(x => String(x == null ? '' : x).trim()).filter(Boolean) : [];
}
function toSet(v) {
  if (v instanceof Set) return v;
  return Array.isArray(v) ? new Set(v.map(String)) : null;
}
function toMap(v) {
  if (v instanceof Map) return v;
  if (v && typeof v === 'object') return new Map(Object.entries(v).map(([k, val]) => [String(k), String(val)]));
  return null;
}

function emptyCriterion(criterionId) {
  return {
    criterion_id: criterionId,
    status: 'no_evidence',
    evidence: '',
    source_type: 'none',
    source_id: '',
    source_date: '',
    related_entity_id: '',
  };
}

// ── Likely org chart (org_map) validation ───────────────────────────
// TRUTH OVER COMPLETENESS: a verified partial chart beats a plausible
// complete one. The org chart is an INTERPRETIVE section (like the Contact
// Analyzer's likely org map) — its value is the reasoned inference, so prose
// is not grounded word-for-word. What IS enforced, deterministically:
//
//   • IDENTITY — a node's contact_id survives only when it names a REAL
//     supplied Partner_Contacts row, so a fabricated contact_id can never
//     masquerade as a saved CRM record. Beyond that, every node that claims
//     to be a PERSON (any status except a "missing" gap) must be traceable
//     to the saved roster (by id or name) or literally named in the supplied
//     evidence text. The parser holds the SAME bounded texts the model was
//     shown, so anything else — including the model's outside knowledge of
//     who publicly runs this company — is a fabrication and is REMOVED
//     (counted in org_map_meta.removed_unverified, surfaced by the UI).
//   • PERSON vs LINE — scored separately. "status" rates the person
//     relationship; "line_confidence" rates ONLY the reporting line to the
//     manager above, on the explicit→observed→inferred→scaffold ladder. A
//     saved roster row stores no reporting information, so a roster-only
//     person can never carry an "explicit"/"observed" line — it clamps to
//     "inferred". A "missing" gap's line is always "scaffold".
//   • CORROBORATION — computed here, never claimed by the model: a person is
//     "corroborated" only when found in BOTH the saved roster (structured
//     CRM) and the narrative evidence (primary interaction) — two different
//     source types, not the same source repeated.
//   • RECENCY — last_seen_date is the newest supplied-source date whose text
//     names the person, computed from the anchors (org charts go stale; the
//     reader must see how fresh each sighting is).
//   • GAPS ARE DATA — a "missing" node (or a "(not yet identified)"-style
//     name) is a scaffold gap, kept and rendered as a question rather than an
//     answer. A valid saved contact_id contradicts "missing", and the primary
//     CRM record wins — the node becomes an identified person.
//   • Plus the structural floor: canonical statuses, clamped depth, bounded
//     size, one box per person (duplicate ids/names are dropped), and an
//     unlinked node whose name exactly matches exactly one saved contact is
//     auto-linked to that record.
//
// The org chart never influences criterion scoring.
const MAX_ORG_NODES = 30;
const MAX_ORG_NAME = 200;
const MAX_ORG_DEPTH = 6;
const MAX_ORG_LINE_BASIS = 240;

// Reporting-line confidence ladder — the rung used IS the line's confidence.
export const ORG_LINE_CONFIDENCE = new Set(['explicit', 'observed', 'inferred', 'scaffold']);

export function canonOrgLineConfidence(v) {
  const s = String(v || '').trim().toLowerCase();
  if (ORG_LINE_CONFIDENCE.has(s)) return s;
  if (/\b(explicit|stated|direct|confirmed)\b/.test(s)) return 'explicit';
  if (/\b(observed|deference|defer|cc|copied|sign-?off|approval)\b/.test(s)) return 'observed';
  if (/\b(scaffold|analog|analogous|shape|pattern|typical|assumed|guess)\b/.test(s)) return 'scaffold';
  return 'inferred'; // the honest middle default — title seniority + department
}

// A name that is really an unnamed role slot ("CTO (not yet identified)").
const GAP_NAME_MARKER = /\((?:not\s+(?:yet\s+)?identified|unidentified|unknown|vacant|open\s+role|gap|tbd|to\s+be\s+(?:identified|hired|named))\)/i;

// "Jane Doe — VP Alliances" → "Jane Doe". Accepts an em/en dash or a spaced
// hyphen; a plain name passes through unchanged.
function personNamePart(name) {
  const s = String(name || '').trim();
  for (const sep of [' — ', ' – ', ' - ']) {
    const at = s.indexOf(sep);
    if (at > 0) return s.slice(0, at).trim();
  }
  return s;
}

// Diacritic-insensitive word tokens for name matching ("Zoë" matches "Zoe",
// "Khan, Amir" matches "Amir Khan"). Single-letter initials are ignored
// unless the whole name is initials.
function nameMatchTokens(s) {
  const words = String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter(w => w.length >= 2);
  return meaningful.length ? meaningful : words;
}

function allTokensIn(tokens, set) {
  return tokens.length > 0 && tokens.every(t => set.has(t));
}

// Tokenize every supplied evidence text (and the roster names) ONCE per
// parse, so verifying up to 30 nodes stays cheap.
function buildOrgVerification(anchors) {
  const dated = [];
  if (anchors.textByDate) {
    for (const [date, text] of anchors.textByDate) {
      dated.push({ date: String(date).slice(0, 10), tokens: new Set(nameMatchTokens(text)) });
    }
  }
  const undated = [];
  if (anchors.textById) {
    for (const text of anchors.textById.values()) undated.push(new Set(nameMatchTokens(text)));
  }
  const roster = [];
  if (anchors.contactNamesById) {
    for (const [id, nm] of anchors.contactNamesById) {
      const tokens = new Set(nameMatchTokens(nm));
      if (tokens.size) roster.push({ id: String(id), tokens });
    }
  }
  return { dated, undated, roster };
}

// Was this person literally named in the supplied evidence — and if so, when
// was the newest sighting? (ISO dates compare correctly as strings.)
function evidenceSighting(tokens, ver) {
  let found = false;
  let lastSeen = '';
  for (const d of ver.dated) {
    if (allTokensIn(tokens, d.tokens)) {
      found = true;
      if (d.date > lastSeen) lastSeen = d.date;
    }
  }
  if (!found) {
    for (const set of ver.undated) {
      if (allTokensIn(tokens, set)) { found = true; break; }
    }
  }
  return { found, lastSeen };
}

// Does the node's name point at a saved roster row? An exact token match
// (both directions) identifies THE row, so an unlinked node can be
// auto-linked when exactly one saved contact matches.
function rosterNameMatch(tokens, tokenSet, ver) {
  let matched = false;
  const exactIds = [];
  for (const r of ver.roster) {
    const nodeInRoster = allTokensIn(tokens, r.tokens);
    const rosterInNode = r.tokens.size > 0 && [...r.tokens].every(t => tokenSet.has(t));
    if (nodeInRoster || rosterInNode) matched = true;
    if (nodeInRoster && rosterInNode) exactIds.push(r.id);
  }
  return { matched, exactIds };
}

function validPartnerOrgMap(v, anchors) {
  const meta = { removed_unverified: 0, deduped: 0, auto_linked: 0 };
  if (!Array.isArray(v)) return { nodes: [], meta };
  const ids = anchors.contactIds instanceof Set ? anchors.contactIds : new Set();
  const ver = buildOrgVerification(anchors);
  const seenContactIds = new Set();
  const seenNameKeys = new Set();
  const out = [];

  for (const row of v) {
    if (out.length >= MAX_ORG_NODES) break;
    if (!row || typeof row !== 'object') continue;
    let name = cleanStr(row.name);
    if (!name) continue;
    if (name.length > MAX_ORG_NAME) name = `${name.slice(0, MAX_ORG_NAME).trimEnd()}…`;
    let depth = Number.parseInt(row.depth, 10);
    if (!Number.isFinite(depth) || depth < 0) depth = 0;
    if (depth > MAX_ORG_DEPTH) depth = MAX_ORG_DEPTH;

    let status = canonOrgStatus(row.status);
    let contactId = cleanStr(row.contact_id);
    if (!ids.has(contactId)) contactId = '';

    const tokens = nameMatchTokens(personNamePart(name));
    const tokenSet = new Set(tokens);

    // Gap detection — a saved contact_id is a primary CRM record and beats a
    // gap claim, so a linked node can never be a gap.
    let isGap = (status === 'missing' || GAP_NAME_MARKER.test(name)) && !contactId;
    if (isGap) status = 'missing';
    else if (status === 'missing') status = 'identified';

    // Person verification + provenance (all app-computed).
    let personSource = 'gap';
    let corroborated = false;
    let lastSeen = '';
    if (!isGap) {
      const sighting = evidenceSighting(tokens, ver);
      const roster = rosterNameMatch(tokens, tokenSet, ver);
      const inRoster = !!contactId || roster.matched;
      if (!inRoster && !sighting.found) { meta.removed_unverified += 1; continue; }
      if (!contactId && roster.exactIds.length === 1 && !seenContactIds.has(roster.exactIds[0])) {
        contactId = roster.exactIds[0];
        meta.auto_linked += 1;
      }
      personSource = (inRoster && sighting.found) ? 'both' : (inRoster ? 'roster' : 'evidence');
      corroborated = personSource === 'both';
      lastSeen = sighting.lastSeen;
    }

    // One person, one box — a duplicate id or name never renders twice.
    const nameKey = tokens.slice().sort().join(' ');
    if ((contactId && seenContactIds.has(contactId)) || (nameKey && seenNameKeys.has(nameKey))) {
      meta.deduped += 1;
      continue;
    }
    if (contactId) seenContactIds.add(contactId);
    if (nameKey) seenNameKeys.add(nameKey);

    // The reporting line is scored SEPARATELY from the person.
    let lineConfidence = '';
    let lineBasis = cleanStr(row.line_basis);
    if (lineBasis.length > MAX_ORG_LINE_BASIS) lineBasis = `${lineBasis.slice(0, MAX_ORG_LINE_BASIS).trimEnd()}…`;
    if (depth > 0) {
      lineConfidence = isGap ? 'scaffold' : canonOrgLineConfidence(row.line_confidence);
      // The roster stores names + roles only — no reporting information — so a
      // person never seen in the evidence cannot carry an evidence-grade line.
      if (!isGap && personSource === 'roster' && (lineConfidence === 'explicit' || lineConfidence === 'observed')) {
        lineConfidence = 'inferred';
      }
    } else {
      lineBasis = ''; // a root has no line to justify
    }

    out.push({
      name,
      status,
      depth,
      contact_id: contactId,
      line_confidence: lineConfidence,
      line_basis: lineBasis,
      person_source: personSource,
      corroborated,
      last_seen_date: lastSeen,
    });
  }
  return { nodes: out, meta };
}

// Normalize whatever anchor shape the caller passes into one object.
function normalizeAnchors(options) {
  const a = options.anchors || options;
  return {
    narrativeIds: toSet(a.narrativeIds) || toSet(options.validSourceIds),
    narrativeDates: toSet(a.narrativeDates) || toSet(options.validSourceDates),
    textById: toMap(a.textById) || toMap(options.sourceTextById),
    textByDate: toMap(a.textByDate) || toMap(options.sourceTextByDate),
    structuredIds: toSet(a.structuredIds) || new Set(),
    relatedById: toMap(a.relatedById) || new Map(),
    partnerId: cleanStr(a.partnerId) || cleanStr(options.partnerId),
    // Saved Partner_Contacts ids — the only ids an org-chart node may carry.
    contactIds: toSet(a.contactIds) || new Set(),
    // contact_id → saved contact name; lets the org-chart validator recognize
    // (and auto-link) a roster person the model named without the id.
    contactNamesById: toMap(a.contactNamesById) || new Map(),
  };
}

/**
 * Parse and validate Claude's raw text into a normalized partner-analysis
 * object (canonical 7×3 board).
 *
 * @param {string} rawText  The model's message text.
 * @param {object} [options]
 * @param {string} [options.partnerId]    Echoed into partner_id when omitted.
 * @param {string} [options.partnerName]  Echoed into partner_name when omitted.
 * @param {object} [options.anchors]      collectPartnerAnchors() result.
 * @param {object} [options.facts]        { deterministic, structuredSupport }.
 * @returns {object} normalized partner-analysis JSON.
 */
export function parsePartnerAnalysisResponse(rawText, options = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    const err = new Error('Claude returned an empty partner-analysis response.');
    err.code = 'PARTNER_JSON_EMPTY';
    throw err;
  }

  let body = rawText.trim();
  const fenceMatch = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) body = fenceMatch[1].trim();
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) body = body.slice(first, last + 1);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    const err = new Error(`Partner-analysis JSON parse failed: ${e.message}`);
    err.code = 'PARTNER_JSON_INVALID';
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('Partner-analysis response is not a JSON object.');
    err.code = 'PARTNER_JSON_SCHEMA';
    throw err;
  }

  const anchors = normalizeAnchors(options);
  const facts = options.facts || {};
  const deterministic = (facts.deterministic && typeof facts.deterministic === 'object') ? facts.deterministic : {};
  const structuredSupport = (facts.structuredSupport && typeof facts.structuredSupport === 'object') ? facts.structuredSupport : {};

  // ── Validate model criteria into a working map ─────────────────────
  // criterionId → validated result. Unknown ids, wrong-stage placements and
  // duplicates never enter the map (first valid claim wins).
  const validated = new Map();
  const seenStages = new Set();
  const stageNotes = new Map();

  if (Array.isArray(parsed.stages)) {
    for (const rawStage of parsed.stages) {
      if (!rawStage || typeof rawStage !== 'object') continue;
      const stageId = cleanStr(rawStage.stage_id);
      if (!getPartnerStageById(stageId)) continue;   // drop unknown stages
      if (seenStages.has(stageId)) continue;          // dedupe stages (first wins)
      seenStages.add(stageId);
      stageNotes.set(stageId, cleanStr(rawStage.notes));

      const crits = Array.isArray(rawStage.criteria) ? rawStage.criteria : [];
      for (const rawCrit of crits) {
        if (!rawCrit || typeof rawCrit !== 'object') continue;
        const criterionId = cleanStr(rawCrit.criterion_id);
        if (!CRITERION_IDS.has(criterionId)) continue;              // unknown criterion
        if (CRITERION_TO_STAGE[criterionId] !== stageId) continue;  // wrong-stage placement
        if (validated.has(criterionId)) continue;                   // dedupe (first wins)
        validated.set(criterionId, validateCriterion(criterionId, rawCrit, anchors, structuredSupport));
      }
    }
  }

  // ── Overlay deterministic CRM facts (authoritative) ────────────────
  // Hard facts override any model interpretation — a real won opportunity
  // beats a narrative note claiming there are no wins.
  for (const criterionId of Object.keys(deterministic)) {
    if (!CRITERION_IDS.has(criterionId)) continue;
    const fact = deterministic[criterionId] || {};
    const status = VALID_CRITERION_STATUSES.has(String(fact.status)) ? String(fact.status) : 'met';
    validated.set(criterionId, {
      criterion_id: criterionId,
      status,
      evidence: cleanStr(fact.evidence),
      source_type: VALID_SOURCE_TYPES.has(String(fact.source_type)) ? String(fact.source_type) : 'none',
      source_id: cleanStr(fact.source_id),
      source_date: cleanStr(fact.source_date),
      related_entity_id: cleanStr(fact.related_entity_id),
    });
  }

  // ── Build the canonical 7×3 board with recomputed stage statuses ───
  const stages = PARTNER_STAGES.map(stageDef => {
    const criteria = stageDef.criteria.map(cd => validated.get(cd.id) || emptyCriterion(cd.id));
    return {
      stage_id: stageDef.id,
      status: stageStatusFromCriteria(criteria),
      notes: stageNotes.get(stageDef.id) || '',
      criteria,
    };
  });

  // ── Recompute operational + furthest-demonstrated + completion ─────
  let operationalStageId = '';
  let complete = true;
  for (const s of stages) {
    if (s.status !== 'complete') { operationalStageId = s.stage_id; complete = false; break; }
  }
  let furthestDemonstratedStageId = '';
  for (const s of stages) {
    if (s.criteria.some(c => c.status === 'met')) furthestDemonstratedStageId = s.stage_id;
  }
  const metCount = stages.reduce((n, s) => n + s.criteria.filter(c => c.status === 'met').length, 0);
  const total = stages.reduce((n, s) => n + s.criteria.length, 0);

  const orgResult = validPartnerOrgMap(parsed.org_map, anchors);

  return {
    partner_id: cleanStr(parsed.partner_id) || cleanStr(options.partnerId),
    partner_name: cleanStr(parsed.partner_name) || cleanStr(options.partnerName),
    operational_stage_id: operationalStageId || (complete ? 'revenue_growth' : ''),
    furthest_demonstrated_stage_id: furthestDemonstratedStageId,
    maturity_complete: complete,
    confidence: VALID_CONFIDENCE.has(cleanStr(parsed.confidence).toLowerCase())
      ? cleanStr(parsed.confidence).toLowerCase()
      : 'low',
    summary: cleanStr(parsed.summary),
    stages,
    next_actions: cleanStrArray(parsed.next_actions),
    gaps: cleanStrArray(parsed.gaps),
    open_questions: cleanStrArray(parsed.open_questions),
    risks: cleanStrArray(parsed.risks),
    momentum: cleanStrArray(parsed.momentum),
    org_map: orgResult.nodes,
    // What the org-chart validator did — surfaced by the UI/PDF so a removed
    // fabrication is visible instead of silently papered over.
    org_map_meta: orgResult.meta,
    completion: { met: metCount, total, pct: total > 0 ? Math.round((metCount / total) * 100) : 0 },
  };
}

// Validate one model criterion claim into a normalized result, enforcing the
// per-source-type rules.
function validateCriterion(criterionId, rawCrit, anchors, structuredSupport) {
  let status = VALID_CRITERION_STATUSES.has(cleanStr(rawCrit.status).toLowerCase())
    ? cleanStr(rawCrit.status).toLowerCase()
    : 'no_evidence';

  let evidence = cleanStr(rawCrit.evidence);
  let sourceType = VALID_SOURCE_TYPES.has(cleanStr(rawCrit.source_type).toLowerCase())
    ? cleanStr(rawCrit.source_type).toLowerCase()
    : 'none';
  let sourceId = cleanStr(rawCrit.source_id);
  let sourceDate = cleanStr(rawCrit.source_date);
  let relatedRaw = cleanStr(rawCrit.related_entity_id);

  const downgrade = () => {
    status = 'no_evidence'; evidence = ''; sourceType = 'none'; sourceId = ''; sourceDate = '';
  };

  if (CLAIMED_STATUSES.has(status)) {
    if (NARRATIVE_SOURCE_TYPES.has(sourceType)) {
      // GOLDEN RULE — narrative evidence must be traceable + grounded.
      if (sourceId && anchors.narrativeIds && !anchors.narrativeIds.has(sourceId)) sourceId = '';
      if (sourceDate && anchors.narrativeDates && !anchors.narrativeDates.has(sourceDate)) sourceDate = '';
      const hasAnchor = !!sourceId || !!sourceDate;
      if (!evidence || !hasAnchor) {
        downgrade();
      } else {
        const noteText = resolveAnchorText(sourceId, sourceDate, anchors);
        if (noteText != null && !isEvidenceGrounded(evidence, noteText)) downgrade();
      }
    } else if (STRUCTURED_SOURCE_TYPES.has(sourceType)) {
      // Structured claim — trusted only if a supplied fact supports it.
      // (Hard facts are also overlaid separately after parsing.)
      if (!structuredSupport[criterionId]) {
        downgrade();
      } else if (sourceId && anchors.structuredIds && anchors.structuredIds.size && !anchors.structuredIds.has(sourceId)) {
        // A fabricated structured source id is cleared, but an aggregate-backed
        // claim (no id) still stands on the supporting fact.
        sourceId = '';
      }
    } else {
      // sourceType 'none' (or unresolved) can never back a claim.
      downgrade();
    }
  }

  // not_met keeps its (negative) citation; no_evidence carries no payload.
  if (status === 'no_evidence') {
    evidence = ''; sourceType = 'none'; sourceId = ''; sourceDate = '';
  }

  const related = (status === 'no_evidence')
    ? ''
    : resolveRelated(sourceId, relatedRaw, anchors);

  return {
    criterion_id: criterionId,
    status,
    evidence,
    source_type: sourceType,
    source_id: sourceId,
    source_date: sourceDate,
    related_entity_id: related,
  };
}

// Resolve the entity a source link should open. Prefers the parent entity of a
// specific narrative source (an opp/event/partner), then a model-supplied
// related id that names a real structured entity, then a structured source id
// that names one, and finally the partner detail page as a safe fallback.
function resolveRelated(sourceId, relatedRaw, anchors) {
  if (sourceId && anchors.relatedById && anchors.relatedById.has(sourceId)) return anchors.relatedById.get(sourceId);
  if (relatedRaw && anchors.structuredIds && anchors.structuredIds.has(relatedRaw)) return relatedRaw;
  if (sourceId && anchors.structuredIds && anchors.structuredIds.has(sourceId)) return sourceId;
  return anchors.partnerId || '';
}

// ── Org-chart derivations (shared by the board render and the PDF) ──
/**
 * Nest the validated flat org_map (top-down, depth-annotated) into a tree of
 * `{ node, children }` branches. The SAME pure function feeds the on-screen
 * org chart and the PDF, so the two can never disagree about structure.
 *
 * Depth is normalized so a level can never be skipped: a node may sit at most
 * one level below the node before it (a "depth 3" row arriving directly under
 * a depth-0 row becomes its direct report), and its parent is the nearest
 * preceding shallower node. Multiple depth-0 roots are allowed.
 *
 * @param {Array<{name, status, depth, contact_id}>} orgMap validated org_map
 * @returns {Array<{ node: object, children: Array }>} the root branches
 */
export function buildOrgChartTree(orgMap) {
  const roots = [];
  const stack = []; // stack[d] = the most recent branch placed at depth d
  for (const raw of orgMap || []) {
    if (!raw || typeof raw !== 'object' || !String(raw.name || '').trim()) continue;
    let wanted = Number.parseInt(raw.depth, 10);
    if (!Number.isFinite(wanted) || wanted < 0) wanted = 0;
    const depth = Math.min(wanted, stack.length);
    const branch = { node: raw, children: [] };
    if (depth === 0) roots.push(branch);
    else stack[depth - 1].children.push(branch);
    stack[depth] = branch;
    stack.length = depth + 1;
  }
  return roots;
}

/**
 * Coverage read-out for the org chart (headline + legend counts) — the
 * partner-side analogue of deriveContactBriefBoard()'s org numbers.
 *
 * @param {Array} orgMap validated org_map
 * @returns {{ total, engaged, introduced, identified, missing, saved, corroborated }}
 */
export function derivePartnerOrgStats(orgMap) {
  const list = Array.isArray(orgMap) ? orgMap : [];
  const count = (s) => list.filter(n => n && n.status === s).length;
  return {
    total: list.length,
    engaged: count('engaged'),
    introduced: count('introduced'),
    identified: count('identified'),
    missing: count('missing'),
    saved: list.filter(n => n && String(n.contact_id || '').trim()).length,
    // Found in BOTH the saved roster and the narrative evidence — the
    // strongest identity claim the chart can make.
    corroborated: list.filter(n => n && (n.corroborated === true || n.person_source === 'both')).length,
  };
}
