// ============================================
// Open-Item Intent Detection & Deterministic Matching
// ============================================
// Detects when the user asks Randy to OPEN something that already exists —
// a document attached to an opportunity (Drive file) or a description note
// (Opportunity_Descriptions entry) — and resolves WHICH one they mean.
//
// Accuracy contract: the LLM is never trusted to pick a doc_id or note.
// Detection here is pattern-matched, and resolution (matchDocuments /
// resolveDescriptionTarget) is pure deterministic scoring over the real
// records. Anything ambiguous surfaces as multiple candidates so Randy
// asks the user instead of guessing.
//
// Pure functions, no browser deps — unit tested in
// tests/open-item-intent.test.mjs.

// ── Grammar pieces ────────────────────────────────────────────────
// Opening verbs only. Creation verbs (create/generate/build/make) are
// deliberately absent so this never shadows the MAP/Timeline PDF flows.
const OPEN_VERBS = String.raw`(?:open(?:\s+up)?|pull\s+up|bring\s+up|show\s+me|show\s+us|view|display|get\s+me|look\s+at)`;

// Note nouns are tested FIRST — "description note" must win over the
// generic document nouns, and "meeting recap" over "recap pdf".
const NOTE_NOUNS = String.raw`(?:description\s+notes?|meeting\s+recaps?|meeting\s+notes?|opportunity\s+notes?|descriptions?|notes?)`;
const DOC_NOUNS = String.raw`(?:documents?|docs?|files?|pdfs?|attachments?|spreadsheets?|presentations?|decks?)`;

// verb → (articles) → pre-descriptor → noun → post text. The middle is
// capped and stops at sentence punctuation so a verb early in a long
// sentence can't pair with a noun three clauses later.
const NOTE_RE = new RegExp(
  `\\b${OPEN_VERBS}\\b\\s+(?:the\\s+|a\\s+|an\\s+|that\\s+|my\\s+|our\\s+)?([^.?!]{0,80}?)\\b(${NOTE_NOUNS})\\b([^.?!]*)`, 'i');
const DOC_RE = new RegExp(
  `\\b${OPEN_VERBS}\\b\\s+(?:the\\s+|a\\s+|an\\s+|that\\s+|my\\s+|our\\s+)?([^.?!]{0,80}?)\\b(${DOC_NOUNS})\\b([^.?!]*)`, 'i');

// Words that trail an opportunity hint ("ANICO deal" → "ANICO").
const TRAILING_QUALIFIERS = /\s+(?:opportunity|opportunities|deal|deals|account|accounts|now|please|boss|thanks)\s*$/i;

// Pronouns / generic words that can never be an opportunity name.
const NON_OPP_HINTS = /^(?:it|that|this|them|me|us|him|her|the|a|an)$/i;

function cleanOppHint(raw) {
  if (!raw) return null;
  let s = raw.trim().replace(/^(?:the|a|an|my|our)\s+/i, '').replace(/[.?!,;:]+$/g, '').trim();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(TRAILING_QUALIFIERS, '').trim();
    if (next === s) break;
    s = next;
  }
  if (!s || NON_OPP_HINTS.test(s)) return null;
  return s;
}

// Find the LAST "for/on/in/under <name>" clause — "open the notes on
// pricing for ANICO" must yield "ANICO", not "pricing for ANICO". The
// clause is cut short at "from"/"dated" so date phrases ("the note for
// ANICO from April 22") don't bleed into the opportunity name.
function extractOppAndRemainder(text) {
  const markers = [...text.matchAll(/\b(?:for|on|in|under)\b/gi)];
  for (let i = markers.length - 1; i >= 0; i--) {
    const start = markers[i].index;
    const clause = text.slice(start).match(
      /^(?:for|on|in|under)\s+(?:the\s+)?([^.?!,;:]+?)(?=\s+(?:from|dated)\b|[.?!,;:]|$)/i);
    if (!clause) continue;
    const opp = cleanOppHint(clause[1]);
    if (!opp) continue;
    const remainder = (text.slice(0, start) + ' ' + text.slice(start + clause[0].length)).trim();
    return { opp, remainder };
  }
  return { opp: null, remainder: text };
}

/**
 * Detect "open an existing document / description note" intent.
 *
 * @param {string} userMessage
 * @returns {{ triggered: boolean, itemType: 'document'|'note'|null,
 *             opportunityHint: string|null, itemHint: string|null }}
 */
export function detectOpenItemIntent(userMessage) {
  const none = { triggered: false, itemType: null, opportunityHint: null, itemHint: null };
  if (!userMessage || typeof userMessage !== 'string') return none;
  const msg = userMessage.trim();

  for (const [re, itemType] of [[NOTE_RE, 'note'], [DOC_RE, 'document']]) {
    const m = msg.match(re);
    if (!m) continue;
    const pre = (m[1] || '').trim();
    // "open a new map pdf" is a creation ask, not an open ask — let the
    // MAP/Timeline flows (or Claude) handle it.
    if (/\bnew\b/i.test(pre)) continue;
    const noun = (m[2] || '').trim();
    const post = (m[3] || '').trim();

    const { opp, remainder } = extractOppAndRemainder(post);
    const itemHint = [pre, noun, remainder]
      .join(' ')
      .replace(/\b(?:called|named|titled)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim() || null;
    return { triggered: true, itemType, opportunityHint: opp, itemHint };
  }
  return none;
}

// ── Shared text helpers ───────────────────────────────────────────

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripExt(name) {
  return String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
}

// Filler words carrying no identity — safe to drop from a document /
// note descriptor before matching.
const HINT_STOPWORDS = new Set([
  'the', 'a', 'an', 'that', 'this', 'my', 'our', 'me', 'us', 'up',
  'latest', 'newest', 'most', 'recent', 'last', 'first', 'oldest', 'earliest', 'original',
  'document', 'documents', 'doc', 'docs', 'file', 'files',
  'attachment', 'attachments', 'copy', 'version',
  'description', 'descriptions', 'note', 'notes',
  'for', 'of', 'on', 'in', 'under', 'from', 'please', 'boss', 'randy',
]);

/**
 * Content-bearing tokens of a hint (stopwords removed). Empty array means
 * the hint carries no identity ("the latest doc") — callers must not use
 * it for name lookups.
 */
export function contentTokens(hint) {
  return normalizeText(hint).split(' ').filter(t => t && !HINT_STOPWORDS.has(t));
}

/**
 * True when a hint genuinely mentions an opportunity name (normalized
 * containment either way). Used to reject acronym-tier lookups when the
 * opportunity name was only guessed from descriptor words.
 */
export function hintMentionsName(hint, name) {
  const hNorm = normalizeText(hint);
  const nNorm = normalizeText(name);
  if (hNorm.length < 3 || nNorm.length < 3) return false;
  return hNorm.includes(nNorm) || nNorm.includes(hNorm);
}

/**
 * Remove the resolved opportunity's name words from an item hint, so
 * "ANICO pricing doc" matches files by "pricing" once ANICO is resolved.
 */
export function stripOpportunityTokens(hint, names) {
  let out = ' ' + normalizeText(hint) + ' ';
  for (const name of (names || []).filter(Boolean)) {
    const nNorm = normalizeText(name);
    if (!nNorm) continue;
    if (out.includes(' ' + nNorm + ' ')) {
      out = out.split(' ' + nNorm + ' ').join(' ');
      continue;
    }
    for (const tok of nNorm.split(' ')) {
      if (tok.length >= 3 && out.includes(' ' + tok + ' ')) {
        out = out.split(' ' + tok + ' ').join(' ');
      }
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ── Document matching ─────────────────────────────────────────────

// "open the pdf / the spreadsheet" — filter by file type before name
// matching. Order matters: first pattern that appears in the hint wins.
const TYPE_FILTERS = [
  [/\bpdfs?\b/i, ['.pdf']],
  [/\b(?:word\s+doc(?:ument)?s?|docx)\b/i, ['.doc', '.docx']],
  [/\b(?:excel|spreadsheets?|xlsx?)\b/i, ['.xls', '.xlsx']],
  [/\b(?:powerpoint|presentations?|decks?|pptx?)\b/i, ['.pptx']],
  [/\b(?:images?|pictures?|photos?|screenshots?|png|jpe?g)\b/i, ['.png', '.jpg', '.jpeg']],
];

const WANTS_LATEST = /\b(?:latest|newest|most\s+recent|last)\b/i;

function newestFirst(files) {
  return [...files].sort((a, b) =>
    (Date.parse(b.date_added || '') || 0) - (Date.parse(a.date_added || '') || 0));
}

function tokenInName(token, nameTokens) {
  return nameTokens.some(nt =>
    nt === token ||
    (token.length >= 4 && nt.startsWith(token)) ||
    (nt.length >= 4 && token.startsWith(nt)));
}

/**
 * Deterministically match Drive files against a spoken descriptor.
 * Tiers: exact normalized name → substring containment → token overlap
 * (best-score set only). Returns [] when nothing plausibly matches,
 * one file when unambiguous, several when the user must pick.
 *
 * @param {Array<{file_name: string, date_added?: string}>} files
 * @param {string} rawHint
 */
export function matchDocuments(files, rawHint) {
  const all = files || [];
  if (all.length === 0) return [];
  const hint = String(rawHint || '').trim();
  const wantsLatest = WANTS_LATEST.test(hint);

  // Type filter first ("the pdf", "the spreadsheet").
  let pool = all;
  let hintForTokens = hint;
  for (const [re, exts] of TYPE_FILTERS) {
    if (!re.test(hint)) continue;
    const filtered = pool.filter(f =>
      exts.some(ext => String(f.file_name || '').toLowerCase().endsWith(ext)));
    if (filtered.length > 0) pool = filtered;
    hintForTokens = hintForTokens.replace(re, ' ');
    break;
  }

  const pickLatestIfWanted = (list) =>
    (wantsLatest && list.length > 1) ? [newestFirst(list)[0]] : list;

  const tokens = contentTokens(hintForTokens);
  if (tokens.length === 0) {
    // No content words — "open the latest pdf" / "open the document".
    if (wantsLatest) return [newestFirst(pool)[0]];
    return pool;
  }

  const joined = tokens.join(' ');

  const exact = pool.filter(f => {
    const base = normalizeText(stripExt(f.file_name));
    return base === joined || normalizeText(f.file_name) === joined;
  });
  if (exact.length > 0) return pickLatestIfWanted(exact);

  const contains = pool.filter(f => {
    const base = normalizeText(stripExt(f.file_name));
    return base.includes(joined) || (base.length >= 3 && joined.includes(base));
  });
  if (contains.length > 0) return pickLatestIfWanted(contains);

  const scored = pool
    .map(f => {
      const nameTokens = normalizeText(stripExt(f.file_name)).split(' ').filter(Boolean);
      const matched = tokens.filter(t => tokenInName(t, nameTokens)).length;
      return { f, score: matched / tokens.length };
    })
    .filter(x => x.score > 0);
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map(x => x.score));
  return pickLatestIfWanted(scored.filter(x => x.score === best).map(x => x.f));
}

// ── Description-note resolution ───────────────────────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

function monthIndexOf(word) {
  const w = String(word || '').toLowerCase();
  const idx = MONTHS.findIndex(m => m === w || (w.length >= 3 && m.startsWith(w)));
  return idx;
}

/**
 * Parse a spoken/typed date fragment. Returns {year?, month?, day?}
 * (month 0-based) or null when the hint contains no date. Handles
 * "April 22nd", "22nd of April 2026", "4/22", "2026-04-22", bare "April".
 */
export function parseSpokenDate(hint) {
  const s = String(hint || '').toLowerCase();

  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return { year: +m[1], month: +m[2] - 1, day: +m[3] };

  m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const year = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null;
    return { year, month: +m[1] - 1, day: +m[2] };
  }

  const monthRe = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b\.?/i;

  // "22nd of April 2026"
  m = s.match(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?` + monthRe.source + String.raw`(?:\s+(\d{4}))?`, 'i'));
  if (m) {
    const month = monthIndexOf(m[2]);
    if (month >= 0) return { year: m[3] ? +m[3] : null, month, day: +m[1] };
  }

  // "April 22nd, 2026" / "April 2026" / "April"
  m = s.match(new RegExp(monthRe.source + String.raw`\s*(?:(\d{1,2})(?:st|nd|rd|th)?)?(?:,?\s+(\d{4}))?`, 'i'));
  if (m) {
    const month = monthIndexOf(m[1]);
    if (month >= 0) {
      return {
        year: m[3] ? +m[3] : null,
        month,
        day: m[2] ? +m[2] : null,
      };
    }
  }
  return null;
}

// Year/month/day of a stored date string without timezone drift:
// ISO "YYYY-MM-DD..." is read literally; anything else goes through
// Date with local getters (formatted dates parse to local midnight).
function ymdOf(dateStr) {
  const s = String(dateStr || '');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { year: +m[1], month: +m[2] - 1, day: +m[3] };
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

/** Human/speech-friendly date, e.g. "April 22, 2026". */
export function formatSpokenDate(dateStr) {
  const ymd = ymdOf(dateStr);
  if (!ymd) return String(dateStr || '');
  const month = MONTHS[ymd.month] || '';
  const cap = month.charAt(0).toUpperCase() + month.slice(1);
  return `${cap} ${ymd.day}, ${ymd.year}`;
}

/**
 * Pick which description note the user means.
 *
 * @param {Array<{date: string, text: string, category?: string}>} descriptions
 *   Newest-first (the order getOpportunityDescription returns).
 * @param {string} rawHint
 * @returns {{index: number, defaulted?: boolean} | {candidates: number[]} | {none: true}}
 */
export function resolveDescriptionTarget(descriptions, rawHint) {
  const n = (descriptions || []).length;
  if (n === 0) return { none: true };
  const hint = String(rawHint || '').trim();

  if (!hint) return n > 1 ? { index: 0, defaulted: true } : { index: 0 };
  if (WANTS_LATEST.test(hint) || /\brecent\b/i.test(hint)) return { index: 0 };
  if (/\b(?:first|oldest|earliest|original)\b/i.test(hint)) return { index: n - 1 };

  // Hint made only of filler words ("the description note") — same as
  // no hint at all: default to the latest, flagged so the caller can
  // mention how many others exist.
  if (contentTokens(hint).length === 0 && !parseSpokenDate(hint)) {
    return n > 1 ? { index: 0, defaulted: true } : { index: 0 };
  }

  // Date phrases take priority — they're the most precise identifier.
  const dateQ = parseSpokenDate(hint);
  if (dateQ) {
    const hits = [];
    descriptions.forEach((d, i) => {
      const ymd = ymdOf(d.date);
      if (!ymd) return;
      if (dateQ.year != null && ymd.year !== dateQ.year) return;
      if (dateQ.month != null && ymd.month !== dateQ.month) return;
      if (dateQ.day != null && ymd.day !== dateQ.day) return;
      hits.push(i);
    });
    if (hits.length === 1) return { index: hits[0] };
    if (hits.length > 1) return { candidates: hits };
    return { none: true };
  }

  // Category: "the meeting recap" / "the opportunity note". Newest wins
  // (input is newest-first). Falls through to keywords when no note
  // carries that category.
  if (/\bmeeting\s+(?:recap|notes?)\b/i.test(hint)) {
    const idx = descriptions.findIndex(d => d.category === 'meeting_recap');
    if (idx >= 0) return { index: idx };
  }
  if (/\bopportunity\s+notes?\b/i.test(hint)) {
    const idx = descriptions.findIndex(d => d.category === 'opportunity_note');
    if (idx >= 0) return { index: idx };
  }

  // Keyword match against note content — best-score set only.
  const tokens = contentTokens(hint).filter(t => !/^meeting$|^recap$|^recaps$/.test(t));
  if (tokens.length > 0) {
    const scored = descriptions
      .map((d, i) => {
        const body = ' ' + normalizeText(d.text) + ' ';
        const matched = tokens.filter(t => body.includes(' ' + t) || body.includes(t + ' ')).length;
        return { i, score: matched / tokens.length };
      })
      .filter(x => x.score > 0);
    if (scored.length > 0) {
      const best = Math.max(...scored.map(x => x.score));
      const hits = scored.filter(x => x.score === best).map(x => x.i);
      return hits.length === 1 ? { index: hits[0] } : { candidates: hits };
    }
  }

  return { none: true };
}

// ── Follow-up pick parsing ("the second one", "number 3") ────────

const ORDINAL_WORDS = [
  ['first', '1st'], ['second', '2nd'], ['third', '3rd'], ['fourth', '4th'],
  ['fifth', '5th'], ['sixth', '6th'], ['seventh', '7th'], ['eighth', '8th'],
  ['ninth', '9th'], ['tenth', '10th'],
];

/**
 * Parse an ordinal pick out of a follow-up reply. Returns a 0-based
 * index into a list of `count` items, or -1 when the reply isn't an
 * ordinal pick.
 */
export function parseOrdinalPick(text, count) {
  const lower = String(text || '').toLowerCase();
  if (!count || count < 1) return -1;
  if (/\b(?:last|bottom)\s+(?:one|doc|document|file|note)?\b/.test(lower) || /\bthe\s+last\b/.test(lower)) {
    return count - 1;
  }
  for (let i = 0; i < ORDINAL_WORDS.length && i < count; i++) {
    if (ORDINAL_WORDS[i].some(w => new RegExp(`\\b${w}\\b`).test(lower))) return i;
  }
  const m = lower.match(/\b(?:number\s+)?(\d{1,2})\b/);
  if (m) {
    const idx = +m[1] - 1;
    if (idx >= 0 && idx < count) return idx;
  }
  if (/^\s*(?:the\s+)?one\s*\.?\s*$/.test(lower)) return 0;
  return -1;
}
