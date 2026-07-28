// Tests for the Partner Bio parser, markdown renderer and storage contract
// (js/utils/partner-bio-schema.js). The parser — not the model — is what
// guarantees the panel never shows a broken link, a made-up partner category,
// an emoji, or a confident-looking value that was never verified.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NA,
  PARTNER_BIO_HEADERS,
  PARTNER_BIO_FIT_CATEGORIES,
  emptyPartnerBio,
  parsePartnerBioResponse,
  partnerBioIsEmpty,
  partnerBioToMarkdown,
  partnerBioRowValues,
  partnerBioFromRow,
  selectPartnerBioRow,
} from '../js/utils/partner-bio-schema.js';

const GOOD = {
  company_name: 'Insight Enterprises, Inc.',
  company_industry: 'IT solutions and services',
  company_website: 'https://www.insight.com',
  company_linkedin_url: 'https://www.linkedin.com/company/insight',
  headquarters: 'Chandler, Arizona, USA',
  number_of_employees: '13,000 (LinkedIn company page, March 2026)',
  partner_fit_category: 'SI/MSP Hybrid',
  what_they_do: ['Reseller and services provider', 'Hardware, software and managed services', 'Mid-market and enterprise IT teams'],
  how_recast_brings_value: ['Packaging backlog', 'Fewer engineering hours per customer', 'Higher per-customer margin', 'Faster rollouts'],
  why_partner: ['Services mix is growing', 'Protects project timelines', 'Differentiates their managed desktop offer'],
  research_competency_rating: 9.1,
  verification_level: 3,
};

const asReply = (obj) => JSON.stringify(obj);

// ── Happy path ───────────────────────────────────────────────────────
test('parses a well-formed reply and keeps every verified field', () => {
  const bio = parsePartnerBioResponse(asReply(GOOD));
  assert.equal(bio.company_name, 'Insight Enterprises, Inc.');
  assert.equal(bio.company_industry, 'IT solutions and services');
  assert.equal(bio.company_website, 'https://www.insight.com/');
  assert.equal(bio.company_linkedin_url, 'https://www.linkedin.com/company/insight');
  assert.equal(bio.headquarters, 'Chandler, Arizona, USA');
  assert.match(bio.number_of_employees, /13,000/);
  assert.equal(bio.partner_fit_category, 'SI/MSP Hybrid');
  assert.equal(bio.what_they_do.length, 3);
  assert.equal(bio.how_recast_brings_value.length, 4);
  assert.equal(bio.why_partner.length, 3);
  assert.equal(bio.research_competency_rating, 9.1);
  assert.equal(bio.verification_level, 3);
  assert.equal(partnerBioIsEmpty(bio), false);
});

test('reads JSON out of a fenced reply with surrounding prose', () => {
  const reply = `Here is the profile.\n\n\`\`\`json\n${asReply(GOOD)}\n\`\`\`\n\nLet me know if you need more.`;
  const bio = parsePartnerBioResponse(reply);
  assert.equal(bio.company_name, 'Insight Enterprises, Inc.');
});

test('repairs a reply cut off at the token limit', () => {
  const full = asReply(GOOD);
  const bio = parsePartnerBioResponse(full.slice(0, full.indexOf('"why_partner"') + 40));
  assert.equal(bio.company_name, 'Insight Enterprises, Inc.');
  assert.equal(bio.headquarters, 'Chandler, Arizona, USA');
});

test('a reply with no JSON at all throws rather than saving nothing', () => {
  assert.throws(() => parsePartnerBioResponse('I could not find this company.'), /could not read/i);
});

// ── NA discipline ────────────────────────────────────────────────────
test('unknown, placeholder and blank values all collapse to NA', () => {
  const bio = parsePartnerBioResponse(asReply({
    ...GOOD,
    company_industry: 'Unknown',
    headquarters: '[City, State/Country]',
    number_of_employees: '   ',
    company_website: 'n/a',
  }));
  assert.equal(bio.company_industry, NA);
  assert.equal(bio.headquarters, NA);
  assert.equal(bio.number_of_employees, NA);
  assert.equal(bio.company_website, NA);
});

test('a fully unverified profile is reported as empty', () => {
  const bio = parsePartnerBioResponse(asReply({
    company_name: 'NA', company_industry: 'NA', company_website: 'NA',
    company_linkedin_url: 'NA', headquarters: 'NA', number_of_employees: 'NA',
    partner_fit_category: 'NA', what_they_do: [], how_recast_brings_value: [], why_partner: [],
  }));
  assert.equal(partnerBioIsEmpty(bio), true);
});

test('the CRM name is only a fallback for an unverified company name', () => {
  const bio = parsePartnerBioResponse(asReply({ ...GOOD, company_name: 'NA' }), { partnerName: 'Insight' });
  assert.equal(bio.company_name, 'Insight');
  // …and never overrides a verified one.
  const verified = parsePartnerBioResponse(asReply(GOOD), { partnerName: 'Something Else' });
  assert.equal(verified.company_name, 'Insight Enterprises, Inc.');
});

// ── URLs ─────────────────────────────────────────────────────────────
test('unusable URLs become NA instead of broken links', () => {
  const bio = parsePartnerBioResponse(asReply({
    ...GOOD,
    company_website: 'not a url',
    company_linkedin_url: 'see their LinkedIn page',
  }));
  assert.equal(bio.company_website, NA);
  assert.equal(bio.company_linkedin_url, NA);
});

test('a javascript: URL is rejected', () => {
  const bio = parsePartnerBioResponse(asReply({ ...GOOD, company_website: 'javascript:alert(1)' }));
  assert.equal(bio.company_website, NA);
});

test('a LinkedIn or Crunchbase page is not accepted as the company website', () => {
  const li = parsePartnerBioResponse(asReply({ ...GOOD, company_website: 'https://www.linkedin.com/company/insight' }));
  assert.equal(li.company_website, NA);
  const cb = parsePartnerBioResponse(asReply({ ...GOOD, company_website: 'https://www.crunchbase.com/organization/insight' }));
  assert.equal(cb.company_website, NA);
});

test('the LinkedIn field must be a linkedin.com URL', () => {
  const bio = parsePartnerBioResponse(asReply({ ...GOOD, company_linkedin_url: 'https://www.insight.com/about' }));
  assert.equal(bio.company_linkedin_url, NA);
});

test('a bare domain is normalized to an https URL', () => {
  const bio = parsePartnerBioResponse(asReply({ ...GOOD, company_website: 'insight.com' }));
  assert.equal(bio.company_website, 'https://insight.com/');
});

// ── Partner fit category ─────────────────────────────────────────────
test('partner fit categories are canonicalized to the allowed set', () => {
  const cases = [
    ['msp', 'MSP'],
    ['Managed Service Provider', 'MSP'],
    ['systems integrator', 'SI'],
    ['MSP/SI', 'SI/MSP Hybrid'],
    ['Technology Partner', 'ISV/Technology Partner'],
    ['oem', 'OEM'],
    ['Distributor', 'Other'],
  ];
  for (const [input, expected] of cases) {
    const bio = parsePartnerBioResponse(asReply({ ...GOOD, partner_fit_category: input }));
    assert.equal(bio.partner_fit_category, expected, `${input} → ${expected}`);
    assert.ok(PARTNER_BIO_FIT_CATEGORIES.includes(bio.partner_fit_category));
  }
});

// ── Bullets, rating, decoration ──────────────────────────────────────
test('bullets accept a newline string and drop empties and list markers', () => {
  const bio = parsePartnerBioResponse(asReply({
    ...GOOD,
    what_they_do: '- Sells hardware\n\n- Runs managed services\n   \n- Serves mid-market IT',
  }));
  assert.deepEqual(bio.what_they_do, ['Sells hardware', 'Runs managed services', 'Serves mid-market IT']);
});

test('emojis and decorative symbols are stripped from every field', () => {
  const bio = parsePartnerBioResponse(asReply({
    ...GOOD,
    company_industry: '🚀 IT solutions ✅',
    what_they_do: ['• Sells hardware → to enterprises'],
  }));
  assert.equal(bio.company_industry, 'IT solutions');
  assert.equal(bio.what_they_do[0], 'Sells hardware to enterprises');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(JSON.stringify(bio)));
});

test('the competency rating is clamped to the 8-10 band, and missing means null', () => {
  assert.equal(parsePartnerBioResponse(asReply({ ...GOOD, research_competency_rating: 4 })).research_competency_rating, 8);
  assert.equal(parsePartnerBioResponse(asReply({ ...GOOD, research_competency_rating: 12 })).research_competency_rating, 10);
  assert.equal(parsePartnerBioResponse(asReply({ ...GOOD, research_competency_rating: '9.25/10' })).research_competency_rating, 9.3);
  assert.equal(parsePartnerBioResponse(asReply({ ...GOOD, research_competency_rating: null })).research_competency_rating, null);
});

test('verification level accepts a sentence and yields a count', () => {
  const bio = parsePartnerBioResponse(asReply({ ...GOOD, verification_level: '4 sources confirmed each data point' }));
  assert.equal(bio.verification_level, 4);
});

// ── Markdown rendering ───────────────────────────────────────────────
test('markdown follows the required output structure', () => {
  const md = partnerBioToMarkdown(parsePartnerBioResponse(asReply(GOOD)));
  for (const label of [
    '**Company name:**', '**Company Industry:**', '**Company Website:**',
    '**Company LinkedIn URL:**', '**Headquarters:**', '**Number of employees:**',
    '**Partner fit category:**', '**What they do:**', '**How Recast brings value:**',
    '**Why partner:**', '**Research Competency Rating:**', '**Verification level:**',
  ]) {
    assert.ok(md.includes(label), `missing ${label}`);
  }
  assert.ok(md.includes('- Reseller and services provider'));
  assert.ok(md.includes('9.1/10'));
  assert.ok(md.includes('3 sources confirmed each data point'));
});

test('an empty bio still renders the structure, with NA throughout', () => {
  const md = partnerBioToMarkdown(emptyPartnerBio());
  assert.ok(md.includes('**Company name:** NA'));
  assert.ok(md.includes('**Research Competency Rating:** NA/10'));
});

// ── Storage round-trip ───────────────────────────────────────────────
test('row values follow the header order and round-trip back', () => {
  const bio = parsePartnerBioResponse(asReply(GOOD));
  const record = {
    partner_id: 'p1', partner_name: 'Insight', bio,
    researched_at: '2026-07-28T10:00:00.000Z', updated_at: '2026-07-28T10:00:00.000Z',
  };
  const values = partnerBioRowValues(record);
  assert.equal(values.length, PARTNER_BIO_HEADERS.length);

  const row = {};
  PARTNER_BIO_HEADERS.forEach((h, i) => { row[h] = values[i]; });
  const back = partnerBioFromRow(row);
  assert.equal(back.partner_id, 'p1');
  assert.equal(back.researched_at, '2026-07-28T10:00:00.000Z');
  assert.deepEqual(back.bio.what_they_do, bio.what_they_do);
  assert.equal(back.bio.company_linkedin_url, bio.company_linkedin_url);
  assert.equal(back.bio.research_competency_rating, 9.1);
});

test('a row whose JSON is corrupted still yields the matrix from its columns', () => {
  const row = {
    partner_id: 'p1', partner_name: 'Insight',
    company_name: 'Insight Enterprises, Inc.', industry: 'IT solutions',
    website: 'https://www.insight.com', linkedin_url: 'https://www.linkedin.com/company/insight',
    headquarters: 'Chandler, Arizona, USA', employee_count: '13,000',
    partner_fit_category: 'SI/MSP Hybrid', competency_rating: '9', verification_level: '3',
    bio_json: '{ this is not json',
    researched_at: '2026-07-28T10:00:00.000Z', updated_at: '',
  };
  const back = partnerBioFromRow(row);
  assert.equal(back.bio.company_name, 'Insight Enterprises, Inc.');
  assert.equal(back.bio.partner_fit_category, 'SI/MSP Hybrid');
  assert.equal(back.bio.research_competency_rating, 9);
  assert.deepEqual(back.bio.what_they_do, []);
});

test('a bio is selected strictly by partner_id, newest first', () => {
  const rows = [
    { partner_id: 'p2', bio_json: JSON.stringify({ company_name: 'Other Co' }), researched_at: '2026-07-01T00:00:00Z' },
    { partner_id: 'p1', bio_json: JSON.stringify({ company_name: 'Old Pass' }), researched_at: '2026-06-01T00:00:00Z' },
    { partner_id: 'p1', bio_json: JSON.stringify({ company_name: 'New Pass' }), researched_at: '2026-07-20T00:00:00Z' },
  ];
  assert.equal(selectPartnerBioRow(rows, 'p1').bio.company_name, 'New Pass');
  assert.equal(selectPartnerBioRow(rows, 'p3'), null);
  assert.equal(selectPartnerBioRow(rows, ''), null);
});

test('a stored bio stays well inside one spreadsheet cell', () => {
  const long = 'x'.repeat(5000);
  const bio = parsePartnerBioResponse(asReply({
    ...GOOD,
    company_name: long,
    what_they_do: Array.from({ length: 40 }, () => long),
    how_recast_brings_value: Array.from({ length: 40 }, () => long),
    why_partner: Array.from({ length: 40 }, () => long),
  }));
  const json = partnerBioRowValues({ partner_id: 'p1', bio })[PARTNER_BIO_HEADERS.indexOf('bio_json')];
  assert.ok(json.length < 45_000, `bio_json was ${json.length} chars`);
});
