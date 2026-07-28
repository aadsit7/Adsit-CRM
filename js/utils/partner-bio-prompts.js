// ============================================================
// Partner Bio prompt builder
// ============================================================
// Assembles the public-research prompt for one partner company: the researcher
// role, the fixed list of authoritative sources, Recast's value proposition,
// the research protocols (cross-reference validation, accuracy threshold,
// partner-fit classification, tailoring, rationale, self-assessment, plain
// language) and finally the strict JSON schema.
//
// The methodology below is the team's tuned partner-research brief, carried
// verbatim so the output is the same whether it is run here or by hand.
//
// The CRM row is the SEARCH SEED and nothing more. This prompt never presents
// a CRM field as a finding, and it never emits credentials, password hashes,
// usernames, contact emails or API keys — the only partner fields it reads are
// the five listed in buildSeedBlock().
// ============================================================

import { PARTNER_BIO_SCHEMA_EXAMPLE } from './partner-bio-schema.js';

/** The only websites the research may draw on, in priority order. */
export const AUTHORITATIVE_SOURCES = [
  'https://www.crunchbase.com',
  'https://www.linkedin.com',
  'https://www.sec.gov/edgar',
  'https://www.bloomberg.com',
  'https://www.hoovers.com',
  'https://www.glassdoor.com',
  'https://www.crn.com',
  'https://www.channelfutures.com',
  'https://isg-one.com',
  'https://news.google.com',
];

/**
 * The hostnames behind those sources, for the web-search tool's allowed_domains
 * filter. The tool matches on domain, so the scheme and path are dropped and
 * subdomains are included automatically (a bare "linkedin.com" also matches
 * "www.linkedin.com"). sec.gov is listed unpathed for the same reason — EDGAR
 * lives under it.
 */
export const AUTHORITATIVE_DOMAINS = [
  'crunchbase.com',
  'linkedin.com',
  'sec.gov',
  'bloomberg.com',
  'hoovers.com',
  'glassdoor.com',
  'crn.com',
  'channelfutures.com',
  'isg-one.com',
  'news.google.com',
];

/** Recast's value proposition, verbatim — the basis for the value sections. */
export const RECAST_VALUE_PROPOSITION =
  'Recast clears the application layer bottleneck that slows platform adoption, drags down '
  + 'managed-service margins, and derails modernization timelines. Platform and device partners '
  + 'see faster time-to-value, higher attach, and smoother rollouts; MSPs gain back engineering '
  + 'hours and boost per-customer margin; SIs get predictable packaging and validation that '
  + 'protects project timelines and profitability. In short, it accelerates usage, improves '
  + 'delivery reliability, and strengthens partner economics across the board.';

function orNone(v) { const s = String(v || '').trim(); return s || '(not recorded)'; }

// The CRM fields that seed the search. Explicitly enumerated — spreading the
// partner row here is how a password hash ends up in a prompt.
function buildSeedBlock(partner) {
  const p = partner || {};
  return [
    'SEARCH SEED (from our CRM — this is a STARTING POINT, NOT a finding):',
    `- Name as recorded: ${orNone(p.display_name)}`,
    `- Type as recorded: ${orNone(p.partner_type)}`,
    `- Region as recorded: ${orNone(p.region)}`,
    `- HQ as recorded: ${orNone(p.hq_location)}`,
    `- Tier as recorded: ${orNone(p.tier)}`,
    '',
    'Use these ONLY to find the right company. Never report a seed value as a',
    'verified result: every field in your answer must be confirmed against the',
    'authoritative sources below. If the sources contradict a seed value, follow',
    'the sources. If they cannot confirm it at all, the field is "NA" — even when',
    'the seed looks plausible. Our CRM tier and type are internal commercial',
    'labels and are never evidence of what the company actually is.',
  ].join('\n');
}

function buildSourceBlock() {
  const list = AUTHORITATIVE_SOURCES.map((u, i) => `${i + 1}. ${u}`).join('\n');
  return [
    'AUTHORITATIVE SOURCES — search exclusively these websites, in this order of priority:',
    list,
    '',
    'Your web search tool is already restricted to these domains, so a query that',
    'returns nothing means the answer is not on them — that is an "NA", not an',
    'invitation to fall back on general knowledge or another site.',
  ].join('\n');
}

function buildProtocolBlock() {
  return [
    'RESEARCH PROTOCOLS',
    '',
    '1. Cross-Reference Validation: for every data point (company name, headquarters,',
    '   employee count, business description) verify the information across at least',
    '   THREE of the sources above before including it. Where sources conflict,',
    '   prioritize the most recently updated authoritative source, in this order:',
    '   SEC filings, then Bloomberg, then LinkedIn.',
    '',
    '2. Accuracy Threshold: include only what you can verify with high confidence.',
    '   Where employee-count ranges vary between sources, use the most recent figure',
    '   and note the source and its date alongside it. Where headquarters information',
    '   differs, prioritize SEC filings or the official company LinkedIn page.',
    '   Anything you cannot establish to that standard is "NA". An honest NA is',
    '   worth more than a confident guess.',
    '',
    '3. Partnership Model Classification: determine and state the company\'s partner',
    '   fit category — SI (Systems Integrator), MSP (Managed Service Provider),',
    '   SI/MSP Hybrid, ISV/Technology Partner (platform or device vendor), OEM, or',
    '   Other — based on their core service offerings, how they engage customers,',
    '   and their operational structure as discovered in the research.',
    '',
    '4. Value Proposition Tailoring: from what the company actually does — their',
    '   business model, industry vertical and operational challenges — work out how',
    '   Recast\'s specific capabilities address their likely pain points. Reference',
    '   the partner category you assigned and tailor the value to that operating',
    '   model. Generic value statements that would fit any company are a failure.',
    '',
    '5. Partnership Rationale: explain why partnering with Recast makes strategic',
    '   sense for THIS company, based on the business model, growth trajectory,',
    '   technology stack and market position you found.',
    '',
    '6. Competency Self-Assessment: rate your own research competency from 8 to 10',
    '   on: source-verification completeness (how many sources confirmed each data',
    '   point), information recency, cross-reference consistency, and how well the',
    '   Recast value is tailored to this company\'s situation. Also report how many',
    '   sources confirmed each data point.',
    '',
    '7. Plain Language: write in clear, straightforward language anyone can',
    '   understand. Avoid corporate jargon, buzzwords, and phrasing that sounds',
    '   artificial or over-polished. Write as if explaining this to a colleague in a',
    '   professional conversation. Never use emojis or decorative symbols anywhere',
    '   in the output.',
  ].join('\n');
}

/**
 * Build the full Partner Bio research prompt.
 *
 * @param {object} params
 * @param {object} params.partner  The CRM partner row (search seed only).
 * @param {string} [params.today]  YYYY-MM-DD, so recency judgements are anchored.
 * @returns {string}
 */
export function buildPartnerBioPrompt({ partner, today = '' } = {}) {
  const name = String(partner && partner.display_name || '').trim() || 'the partner company';

  return `You are an expert business intelligence researcher specializing in B2B company profiling and partnership value analysis. You work exclusively with verified, authoritative sources to deliver research that meets the highest standards of factual accuracy. Your research will be used to evaluate a potential partnership with Recast, a company that clears application layer bottlenecks to accelerate platform adoption and improve managed-service delivery.

TASK
Research the company "${name}" by searching only the authoritative websites listed below, cross-reference every finding across multiple sources to confirm it is consistent and accurate, and produce a structured company profile that includes partnership value propositions specific to Recast's offerings.

CONTEXT
This output has to achieve absolute truth and accuracy (a minimum 8/10 competency rating) by validating every data point against multiple authoritative sources, so the reader gets only reliable, consistent information to make a partnership decision from.

${today ? `Today's date is ${today}. Judge recency against it, and prefer the most recently updated source when two disagree.\n\n` : ''}${buildSeedBlock(partner)}

${buildSourceBlock()}

RECAST VALUE PROPOSITION
"""${RECAST_VALUE_PROPOSITION}"""

${buildProtocolBlock()}

OUTPUT
Reply with ONE JSON object and nothing else — no preamble, no commentary, no markdown fences. The fields below mirror the required profile structure exactly; the application renders them. Any field you could not verify to the standard above must be the string "NA", and any bullet list you have no verified basis for must be an empty array — never filler.

${PARTNER_BIO_SCHEMA_EXAMPLE}

Field rules:
- "company_website" is the company's OWN website, a full https:// URL. A LinkedIn or Crunchbase page is not a website; if you only found those, the website is "NA".
- "company_linkedin_url" must be the company's own linkedin.com page URL, not a person's profile and not a search link.
- "number_of_employees" carries the figure AND where and when it came from, e.g. "11,000 (LinkedIn company page, March 2026)".
- "partner_fit_category" must be exactly one of: SI, MSP, SI/MSP Hybrid, ISV/Technology Partner, OEM, Other.
- "what_they_do" is three bullets: their core business; the products or services they offer; who their customers are and what problems they solve.
- "how_recast_brings_value" is four bullets: a specific operational challenge this company faces that Recast addresses; the concrete benefit Recast delivers given their business model; the measurable improvement they would see given their partner category; an additional advantage relevant to their market position.
- "why_partner" is three bullets: a strategic reason based on their current business direction; a practical benefit that aligns with their growth plans; the competitive advantage they would gain.
- "research_competency_rating" is a number between 8 and 10. "verification_level" is the number of sources that confirmed each data point.
- Plain sentences only. No emojis, no decorative symbols, no markdown formatting inside the strings.`;
}
