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
//
// AFFILIATION RULE (partner-side people only):
// A row in this table means "a person working for / representing THIS
// partner". The model judges affiliation per person (works_for_partner);
// anyone it ties to a different employer — our own team, a customer,
// another vendor — is excluded. Deterministic backstops: a contact whose
// VERIFIED company doesn't match the partner is dropped, and the CRM
// owner's own company (CRM_OWNER_COMPANY) is never a partner contact.
//
// DUPLICATE RULE (similar-name reasoning):
// One human must never become two rows. Dedupe and merge match by email,
// then by name — exact first, then conservative similarity: a one-character
// insertion/deletion ("Jack Smith" ↔ "Jack Smiths", "Jon" ↔ "John"),
// initials ("J. Smith" ↔ "Jack Smith"), and subset names ("Aaron" ↔
// "Aaron Adsit") count as the same person when unambiguous and the emails
// don't contradict; substitutions never match ("Mark" ≠ "Mary").
//
// Attachment (Drive file) contacts arrive from the Apps Script attendee
// pipeline, which is deterministic for spreadsheets and strictly grounded
// for documents — they are mapped (and affiliation-filtered), not
// re-validated, and carry their file as provenance.
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

// The CRM owner's own organization. People on OUR side of the relationship
// (the folks writing these notes) are never partner contacts, no matter
// which partner record mentions them. Matches the branding hardcoded across
// the app (PDF footers, event stages).
export const CRM_OWNER_COMPANY = 'Recast Software';

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

// ── Similar-name reasoning (duplicate prevention) ───────────────────
// "Jack Smith" vs "Jack Smiths", "Jon" vs "John Smith", "J. Smith" vs
// "Jack Smith" — one human, spelled slightly differently, must never
// become two contact rows. Matching is deliberately conservative:
//   • a token may differ by ONE inserted/deleted character (typo, plural,
//     Jon/John) but never by substitution — "Mark" and "Mary" are one
//     substitution apart and stay two people;
//   • a single-letter token acts as an initial ("J." matches "Jack"), but
//     initials alone can never link two names;
//   • a shorter name folds into a fuller one ("Aaron" → "Aaron Adsit")
//     only when every one of its tokens is accounted for — and callers
//     additionally require the fuzzy match to be UNambiguous (exactly one
//     candidate) and the emails not to contradict.
const FUZZY_TOKEN_MIN_LEN = 4;

function nameTokens(name) {
  return normalizeForMatch(name).split(/[^a-z0-9]+/).filter(Boolean);
}

// One-character insertion/deletion equality ("smith"/"smiths",
// "jon"/"john"). Substitutions and transpositions intentionally fail.
function oneInsertDeleteApart(a, b) {
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (l.length - s.length !== 1 || l.length < FUZZY_TOKEN_MIN_LEN) return false;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < s.length) {
    if (s[i] === l[j]) { i += 1; j += 1; continue; }
    if (skipped) return false;
    skipped = true;
    j += 1;
  }
  return true;
}

function tokensNearlyEqual(a, b) { return a === b || oneInsertDeleteApart(a, b); }

function tokenMatchesAllowingInitial(a, b) {
  if (tokensNearlyEqual(a, b)) return true;
  if (a.length === 1 && b.length > 1 && b[0] === a) return true;
  if (b.length === 1 && a.length > 1 && a[0] === b) return true;
  return false;
}

function substantiveTokenCount(name) {
  return nameTokens(name).filter(t => t.length >= 2).length;
}

/**
 * Are these two names plausibly the same individual? Every token of the
 * shorter name must claim a DISTINCT token of the longer one (exact claims
 * first, then one-insert/delete fuzzy or initial), and at least one claimed
 * pair must be a real word on both sides — initials alone never link names.
 * Word order is ignored ("Smith, Jack" ↔ "Jack Smiths").
 */
export function namesLikelySamePerson(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Array(long.length).fill(false);
  const claim = (tok, matcher) => {
    for (let j = 0; j < long.length; j += 1) {
      if (!used[j] && matcher(tok, long[j])) { used[j] = true; return j; }
    }
    return -1;
  };
  // Exact claims run first so a fuzzy token can't steal another token's
  // exact partner.
  const pending = [];
  let substantive = false;
  for (const tok of short) {
    const j = claim(tok, (x, y) => x === y);
    if (j === -1) { pending.push(tok); continue; }
    if (tok.length >= 2) substantive = true;
  }
  for (const tok of pending) {
    const j = claim(tok, tokenMatchesAllowingInitial);
    if (j === -1) return false;
    if (tok.length >= 2 && long[j].length >= 2) substantive = true;
  }
  return substantive;
}

/**
 * Like nameFoundInText, but each word tolerates a one-character
 * insertion/deletion ("Jack Smith" verifies against a source that wrote
 * "Jack Smiths"). The exact check runs first; the tight co-occurrence
 * window still applies, so names can never be stitched from two people
 * mentioned apart, and single-word names still require the exact phrase.
 */
export function nameFoundInTextFuzzy(name, text) {
  if (nameFoundInText(name, text)) return true;
  const n = normalizeForMatch(name);
  const t = normalizeForMatch(text);
  if (!n || !t) return false;
  const words = n.split(' ').filter(w => w.length >= 2);
  if (words.length < 2) return false;
  const perWord = words.map(w => fuzzyWordPositions(t, w));
  if (perWord.some(p => p.length === 0)) return false;
  return perWord[0].some(anchor =>
    perWord.every(list => list.some(pos => Math.abs(pos - anchor) <= NAME_WINDOW_CHARS))
  );
}

// Positions of text tokens that nearly equal `word` (no initials here —
// verification against sources stays tighter than record-vs-record dedupe).
function fuzzyWordPositions(hayNormalized, word) {
  const positions = [];
  const clean = word.replace(/[^a-z0-9]/g, '');
  if (clean.length < 2) return positions;
  const re = /[a-z0-9]+/g;
  let m;
  while ((m = re.exec(hayNormalized)) !== null) {
    if (tokensNearlyEqual(clean, m[0])) positions.push(m.index);
  }
  return positions;
}

// ── Company ↔ partner matching (the affiliation rule) ───────────────
// Legal/structural suffix tokens that don't identify a company.
const COMPANY_STOP_TOKENS = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp',
  'corporation', 'co', 'company', 'plc', 'gmbh', 'sa', 'ag', 'bv', 'nv',
  'pty', 'the',
]);

function companyTokens(s) {
  const all = normalizeForMatch(s).split(/[^a-z0-9]+/).filter(Boolean);
  const core = all.filter(t => !COMPANY_STOP_TOKENS.has(t));
  return core.length ? core : all;
}

/**
 * Does this stated company plausibly name the partner organization?
 * Case, punctuation and legal suffixes are ignored, and one side may be a
 * token-subset of the other — "Insight" ↔ "Insight Enterprises, Inc.",
 * "CDW Canada" ↔ "CDW" — so a subsidiary or short form never reads as a
 * different company.
 */
export function companyMatchesPartner(company, partnerName) {
  const a = companyTokens(company);
  const b = companyTokens(partnerName);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every(tok => long.includes(tok));
}

function isCrmOwnerCompany(company, ownCompany) {
  const c = String(company || '').trim();
  return !!c && companyMatchesPartner(c, ownCompany || CRM_OWNER_COMPANY);
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
      "works_for_partner": "string — \\"yes\\" | \\"no\\" | \\"unknown\\": does this person work for / represent the partner organization?",
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
export function buildPartnerContactsPrompt({ partnerName, sources = [], today, ownCompany = CRM_OWNER_COMPANY } = {}) {
  const name = String(partnerName || 'this partner').trim() || 'this partner';
  const us = String(ownCompany || '').trim() || CRM_OWNER_COMPANY;
  const blocks = sources.map(s => (
    `[src id=${s.source_id} | type=${s.source_type} | date=${s.date || 'undated'} | label=${s.label || ''}]\n<<<\n${s.text}\n>>>`
  )).join('\n\n');

  return `You are a meticulous CRM data steward for a partner-management portal.

TASK
The sources below are the complete CRM record for the partner "${name}" — description/call notes, indexed meetings, and partner documents. Extract the roster of individual PEOPLE named in these sources: the human contacts on the partner's side of this relationship.

THE GOLDEN RULE — ACCURACY OVER COMPLETENESS
Every value you output will be verified verbatim against the cited source text; anything that is not literally present will be discarded. A wrong or invented value is a failure; an empty field is correct. Use only the supplied sources — never outside knowledge, memory of companies, or plausible guessing.

RULES
1. Extract individual people only. Skip bare companies, teams, and unnamed role references ("their CTO", "the SE team").
2. PARTNER-SIDE PEOPLE ONLY. This roster is for people who work for or represent "${name}" itself. For EVERY person, reason carefully about their affiliation from the sources — stated employer, email domain, job-title context, and how they are referred to — and set works_for_partner: "yes" (the sources show they work for ${name}), "no" (the sources show they work for a DIFFERENT company — for example ${us}, which is us, the team writing these notes; or a customer, prospect, or another vendor), or "unknown" (the sources do not say). Anyone marked "no" is excluded from the saved roster, so never mark "no" on a hunch — but a person the sources tie to another employer must be "no".
3. Copy each person's name EXACTLY as written in the source — same spelling, casing, accents, and word order. Never expand, shorten, or normalize a name.
4. Fill role, company, email, and phone ONLY when the source text states that value explicitly for that person; otherwise use "". Copy the value verbatim. You may use an email domain to reason about works_for_partner, but never to fill the company field. Never complete a partial email or phone number.
5. source_ids must list EVERY supplied source id in which the person's name appears, and ONLY supplied ids. A person "appears" in a source only when their name is written in that source's text.
6. If the same person appears in multiple sources, output ONE contact carrying all of their source_ids. Minor spelling variants of one person ("Jack Smith" vs "Jack Smiths", "Jon Smith" vs "John Smith") are the SAME person — never output them as two contacts; use the most complete correctly-spelled form that appears in a cited source, and cite every source where any variant appears. Only when the sources show two genuinely DIFFERENT people sharing a name (e.g. different companies or emails) output them separately with their own source_ids.
7. context: one short phrase (under 140 characters) copied verbatim from one cited source that shows this person being mentioned.
8. If the sources name no people at all, return an empty contacts array.

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
 * ungroundable contacts are dropped and reported in `dropped` — as are
 * people who fail the affiliation rule: anyone the model marks
 * works_for_partner:"no", anyone whose VERIFIED company doesn't match
 * `partnerName`, and anyone whose verified company is the CRM owner's own.
 *
 * @param {string} rawText
 * @param {object} options
 * @param {Array}  options.sources      The exact sources given to the prompt.
 * @param {string} [options.partnerName] Enables the company↔partner check.
 * @param {string} [options.ownCompany]  Defaults to CRM_OWNER_COMPANY.
 * @returns {{ contacts: Array, note: string, dropped: Array<{name, reason}> }}
 */
export function parsePartnerContactsResponse(rawText, { sources = [], partnerName = '', ownCompany = CRM_OWNER_COMPANY } = {}) {
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

    // Keep only cited sources that literally contain this person (a one-
    // character spelling variant of the name still counts — "Jack Smith"
    // verifies against a source that wrote "Jack Smiths").
    const email = dropPlaceholder(cleanStr(raw.email, MAX_EMAIL_LEN));
    const verified = [];
    const seenIds = new Set();
    for (const id of citedIds) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const src = sourceById.get(id);
      if (nameFoundInTextFuzzy(name, src.text) || (email && emailFoundInText(email, src.text))) {
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

    // Affiliation rule — partner-side people only. The model's judgment
    // can only EXCLUDE (never invent data), so it is safe to honor; the
    // company checks are deterministic and run on the VERIFIED value.
    const affiliation = String(raw.works_for_partner || '').trim().toLowerCase();
    if (affiliation === 'no') {
      dropped.push({ name, reason: `sources indicate they work for another company${rawCompany ? ` (${rawCompany})` : ''}, not the partner` });
      continue;
    }
    if (groundedCompany && isCrmOwnerCompany(groundedCompany, ownCompany)) {
      dropped.push({ name, reason: `works for ${groundedCompany} — the CRM owner's own team, not a partner contact` });
      continue;
    }
    if (groundedCompany && partnerName && !companyMatchesPartner(groundedCompany, partnerName)) {
      dropped.push({ name, reason: `works for "${groundedCompany}", not ${partnerName}` });
      continue;
    }

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

// Completeness order for duplicate matching: more real name tokens first,
// then longer names — so bare "Aaron" folds into "Aaron Adsit" no matter
// which order the mentions arrived in, and the fuller spelling is the one
// that survives as the record's name.
function nameCompleteness(c) {
  return substantiveTokenCount(c.name) * 1000 + String(c.name || '').length;
}

// The one place duplicate-candidate selection lives: an exact normalized
// name always wins; a similar name (namesLikelySamePerson) is trusted only
// when it is UNambiguous — exactly one candidate — so a bare "Aaron" with
// both "Aaron Adsit" and "Aaron Miller" on file stays separate rather than
// guessing. Emails must never contradict.
function findSamePersonTarget(candidates, contact) {
  const nameKey = normalizeForMatch(contact.name);
  if (!nameKey) return null;
  const same = candidates.filter(c =>
    emailsCompatible(c.email, contact.email) && namesLikelySamePerson(c.name, contact.name));
  const exact = same.find(c => normalizeForMatch(c.name) === nameKey);
  if (exact) return exact;
  return same.length === 1 ? same[0] : null;
}

// Collapse duplicate extracted contacts into one, unioning sources and
// filling blank fields. Match by email first, then by name — exact or
// similar ("Aaron" / "Aaron Adsit", "Jack Smith" / "Jack Smiths") — but
// never across two different emails, and never when a similar name could
// mean more than one already-seen person.
function dedupeExtracted(contacts) {
  const byEmail = new Map();
  const out = [];
  const ordered = [...contacts].sort((a, b) => nameCompleteness(b) - nameCompleteness(a));
  for (const c of ordered) {
    const emailKey = String(c.email || '').trim().toLowerCase();

    let target = (emailKey && byEmail.get(emailKey)) || null;
    if (!target) target = findSamePersonTarget(out, c);

    if (!target) {
      if (emailKey) byEmail.set(emailKey, c);
      out.push(c);
      continue;
    }
    for (const f of ['name', 'role', 'company', 'email', 'phone', 'evidence']) {
      if (!target[f] && c[f]) target[f] = c[f];
    }
    target.sources = unionSources(target.sources, c.sources);
    const mergedEmail = String(target.email || '').trim().toLowerCase();
    if (mergedEmail && !byEmail.has(mergedEmail)) byEmail.set(mergedEmail, target);
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
 * no-fabrication prompt, so rows are trusted as-is; this normalizes
 * placeholders, attaches the file as provenance, and applies the
 * affiliation rule: attendee lists routinely mix in our own team and
 * customer attendees, so a row whose stated company is the CRM owner's —
 * or, when `partnerName` is given, any company other than the partner's —
 * is not a partner contact and is skipped.
 */
export function attendeeContactsToExtracted(rawContacts, { docId, fileName, date, partnerName = '', ownCompany = CRM_OWNER_COMPANY } = {}) {
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
    const company = dropPlaceholder(cleanStr(raw.company, MAX_FIELD_LEN));
    if (company && isCrmOwnerCompany(company, ownCompany)) continue;
    if (company && partnerName && !companyMatchesPartner(company, partnerName)) continue;
    out.push({
      name,
      role: dropPlaceholder(cleanStr(raw.role, MAX_FIELD_LEN)),
      company,
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
 * name — exact first, then similar-name reasoning ("Aaron" / "Aaron Adsit",
 * "Jack Smith" / "Jack Smiths") when it is unambiguous and the emails don't
 * contradict — so a spelling variant of a saved person can never mint a
 * second row. Merging only FILLS BLANK fields and unions sources — it
 * never overwrites a saved value, so manual corrections always survive a
 * re-scan. The one exception is deliberate: a strictly FULLER form of the
 * same name upgrades the record ("Aaron" → "Aaron Adsit"); equal-length
 * variants keep the saved spelling. Unmatched contacts become new rows.
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
  const registry = [];
  const register = (c) => {
    const e = String(c.email || '').trim().toLowerCase();
    if (e && !byEmail.has(e)) byEmail.set(e, c);
    registry.push(c);
  };
  existing.forEach(register);

  const toAppend = [];
  const changedRows = new Set();
  let unchanged = 0;

  // Fuller names first, so "Aaron Adsit" lands before a bare "Aaron" that
  // should fold into it.
  const ordered = [...extracted].sort((a, b) => nameCompleteness(b) - nameCompleteness(a));
  for (const x of ordered) {
    const email = String(x.email || '').trim().toLowerCase();
    let target = (email && byEmail.get(email)) || null;
    if (!target) target = findSamePersonTarget(registry, x);

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
        if (f === 'email') { const ek = String(x.email).toLowerCase(); if (!byEmail.has(ek)) byEmail.set(ek, target); }
        changed = true;
      }
    }
    // Upgrade to a strictly fuller form of the same name ("Aaron" →
    // "Aaron Adsit"). Equal completeness never overwrites, so a manual
    // "Jack Smith" still wins over a scanned "Jack Smiths".
    if (x.name && target.name
        && substantiveTokenCount(x.name) > substantiveTokenCount(target.name)
        && namesLikelySamePerson(target.name, x.name)) {
      target.name = x.name;
      changed = true;
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
