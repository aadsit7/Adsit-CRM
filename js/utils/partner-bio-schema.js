// ============================================================
// Partner Bio schema — shared between prompt builder, parser and storage
// ============================================================
// The Partner Bio is a PUBLIC-RESEARCH profile of the partner company: who
// they are, what they sell, and why Recast is worth partnering with. It is a
// different artifact from the Partner Analyzer, which scores the CRM
// relationship from our own notes — nothing here comes from the CRM except
// the company's name, which is only the search seed.
//
// Same shape as the sibling analyzers: one example string shown to the model,
// plus a STRICT parser that strips fences, extracts the JSON, validates every
// field and coerces anything malformed to a safe default. The parser — NOT the
// model — enforces correctness:
//   • unknown / placeholder / "n/a" values all collapse to the literal "NA",
//     which is what the research instructions require for anything that could
//     not be verified;
//   • URLs must parse and use http(s), or they become NA — a broken link in
//     the matrix is worse than an honest "NA". The LinkedIn field additionally
//     has to BE a linkedin.com URL, and the website field must not be one;
//   • the partner-fit category is canonicalized to the fixed set the
//     instructions allow, so the badge can never render a made-up label;
//   • emoji and decorative symbols are stripped everywhere (the instructions
//     forbid them, and the PDF/plain-text renderers assume they are absent);
//   • every string and list is length-bounded, which is also what keeps a
//     stored bio comfortably inside one Google Sheets cell (50k chars).
// ============================================================

// The balanced-object extractor (fence stripping + truncation salvage) is
// shared with the Contact Analyzer — one tested implementation, not two.
import { extractJsonObject } from './contact-analyzer-schema.js';

/** The value every unverified field carries, per the research instructions. */
export const NA = 'NA';

/** The partner-fit categories the output structure allows. */
export const PARTNER_BIO_FIT_CATEGORIES = [
  'SI', 'MSP', 'SI/MSP Hybrid', 'ISV/Technology Partner', 'OEM', 'Other',
];

// Field bounds. Generous enough for a real answer, tight enough that a stored
// bio is a few kilobytes rather than an essay.
const MAX_SHORT = 160;   // name, industry, HQ, employee count
const MAX_URL = 500;
const MAX_BULLET = 400;
const MAX_BULLETS = 8;

export const PARTNER_BIO_SCHEMA_EXAMPLE = `{
  "company_name": "string — the verified legal / trading name, or \\"NA\\"",
  "company_industry": "string — the industry sector, or \\"NA\\"",
  "company_website": "string — the full https:// URL of their own website, or \\"NA\\"",
  "company_linkedin_url": "string — the full https://www.linkedin.com/company/… URL, or \\"NA\\"",
  "headquarters": "string — \\"City, State/Country\\", or \\"NA\\"",
  "number_of_employees": "string — a specific number or range WITH the source date, e.g. \\"11,000 (LinkedIn, Mar 2026)\\", or \\"NA\\"",
  "partner_fit_category": "SI | MSP | SI/MSP Hybrid | ISV/Technology Partner | OEM | Other",
  "what_they_do": [
    "string — their core business",
    "string — the products or services they offer",
    "string — who their customers are and what problems they solve"
  ],
  "how_recast_brings_value": [
    "string — a specific operational challenge this company faces that Recast addresses",
    "string — the concrete benefit Recast delivers given their business model",
    "string — the measurable improvement they would see given their partner category",
    "string — an additional advantage relevant to their market position"
  ],
  "why_partner": [
    "string — a strategic reason based on their current business direction",
    "string — a practical benefit that aligns with their growth plans",
    "string — the competitive advantage they would gain"
  ],
  "research_competency_rating": 9.2,
  "verification_level": 3
}`;

// ── Small validators ────────────────────────────────────────────────

// Emoji, pictographs, dingbats, arrows and bullet glyphs. The instructions ban
// decorative symbols outright, so they are removed rather than trusted away.
// Punctuation the prose legitimately uses (em dash, curly quotes) is untouched.
const DECOR_RE = new RegExp(
  '['
  + '\\u2022\\u2023\\u25AA\\u25CF'   // bullet glyphs
  + '\\u2190-\\u21FF'                // arrows
  + '\\u2300-\\u23FF'                // technical / misc symbols
  + '\\u2600-\\u27BF'                // dingbats, misc symbols
  + '\\u2B00-\\u2BFF'                // arrows + geometric shapes
  + '\\uFE0F'                        // variation selector (emoji presentation)
  + '\\u{1F000}-\\u{1FAFF}'          // emoji / pictographs
  + ']',
  'gu',
);

// Values that mean "we could not verify this". Everything here becomes NA, so
// the UI shows one honest token instead of six spellings of nothing.
const NA_TOKENS = new Set([
  '', 'na', 'n/a', 'n.a.', 'none', 'null', 'undefined', 'unknown', 'not available',
  'not found', 'not applicable', 'not verified', 'tbd', '-', '--', '—', '–', '?',
]);

function clean(value, maxLen) {
  let s = String(value == null ? '' : value)
    .replace(DECOR_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  // The model sometimes echoes the template's own placeholder, e.g.
  // "[Verified name]" — that is not an answer.
  if (/^\[.*\]$/.test(s)) s = '';
  // Leading list markers survive when a bullet is returned as prose.
  s = s.replace(/^[-*]\s+/, '').trim();
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
}

/** A cleaned string, or the literal "NA" when it carries no information. */
function text(value, maxLen = MAX_SHORT) {
  const s = clean(value, maxLen);
  return NA_TOKENS.has(s.toLowerCase()) ? NA : s;
}

/**
 * A clickable http(s) URL, or NA. `reject` is a set of host suffixes that are
 * wrong for this particular field (a LinkedIn page is not a company website).
 */
function url(value, { requireHost = '', reject = [] } = {}) {
  const s = clean(value, MAX_URL);
  if (NA_TOKENS.has(s.toLowerCase())) return NA;
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return NA;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return NA;
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('.')) return NA;
  if (requireHost && host !== requireHost && !host.endsWith(`.${requireHost}`)) return NA;
  for (const bad of reject) {
    if (host === bad || host.endsWith(`.${bad}`)) return NA;
  }
  return parsed.href;
}

// Spellings of each allowed category that the model actually produces. Anything
// unrecognized but non-empty lands on "Other" — an honest bucket the output
// structure already defines — rather than being echoed back verbatim.
const FIT_ALIASES = new Map([
  ['si', 'SI'],
  ['systems integrator', 'SI'],
  ['system integrator', 'SI'],
  ['msp', 'MSP'],
  ['managed service provider', 'MSP'],
  ['managed services provider', 'MSP'],
  ['si/msp hybrid', 'SI/MSP Hybrid'],
  ['si/msp', 'SI/MSP Hybrid'],
  ['msp/si', 'SI/MSP Hybrid'],
  ['si msp hybrid', 'SI/MSP Hybrid'],
  ['hybrid', 'SI/MSP Hybrid'],
  ['isv/technology partner', 'ISV/Technology Partner'],
  ['isv', 'ISV/Technology Partner'],
  ['technology partner', 'ISV/Technology Partner'],
  ['technology', 'ISV/Technology Partner'],
  ['platform', 'ISV/Technology Partner'],
  ['platform vendor', 'ISV/Technology Partner'],
  ['device vendor', 'ISV/Technology Partner'],
  ['oem', 'OEM'],
  ['other', 'Other'],
]);

function fitCategory(value) {
  const s = clean(value, MAX_SHORT);
  if (NA_TOKENS.has(s.toLowerCase())) return NA;
  const key = s.toLowerCase().replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (FIT_ALIASES.has(key)) return FIT_ALIASES.get(key);
  const exact = PARTNER_BIO_FIT_CATEGORIES.find(c => c.toLowerCase() === key);
  return exact || 'Other';
}

/**
 * A bounded bullet list. Accepts an array (the schema) or a newline-separated
 * string (what a model returns when it forgets the schema), and
 * drops anything that survives cleaning as nothing.
 */
function bullets(value) {
  let items = [];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = value.split(/\r?\n/);
  const out = [];
  for (const item of items) {
    const s = clean(item, MAX_BULLET);
    if (!s || NA_TOKENS.has(s.toLowerCase())) continue;
    out.push(s);
    if (out.length >= MAX_BULLETS) break;
  }
  return out;
}

/**
 * The self-assessed competency rating, clamped to the 8-10 band the
 * instructions define and rounded to one decimal. Null when absent — the
 * renderers show NA, which is truer than inventing an 8.
 */
function rating(value) {
  const n = Number(String(value == null ? '' : value).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(10, Math.max(8, n)) * 10) / 10;
}

/** How many sources confirmed each data point — a small non-negative integer. */
function sourceCount(value) {
  const n = parseInt(String(value == null ? '' : value).replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 20);
}

/** An empty, fully-NA bio — the shape every consumer can rely on. */
export function emptyPartnerBio() {
  return {
    company_name: NA,
    company_industry: NA,
    company_website: NA,
    company_linkedin_url: NA,
    headquarters: NA,
    number_of_employees: NA,
    partner_fit_category: NA,
    what_they_do: [],
    how_recast_brings_value: [],
    why_partner: [],
    research_competency_rating: null,
    verification_level: null,
  };
}

/**
 * Validate one raw model reply into a stored bio.
 *
 * @param {string} text_ The model's final text block.
 * @param {object} [opts]
 * @param {string} [opts.partnerName] The CRM display name — used ONLY as the
 *   fallback company name when the research could not confirm one, so the
 *   record is still identifiable. It is never treated as verified research.
 * @returns {object} the validated bio
 * @throws {Error} when the reply carries no JSON object at all
 */
export function parsePartnerBioResponse(text_, { partnerName = '' } = {}) {
  const raw = extractJsonObject(text_);
  if (!raw || typeof raw !== 'object') {
    throw new Error('The research came back in a format the app could not read — try again.');
  }

  const bio = emptyPartnerBio();

  bio.company_name = text(raw.company_name);
  if (bio.company_name === NA) {
    const fallback = clean(partnerName, MAX_SHORT);
    if (fallback) bio.company_name = fallback;
  }
  bio.company_industry = text(raw.company_industry ?? raw.industry);
  bio.company_website = url(raw.company_website ?? raw.website, {
    // A LinkedIn or Crunchbase page is a profile OF the company, not the
    // company's own site — putting one here would make the matrix lie.
    reject: ['linkedin.com', 'crunchbase.com'],
  });
  bio.company_linkedin_url = url(raw.company_linkedin_url ?? raw.linkedin_url, {
    requireHost: 'linkedin.com',
  });
  bio.headquarters = text(raw.headquarters ?? raw.hq);
  bio.number_of_employees = text(raw.number_of_employees ?? raw.employee_count ?? raw.employees);
  bio.partner_fit_category = fitCategory(raw.partner_fit_category ?? raw.partner_fit);

  bio.what_they_do = bullets(raw.what_they_do);
  bio.how_recast_brings_value = bullets(raw.how_recast_brings_value ?? raw.recast_value);
  bio.why_partner = bullets(raw.why_partner ?? raw.why_partner_with_recast);

  bio.research_competency_rating = rating(raw.research_competency_rating ?? raw.competency_rating);
  bio.verification_level = sourceCount(raw.verification_level ?? raw.sources_confirmed);

  return bio;
}

/**
 * True when the research produced nothing usable — every field NA and every
 * list empty. The view refuses to save one of these: an all-NA card looks
 * like a bug, and re-running is the right response.
 */
export function partnerBioIsEmpty(bio) {
  if (!bio) return true;
  const hasField = [
    bio.company_industry, bio.company_website, bio.company_linkedin_url,
    bio.headquarters, bio.number_of_employees,
  ].some(v => v && v !== NA);
  const hasProse = (bio.what_they_do || []).length
    || (bio.how_recast_brings_value || []).length
    || (bio.why_partner || []).length;
  return !hasField && !hasProse;
}

// ── Plain-text / markdown rendering ─────────────────────────────────

function mdValue(v) {
  const s = String(v == null ? '' : v).trim();
  return s || NA;
}

function mdBullets(list) {
  const items = (list || []).filter(Boolean);
  return items.length ? items.map(b => `- ${b}`).join('\n') : `- ${NA}`;
}

/**
 * Render a stored bio as the exact markdown structure the research
 * instructions specify — same fields, same order, no commentary. This is what
 * the "Copy" action puts on the clipboard, so a bio can be pasted into a deal
 * note or an email without re-typing it.
 */
export function partnerBioToMarkdown(bio) {
  const b = bio || emptyPartnerBio();
  const rating_ = b.research_competency_rating == null ? NA : `${b.research_competency_rating}`;
  const sources = b.verification_level == null ? NA : `${b.verification_level}`;
  return [
    '---',
    '',
    `**Company name:** ${mdValue(b.company_name)}`,
    '',
    `**Company Industry:** ${mdValue(b.company_industry)}`,
    '',
    `**Company Website:** ${mdValue(b.company_website)}`,
    '',
    `**Company LinkedIn URL:** ${mdValue(b.company_linkedin_url)}`,
    '',
    `**Headquarters:** ${mdValue(b.headquarters)}`,
    '',
    `**Number of employees:** ${mdValue(b.number_of_employees)}`,
    '',
    `**Partner fit category:** ${mdValue(b.partner_fit_category)}`,
    '',
    '**What they do:**',
    mdBullets(b.what_they_do),
    '',
    '**How Recast brings value:**',
    mdBullets(b.how_recast_brings_value),
    '',
    '**Why partner:**',
    mdBullets(b.why_partner),
    '',
    '---',
    '',
    `**Research Competency Rating:** ${rating_}/10`,
    '',
    `**Verification level:** ${sources} sources confirmed each data point`,
    '',
  ].join('\n');
}

// ── Storage contract (the Partner_Bios tab) ─────────────────────────
// One row per partner. The flat columns exist so the spreadsheet is readable
// on its own — the matrix a person would want to see is right there — while
// bio_json carries the full record the app re-renders from. A bio bounded by
// the limits above is a few kilobytes, comfortably inside one cell.

export const PARTNER_BIO_HEADERS = [
  'partner_id', 'partner_name',
  'company_name', 'industry', 'website', 'linkedin_url',
  'headquarters', 'employee_count', 'partner_fit_category',
  'competency_rating', 'verification_level',
  'bio_json', 'researched_at', 'updated_at',
];

/** Flatten a bio record into the sheet row, in header order. */
export function partnerBioRowValues(record) {
  const r = record || {};
  const bio = r.bio || emptyPartnerBio();
  const cells = {
    partner_id: r.partner_id || '',
    partner_name: r.partner_name || '',
    company_name: bio.company_name || '',
    industry: bio.company_industry || '',
    website: bio.company_website || '',
    linkedin_url: bio.company_linkedin_url || '',
    headquarters: bio.headquarters || '',
    employee_count: bio.number_of_employees || '',
    partner_fit_category: bio.partner_fit_category || '',
    competency_rating: bio.research_competency_rating == null ? '' : String(bio.research_competency_rating),
    verification_level: bio.verification_level == null ? '' : String(bio.verification_level),
    bio_json: JSON.stringify(bio),
    researched_at: r.researched_at || '',
    updated_at: r.updated_at || '',
  };
  return PARTNER_BIO_HEADERS.map(h => String(cells[h] == null ? '' : cells[h]));
}

/**
 * Rehydrate a sheet row into a bio record. bio_json is the source of truth;
 * a row whose JSON is missing or corrupted (hand-edited in the spreadsheet,
 * truncated by an old write) still yields the matrix from its flat columns
 * rather than nothing at all.
 */
export function partnerBioFromRow(row) {
  const r = row || {};
  const cell = (k) => String(r[k] == null ? '' : r[k]).trim();

  let bio = null;
  const json = cell('bio_json');
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object') {
        bio = { ...emptyPartnerBio(), ...parsed };
        bio.what_they_do = bullets(parsed.what_they_do);
        bio.how_recast_brings_value = bullets(parsed.how_recast_brings_value);
        bio.why_partner = bullets(parsed.why_partner);
      }
    } catch { /* fall through to the flat columns */ }
  }
  if (!bio) {
    bio = emptyPartnerBio();
    bio.company_name = text(cell('company_name'));
    bio.company_industry = text(cell('industry'));
    bio.company_website = url(cell('website'), { reject: ['linkedin.com', 'crunchbase.com'] });
    bio.company_linkedin_url = url(cell('linkedin_url'), { requireHost: 'linkedin.com' });
    bio.headquarters = text(cell('headquarters'));
    bio.number_of_employees = text(cell('employee_count'));
    bio.partner_fit_category = fitCategory(cell('partner_fit_category'));
    bio.research_competency_rating = rating(cell('competency_rating'));
    bio.verification_level = sourceCount(cell('verification_level'));
  }

  return {
    _rowIndex: r._rowIndex,
    partner_id: cell('partner_id'),
    partner_name: cell('partner_name'),
    researched_at: cell('researched_at'),
    updated_at: cell('updated_at'),
    bio,
  };
}

/** The saved bio for one partner, or null. Strictly matched on partner_id. */
export function selectPartnerBioRow(rows, partnerId) {
  const id = String(partnerId || '').trim();
  if (!id) return null;
  const matches = (rows || []).filter(r => String(r && r.partner_id || '').trim() === id);
  if (matches.length === 0) return null;
  // Newest wins if an older deployment ever appended a second row.
  matches.sort((a, b) => (Date.parse(b.researched_at || '') || 0) - (Date.parse(a.researched_at || '') || 0));
  return partnerBioFromRow(matches[0]);
}
