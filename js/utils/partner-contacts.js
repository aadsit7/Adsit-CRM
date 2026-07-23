// ============================================================
// Partner Contacts — source collection, extraction contract, strict
// verbatim validation, and merge/persistence helpers
// ============================================================
// Powers the "Contacts" section on the Partner Detail page. Contacts are
// identified by analyzing the partner's OWN record — description notes
// (Transcripts rows), indexed meetings, partner documents, and Drive
// attachments — never another partner's data and never outside knowledge.
//
// ACCURACY CONTRACT (the reason this module exists):
// The model only PROPOSES contacts; this module verifies every one of them
// against the supplied source text before anything is saved:
//   • a contact survives only if its NAME is literally present in a cited
//     source (exact phrase, or all name words within a tight window — which
//     accepts "Smith, John" for "John Smith" but rejects a name stitched
//     together from two different people);
//   • email / phone / role / company survive only if the VALUE is literally
//     present in one of that contact's verified sources — otherwise the
//     field is blanked, never guessed (empty means "not stated", wrong is
//     treated as worse than empty);
//   • cited source ids that don't exist, or that don't actually contain the
//     person, are dropped; a contact with no surviving source is discarded.
// Attachment (Drive file) contacts arrive from the Apps Script attendee
// pipeline, which is deterministic for spreadsheets and strictly grounded
// for documents — they are mapped, not re-validated, and carry their file
// as provenance.
//
// No DOM, no network — fully testable under Node.
// ============================================================

import { stripHtml } from './forecast-prompts.js';
import {
  selectPartnerTranscripts,
  selectPartnerMeetings,
  selectPartnerDocuments,
} from './partner-analyzer-evidence.js';

// ── Sheet contract ──────────────────────────────────────────────────
// Canonical Partner_Contacts header row. sheets.js imports this so the
// initializer, the demo store and this module can never drift apart.
// The three analysis_* columns hold the row-level LeadCheck result (see
// js/utils/partner-contact-leadcheck.js): workflow state, last-verified
// timestamp, and the full validated report as JSON. They were appended
// AFTER the original 14 columns — ensureSheetWithHeaders() extends
// prefix-matching header rows in place, and rows written before the
// extension simply read these fields as empty.
export const PARTNER_CONTACT_HEADERS = [
  'contact_id', 'partner_id', 'partner_name',
  'name', 'role', 'company', 'email', 'phone',
  'evidence', 'sources_json', 'first_seen', 'last_seen',
  'created_at', 'updated_at',
  'analysis_state', 'analysis_last_verified', 'analysis_json',
];

/**
 * True when `actual` is a strict prefix of `expected` — the safe condition
 * for extending an existing sheet's header row in place (data columns keep
 * their positions; new columns append at the end).
 */
export function isHeaderPrefixOf(actual, expected) {
  const a = (actual || []).map(h => String(h == null ? '' : h).trim());
  while (a.length && !a[a.length - 1]) a.pop(); // ignore trailing blanks
  if (a.length === 0 || a.length >= (expected || []).length) return false;
  return a.every((h, i) => h === expected[i]);
}

export const PARTNER_CONTACT_SOURCE_TYPES = new Set([
  'description',       // a Transcripts row (the partner page's Descriptions)
  'meeting',           // a Meeting_Index row
  'partner_document',  // a Partner_Documents row
  'attachment',        // a Drive file attached to the partner (file API)
  'manual',            // added/edited by hand in the portal
]);

// ── Source-collection limits (named so they can be tuned in one place) ─
export const CONTACT_SOURCE_LIMITS = {
  descriptions: 40,
  meetings: 30,
  documents: 20,
  charsPerItem: 6000,
  totalChars: 150_000,
};

// ── Text normalization for verbatim matching ────────────────────────
// Lowercase, fold diacritics (José ↔ Jose), normalize curly quotes, and
// collapse whitespace so "John\n  Smith" still counts as verbatim.
function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritics (José → jose)
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALNUM_RE = /[a-z0-9]/;
function isAlnumChar(ch) { return !!ch && ALNUM_RE.test(ch); }

// All boundary-clean occurrence positions of `needle` inside normalized
// `hay` — an occurrence whose immediate neighbors are letters/digits is a
// substring of another word ("ann" in "annette") and does not count.
function findPhrasePositions(hay, needle) {
  const positions = [];
  if (!needle) return positions;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    const before = idx === 0 ? '' : hay[idx - 1];
    const after = idx + needle.length >= hay.length ? '' : hay[idx + needle.length];
    if (!isAlnumChar(before) && !isAlnumChar(after)) positions.push(idx);
    idx = hay.indexOf(needle, idx + 1);
  }
  return positions;
}

// How far apart the words of a name may sit and still count as the same
// mention ("Smith, John" / "John (JJ) Smith"). Tight on purpose: two
// different people mentioned sentences apart must never combine into a
// fabricated third person.
const NAME_WINDOW_CHARS = 90;

/**
 * Does `text` literally contain this person's name?
 * True when the exact phrase appears (boundary-clean), or when every word
 * of the name appears within NAME_WINDOW_CHARS of the first word — which
 * accepts reordered forms like "Smith, John" but rejects names assembled
 * from words that only co-occur far apart.
 */
export function nameFoundInText(name, text) {
  const n = normalizeForMatch(name);
  const t = normalizeForMatch(text);
  if (!n || !t) return false;
  if (findPhrasePositions(t, n).length > 0) return true;

  const words = n.split(' ').filter(w => w.length >= 2);
  if (words.length < 2) return false; // single-word names need the exact phrase
  const perWord = words.map(w => findPhrasePositions(t, w));
  if (perWord.some(p => p.length === 0)) return false;
  return perWord[0].some(anchor =>
    perWord.every(list => list.some(pos => Math.abs(pos - anchor) <= NAME_WINDOW_CHARS))
  );
}

// Characters legal inside an email token — used to boundary-check so
// "an@b.co" can never match inside "ryan@b.com".
const EMAIL_CHAR_RE = /[a-z0-9._%+-]/;

/** Is this exact email literally present in the text? */
export function emailFoundInText(email, text) {
  const e = normalizeForMatch(email);
  const t = normalizeForMatch(text);
  if (!e || !t || e.indexOf('@') <= 0) return false;
  let idx = t.indexOf(e);
  while (idx !== -1) {
    const before = idx === 0 ? '' : t[idx - 1];
    const after = idx + e.length >= t.length ? '' : t[idx + e.length];
    if (!EMAIL_CHAR_RE.test(before || ' ') && !EMAIL_CHAR_RE.test(after || ' ')) return true;
    idx = t.indexOf(e, idx + 1);
  }
  return false;
}

function digitsOf(s) { return String(s || '').replace(/\D+/g, ''); }

// Characters that may appear INSIDE a written phone number. Two separator
// sets: strict (never spaces) and loose (spaces join groups). Comparing the
// candidate against complete runs from both sets accepts every common phone
// formatting while rejecting truncations ("555-1234" is NOT verified by
// "555.123.4567") and numbers stitched across unrelated digit groups.
const PHONE_SEPARATORS_STRICT = '-.()/';
const PHONE_SEPARATORS_LOOSE = '-.()/ \u00a0';

function digitRuns(text, sepChars) {
  const s = String(text || '');
  const runs = [];
  let cur = '';
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') { cur += ch; continue; }
    if (cur && sepChars.includes(ch)) continue; // separator may continue the run
    if (cur) runs.push(cur);
    cur = '';
  }
  if (cur) runs.push(cur);
  return runs;
}

/**
 * Is this phone number literally present in the text?
 * The candidate's digits must equal a COMPLETE number as written (a maximal
 * digit run under phone-style separators) — optionally preceded by a "1"
 * country prefix in the source. Substring matches don't count: a truncated
 * or stitched-together number is a wrong value, not a verified one.
 */
export function phoneFoundInText(phone, text) {
  const p = digitsOf(phone);
  if (p.length < 7) return false;
  const runs = [
    ...digitRuns(text, PHONE_SEPARATORS_STRICT),
    ...digitRuns(text, PHONE_SEPARATORS_LOOSE),
  ];
  return runs.some(run => run === p || run === `1${p}`);
}

/** Is this field value (role/company) literally present as a phrase? */
export function fieldFoundInText(value, text) {
  const v = normalizeForMatch(value);
  const t = normalizeForMatch(text);
  if (!v || !t) return false;
  return findPhrasePositions(t, v).length > 0;
}

// ── Source collection (strictly partner-scoped) ─────────────────────
function truncateText(text, cap) {
  const s = String(text || '');
  if (s.length <= cap) return { text: s, truncated: false };
  return { text: `${s.slice(0, cap)} …[truncated]`, truncated: true };
}

function firstNonEmpty(...vals) {
  for (const v of vals) { const s = String(v || '').trim(); if (s) return s; }
  return '';
}

// Meeting_Index rows are structured; combine the people-bearing fields into
// one prose blob (same composition the Partner Analyzer uses).
function meetingSourceText(m) {
  return [
    m.meeting_title ? `Title: ${stripHtml(m.meeting_title)}` : '',
    m.attendees ? `Attendees: ${stripHtml(m.attendees)}` : '',
    m.summary ? `Summary: ${stripHtml(m.summary)}` : '',
    m.key_decisions ? `Decisions: ${stripHtml(m.key_decisions)}` : '',
    m.topics_discussed ? `Topics: ${stripHtml(m.topics_discussed)}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Collect the partner-scoped text sources the extraction reads:
 * description notes (Transcripts), Meeting_Index rows, and Partner_Documents.
 * Strict scoping via the tested Partner Analyzer selectors — another
 * partner's rows can never leak in. Newest-first with explicit caps;
 * truncation is labelled, and coverage reports found vs included.
 *
 * @returns {{ sources: Array<{source_id, source_type, label, date, text}>,
 *   coverage: { found, included, truncatedItems } }}
 */
export function collectPartnerContactSources({ partnerId, transcripts, meetings, documents } = {}, limits = {}) {
  const L = { ...CONTACT_SOURCE_LIMITS, ...limits };
  const sources = [];
  const found = { descriptions: 0, meetings: 0, documents: 0 };
  const included = { descriptions: 0, meetings: 0, documents: 0 };
  let truncatedItems = 0;
  let totalChars = 0;

  const push = (kind, cap, source) => {
    found[kind] += 1;
    if (included[kind] >= cap) return;
    const budget = Math.max(0, L.totalChars - totalChars);
    if (budget <= 0) return;
    const { text, truncated } = truncateText(source.text, Math.min(L.charsPerItem, budget));
    if (truncated) truncatedItems += 1;
    totalChars += text.length;
    sources.push({ ...source, text });
    included[kind] += 1;
  };

  for (const t of selectPartnerTranscripts(transcripts, partnerId)) {
    const text = stripHtml(t.transcript_text || '');
    if (!text.trim()) continue;
    push('descriptions', L.descriptions, {
      source_id: String(t.transcript_id || '').trim(),
      source_type: 'description',
      label: 'Description',
      date: firstNonEmpty(t.conversation_date, t.created_at).slice(0, 10),
      text,
    });
  }

  for (const m of selectPartnerMeetings(meetings, partnerId)) {
    const text = meetingSourceText(m);
    if (!text.trim()) continue;
    push('meetings', L.meetings, {
      source_id: String(m.meeting_id || '').trim(),
      source_type: 'meeting',
      label: String(m.meeting_title || '').trim() || 'Meeting',
      date: String(m.meeting_date || '').trim().slice(0, 10),
      text,
    });
  }

  for (const d of selectPartnerDocuments(documents, partnerId)) {
    const text = stripHtml(d.html_content || '');
    if (!text.trim()) continue;
    push('documents', L.documents, {
      source_id: String(d.document_id || '').trim(),
      source_type: 'partner_document',
      label: String(d.title || '').trim() || 'Partner document',
      date: firstNonEmpty(d.updated_at, d.created_at).slice(0, 10),
      text,
    });
  }

  // A source without an id cannot be cited or verified — drop it up front.
  const usable = sources.filter(s => s.source_id);
  return { sources: usable, coverage: { found, included, truncatedItems } };
}

// ── Prompt ──────────────────────────────────────────────────────────
export const PARTNER_CONTACTS_SCHEMA_EXAMPLE = `{
  "contacts": [
    {
      "name": "string — the person's name COPIED EXACTLY as written in a source",
      "role": "string — job title copied verbatim from a cited source, or \\"\\"",
      "company": "string — company copied verbatim from a cited source, or \\"\\"",
      "email": "string — email copied verbatim from a cited source, or \\"\\"",
      "phone": "string — phone copied verbatim from a cited source, or \\"\\"",
      "source_ids": ["string — EVERY supplied source id where this person appears"],
      "context": "string — one short phrase (<140 chars) copied verbatim from a cited source showing this person"
    }
  ],
  "note": "string — one short sentence about coverage or data quality, or \\"\\""
}`;

/**
 * Build the extraction prompt. The rules mirror what the parser enforces —
 * the model is told the truth about how its output will be verified.
 */
export function buildPartnerContactsPrompt({ partnerName, sources = [], today } = {}) {
  const name = String(partnerName || 'this partner').trim() || 'this partner';
  const blocks = sources.map(s => (
    `[src id=${s.source_id} | type=${s.source_type} | date=${s.date || 'undated'} | label=${s.label || ''}]\n<<<\n${s.text}\n>>>`
  )).join('\n\n');

  return `You are a meticulous CRM data steward for a partner-management portal.

TASK
The sources below are the complete CRM record for the partner "${name}" — description/call notes, indexed meetings, and partner documents. Extract the roster of individual PEOPLE named in these sources: the human contacts connected to this partnership record.

THE GOLDEN RULE — ACCURACY OVER COMPLETENESS
Every value you output will be verified verbatim against the cited source text; anything that is not literally present will be discarded. A wrong or invented value is a failure; an empty field is correct. Use only the supplied sources — never outside knowledge, memory of companies, or plausible guessing.

RULES
1. Extract individual people only. Skip bare companies, teams, and unnamed role references ("their CTO", "the SE team").
2. Copy each person's name EXACTLY as written in the source — same spelling, casing, accents, and word order. Never expand, shorten, or normalize a name.
3. Fill role, company, email, and phone ONLY when the source text states that value explicitly for that person; otherwise use "". Copy the value verbatim. Never infer a company from an email domain. Never complete a partial email or phone number.
4. source_ids must list EVERY supplied source id in which the person's name appears, and ONLY supplied ids. A person "appears" in a source only when their name is written in that source's text.
5. If the same person appears in multiple sources, output ONE contact carrying all of their source_ids. If two different people share a name, output them separately with their own source_ids.
6. context: one short phrase (under 140 characters) copied verbatim from one cited source that shows this person being mentioned.
7. If the sources name no people at all, return an empty contacts array.

OUTPUT
Respond with STRICT JSON only — no prose, no markdown fences — in exactly this shape:
${PARTNER_CONTACTS_SCHEMA_EXAMPLE}

TODAY: ${String(today || '').slice(0, 10) || 'unknown'}
PARTNER: ${name}

SOURCES (${sources.length})
${blocks || '(none)'}`;
}

// ── Strict parser / validator ───────────────────────────────────────
const MAX_CONTACTS = 500;
const MAX_NAME_LEN = 120;
const MAX_FIELD_LEN = 160;
const MAX_EMAIL_LEN = 200;
const MAX_PHONE_LEN = 60;
const MAX_EVIDENCE_LEN = 200;

function cleanStr(v, cap) {
  const s = typeof v === 'string' ? v.trim() : '';
  return cap && s.length > cap ? '' : s;
}

const NOT_SPECIFIED_RE = /^(not specified|not provided|unknown|n\/?a|none|-|—)$/i;
function dropPlaceholder(s) {
  return NOT_SPECIFIED_RE.test(String(s || '').trim()) ? '' : String(s || '').trim();
}

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

/**
 * Parse and validate the model's raw text into verified contacts.
 * Every kept contact is grounded in the supplied sources (see the module
 * header for the exact guarantees). Ungroundable fields are blanked;
 * ungroundable contacts are dropped and reported in `dropped`.
 *
 * @param {string} rawText
 * @param {object} options
 * @param {Array}  options.sources  The exact sources given to the prompt.
 * @returns {{ contacts: Array, note: string, dropped: Array<{name, reason}> }}
 */
export function parsePartnerContactsResponse(rawText, { sources = [] } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    const err = new Error('The contact extraction returned an empty response.');
    err.code = 'PARTNER_CONTACTS_EMPTY';
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
    const err = new Error(`Contact extraction JSON parse failed: ${e.message}`);
    err.code = 'PARTNER_CONTACTS_INVALID';
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('Contact extraction response is not a JSON object.');
    err.code = 'PARTNER_CONTACTS_SCHEMA';
    throw err;
  }

  const sourceById = new Map();
  for (const s of sources) {
    if (s && s.source_id) sourceById.set(String(s.source_id), s);
  }

  const rawContacts = Array.isArray(parsed.contacts) ? parsed.contacts.slice(0, MAX_CONTACTS) : [];
  const contacts = [];
  const dropped = [];

  for (const raw of rawContacts) {
    if (!raw || typeof raw !== 'object') continue;
    const name = dropPlaceholder(cleanStr(raw.name, MAX_NAME_LEN));
    if (!name) { dropped.push({ name: cleanStr(raw.name, 300) || '(unnamed)', reason: 'no name' }); continue; }

    const citedIds = (Array.isArray(raw.source_ids) ? raw.source_ids : [])
      .map(id => String(id == null ? '' : id).trim())
      .filter(id => sourceById.has(id));

    // Keep only cited sources that literally contain this person.
    const email = dropPlaceholder(cleanStr(raw.email, MAX_EMAIL_LEN));
    const verified = [];
    const seenIds = new Set();
    for (const id of citedIds) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const src = sourceById.get(id);
      if (nameFoundInText(name, src.text) || (email && emailFoundInText(email, src.text))) {
        verified.push(src);
      }
    }
    if (verified.length === 0) {
      dropped.push({ name, reason: 'not found verbatim in any cited source' });
      continue;
    }

    const inAnyVerified = (fn, value) => verified.some(src => fn(value, src.text));

    const groundedEmail = (email && looksLikeEmail(email) && inAnyVerified(emailFoundInText, email)) ? email : '';
    const rawPhone = dropPlaceholder(cleanStr(raw.phone, MAX_PHONE_LEN));
    const groundedPhone = (rawPhone && inAnyVerified(phoneFoundInText, rawPhone)) ? rawPhone : '';
    const rawRole = dropPlaceholder(cleanStr(raw.role, MAX_FIELD_LEN));
    const groundedRole = (rawRole && inAnyVerified(fieldFoundInText, rawRole)) ? rawRole : '';
    const rawCompany = dropPlaceholder(cleanStr(raw.company, MAX_FIELD_LEN));
    const groundedCompany = (rawCompany && inAnyVerified(fieldFoundInText, rawCompany)) ? rawCompany : '';
    const rawContext = cleanStr(raw.context, MAX_EVIDENCE_LEN);
    const groundedContext = (rawContext && inAnyVerified(fieldFoundInText, rawContext)) ? rawContext : '';

    contacts.push({
      name,
      role: groundedRole,
      company: groundedCompany,
      email: groundedEmail,
      phone: groundedPhone,
      evidence: groundedContext,
      sources: verified.map(src => ({
        type: src.source_type,
        id: src.source_id,
        label: src.label || '',
        date: src.date || '',
      })),
    });
  }

  return {
    contacts: dedupeExtracted(contacts),
    note: cleanStr(parsed.note, 300),
    dropped,
  };
}

// Two records may be the same person unless BOTH carry an email and the
// emails differ — the guard that keeps two distinct people who share a name
// from ever collapsing into one contact.
function emailsCompatible(a, b) {
  const ea = String(a || '').trim().toLowerCase();
  const eb = String(b || '').trim().toLowerCase();
  return !ea || !eb || ea === eb;
}

// Collapse duplicate extracted contacts into one, unioning sources and
// filling blank fields. Match by email first, then by normalized name (a
// mention that lost its email during grounding still folds into the fuller
// record) — but never across two different emails.
function dedupeExtracted(contacts) {
  const byEmail = new Map();
  const byName = new Map();
  const out = [];
  for (const c of contacts) {
    const emailKey = String(c.email || '').trim().toLowerCase();
    const nameKey = normalizeForMatch(c.name);

    let target = (emailKey && byEmail.get(emailKey)) || null;
    if (!target && nameKey) {
      const cand = byName.get(nameKey);
      if (cand && emailsCompatible(cand.email, c.email)) target = cand;
    }

    if (!target) {
      if (emailKey) byEmail.set(emailKey, c);
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, c);
      out.push(c);
      continue;
    }
    for (const f of ['name', 'role', 'company', 'email', 'phone', 'evidence']) {
      if (!target[f] && c[f]) target[f] = c[f];
    }
    target.sources = unionSources(target.sources, c.sources);
    const mergedEmail = String(target.email || '').trim().toLowerCase();
    if (mergedEmail && !byEmail.has(mergedEmail)) byEmail.set(mergedEmail, target);
    const mergedName = normalizeForMatch(target.name);
    if (mergedName && !byName.has(mergedName)) byName.set(mergedName, target);
  }
  return out;
}

function sourceKey(s) { return `${s.type}|${s.id}|${s.label}`; }

function unionSources(a, b) {
  const seen = new Set();
  const out = [];
  for (const s of [...(a || []), ...(b || [])]) {
    if (!s || typeof s !== 'object') continue;
    const key = sourceKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: String(s.type || ''), id: String(s.id || ''), label: String(s.label || ''), date: String(s.date || '') });
  }
  return out;
}

// ── Attachment (Apps Script attendee pipeline) mapping ──────────────
/**
 * Map the contacts array returned by the Apps Script attendee-list analysis
 * of one Drive attachment into the extracted-contact shape. That pipeline
 * reads spreadsheets deterministically and extracts documents under a strict
 * no-fabrication prompt, so rows are trusted as-is; this only normalizes
 * placeholders and attaches the file as provenance.
 */
export function attendeeContactsToExtracted(rawContacts, { docId, fileName, date } = {}) {
  const source = {
    type: 'attachment',
    id: String(docId || '').trim(),
    label: String(fileName || 'Attachment').trim() || 'Attachment',
    date: String(date || '').slice(0, 10),
  };
  const out = [];
  for (const raw of rawContacts || []) {
    if (!raw || typeof raw !== 'object') continue;
    const name = dropPlaceholder(cleanStr(raw.name, MAX_NAME_LEN));
    const email = dropPlaceholder(cleanStr(raw.email, MAX_EMAIL_LEN));
    if (!name && !email) continue;
    out.push({
      name,
      role: dropPlaceholder(cleanStr(raw.role, MAX_FIELD_LEN)),
      company: dropPlaceholder(cleanStr(raw.company, MAX_FIELD_LEN)),
      email: looksLikeEmail(email) ? email : '',
      phone: dropPlaceholder(cleanStr(raw.phone, MAX_PHONE_LEN)),
      evidence: '',
      sources: [{ ...source }],
    });
  }
  return dedupeExtracted(out);
}

// ── Row (de)serialization ───────────────────────────────────────────
/** Tolerant sources_json parse — malformed JSON yields []. */
export function parseSourcesJson(raw) {
  if (Array.isArray(raw)) return unionSources(raw, []);
  const s = String(raw || '').trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? unionSources(parsed, []) : [];
  } catch {
    return [];
  }
}

/** Serialize one contact object into a Partner_Contacts row (header order). */
export function partnerContactRowValues(c) {
  return PARTNER_CONTACT_HEADERS.map(h => {
    if (h === 'sources_json') return JSON.stringify(c.sources || []);
    return String(c[h] == null ? '' : c[h]);
  });
}

/** Rehydrate a sheet row object into a contact object (sources parsed). */
export function partnerContactFromRow(row) {
  const c = { _rowIndex: row._rowIndex };
  for (const h of PARTNER_CONTACT_HEADERS) {
    if (h === 'sources_json') continue;
    c[h] = String(row[h] == null ? '' : row[h]).trim();
  }
  c.sources = parseSourcesJson(row.sources_json);
  return c;
}

// ── Merge (scan results into existing saved contacts) ───────────────
function minDate(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return a <= b ? a : b;
}
function maxDate(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return a >= b ? a : b;
}
function sourceDateRange(sources) {
  let lo = '', hi = '';
  for (const s of sources || []) {
    const d = String(s.date || '').slice(0, 10);
    if (!d) continue;
    lo = minDate(lo, d);
    hi = maxDate(hi, d);
  }
  return { lo, hi };
}

let fallbackIdCounter = 0;
function defaultMakeId() {
  fallbackIdCounter += 1;
  return `pct_${Date.now().toString(36)}_${fallbackIdCounter}`;
}

/**
 * Merge freshly extracted contacts into the partner's saved rows.
 *
 * Matching: primary key is the email (case-insensitive); fallback is the
 * normalized name. Merging only FILLS BLANK fields and unions sources — it
 * never overwrites a saved value, so manual corrections always survive a
 * re-scan. Unmatched contacts become new rows.
 *
 * @param {object} params
 * @param {Array} params.existing   partnerContactFromRow() objects.
 * @param {Array} params.extracted  Extracted contacts (parse/attendee shape).
 * @param {string} params.partnerId
 * @param {string} params.partnerName
 * @param {string} params.nowIso    Timestamp for created_at/updated_at.
 * @param {Function} [params.makeId]
 * @returns {{ toAppend: Array, toUpdate: Array, added: number, updated: number, unchanged: number }}
 */
export function mergeExtractedContacts({
  existing = [], extracted = [], partnerId = '', partnerName = '', nowIso = '', makeId,
} = {}) {
  const mkId = typeof makeId === 'function' ? makeId : defaultMakeId;
  const byEmail = new Map();
  const byName = new Map();
  const register = (c) => {
    const e = String(c.email || '').trim().toLowerCase();
    const n = normalizeForMatch(c.name);
    if (e && !byEmail.has(e)) byEmail.set(e, c);
    if (n && !byName.has(n)) byName.set(n, c);
  };
  existing.forEach(register);

  const toAppend = [];
  const changedRows = new Set();
  let unchanged = 0;

  for (const x of extracted) {
    const email = String(x.email || '').trim().toLowerCase();
    const nameKey = normalizeForMatch(x.name);
    let target = (email && byEmail.get(email)) || null;
    if (!target && nameKey) {
      // Name-only match — allowed only when the emails don't contradict, so
      // two people sharing a name but with different emails stay separate.
      const cand = byName.get(nameKey);
      if (cand && emailsCompatible(cand.email, x.email)) target = cand;
    }

    if (!target) {
      const { lo, hi } = sourceDateRange(x.sources);
      const fresh = {
        contact_id: mkId(),
        partner_id: partnerId,
        partner_name: partnerName,
        name: x.name || '',
        role: x.role || '',
        company: x.company || '',
        email: x.email || '',
        phone: x.phone || '',
        evidence: x.evidence || '',
        sources: unionSources(x.sources, []),
        first_seen: lo,
        last_seen: hi,
        created_at: nowIso,
        updated_at: nowIso,
      };
      toAppend.push(fresh);
      register(fresh);
      continue;
    }

    let changed = false;
    for (const f of ['name', 'role', 'company', 'email', 'phone', 'evidence']) {
      if (!target[f] && x[f]) {
        target[f] = x[f];
        if (f === 'email') byEmail.set(String(x.email).toLowerCase(), target);
        if (f === 'name') { const nk = normalizeForMatch(x.name); if (nk && !byName.has(nk)) byName.set(nk, target); }
        changed = true;
      }
    }
    const before = (target.sources || []).length;
    target.sources = unionSources(target.sources, x.sources);
    if (target.sources.length !== before) changed = true;

    const { lo, hi } = sourceDateRange(x.sources);
    const newFirst = minDate(target.first_seen, lo);
    const newLast = maxDate(target.last_seen, hi);
    if (newFirst !== target.first_seen) { target.first_seen = newFirst; changed = true; }
    if (newLast !== target.last_seen) { target.last_seen = newLast; changed = true; }

    if (changed) {
      target.updated_at = nowIso;
      if (target._rowIndex) changedRows.add(target);
    } else {
      unchanged += 1;
    }
  }

  const toUpdate = [...changedRows];
  return { toAppend, toUpdate, added: toAppend.length, updated: toUpdate.length, unchanged };
}

/** Display sort: named contacts A→Z, nameless (email-only) rows last. */
export function sortContactsForDisplay(contacts) {
  return [...(contacts || [])].sort((a, b) => {
    const an = normalizeForMatch(a.name);
    const bn = normalizeForMatch(b.name);
    if (!an && !bn) return String(a.email || '').localeCompare(String(b.email || ''));
    if (!an) return 1;
    if (!bn) return -1;
    return an.localeCompare(bn);
  });
}
