// Tests for buildPartnerBioPrompt() (js/utils/partner-bio-prompts.js).
// Verifies the prompt carries every authoritative source, the Recast value
// proposition verbatim, all seven research protocols and the strict JSON
// schema — and that the CRM row is framed as a search seed rather than a
// finding, with no credentials or PII leaking into it.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPartnerBioPrompt,
  AUTHORITATIVE_SOURCES,
  AUTHORITATIVE_DOMAINS,
  RECAST_VALUE_PROPOSITION,
} from '../js/utils/partner-bio-prompts.js';

const PARTNER = {
  partner_id: 'p1',
  display_name: 'Insight',
  partner_type: 'MSP/SI',
  tier: 'Premier/Strategic',
  region: 'North America',
  hq_location: 'Chandler, Arizona, USA',
  status: 'active',
  username: 'insight',
  password_hash: 'SECRETHASH1',
  created_at: '2026-01-15',
};

const TODAY = '2026-07-28';

test('every authoritative source appears, in priority order', () => {
  const prompt = buildPartnerBioPrompt({ partner: PARTNER, today: TODAY });
  let cursor = -1;
  for (const src of AUTHORITATIVE_SOURCES) {
    const at = prompt.indexOf(src);
    assert.ok(at > -1, `missing source ${src}`);
    assert.ok(at > cursor, `source out of priority order: ${src}`);
    cursor = at;
  }
});

test('the search-domain list matches the source list host for host', () => {
  assert.equal(AUTHORITATIVE_DOMAINS.length, AUTHORITATIVE_SOURCES.length);
  AUTHORITATIVE_SOURCES.forEach((src, i) => {
    const host = new URL(src).hostname.replace(/^www\./, '');
    assert.ok(
      host === AUTHORITATIVE_DOMAINS[i] || host.endsWith(`.${AUTHORITATIVE_DOMAINS[i]}`),
      `${src} is not covered by ${AUTHORITATIVE_DOMAINS[i]}`,
    );
  });
});

test('the Recast value proposition is carried verbatim', () => {
  const prompt = buildPartnerBioPrompt({ partner: PARTNER, today: TODAY });
  assert.ok(prompt.includes(RECAST_VALUE_PROPOSITION));
  assert.ok(prompt.includes('application layer bottleneck'));
});

test('all seven research protocols are present', () => {
  const prompt = buildPartnerBioPrompt({ partner: PARTNER, today: TODAY });
  for (const heading of [
    'Cross-Reference Validation',
    'Accuracy Threshold',
    'Partnership Model Classification',
    'Value Proposition Tailoring',
    'Partnership Rationale',
    'Competency Self-Assessment',
    'Plain Language',
  ]) {
    assert.ok(prompt.includes(heading), `missing protocol: ${heading}`);
  }
  // The specific rules the protocols turn on.
  assert.ok(/at least\s+THREE of the sources/i.test(prompt));
  assert.ok(prompt.includes('SEC filings, then Bloomberg, then LinkedIn'));
  assert.ok(prompt.includes('8 to 10'));
  assert.ok(/never use emojis/i.test(prompt));
});

test('every allowed partner fit category is offered', () => {
  const prompt = buildPartnerBioPrompt({ partner: PARTNER, today: TODAY });
  for (const cat of ['SI', 'MSP', 'SI/MSP Hybrid', 'ISV/Technology Partner', 'OEM', 'Other']) {
    assert.ok(prompt.includes(cat), `missing category ${cat}`);
  }
});

test('the CRM row is framed as a search seed, never as a finding', () => {
  const prompt = buildPartnerBioPrompt({ partner: PARTNER, today: TODAY });
  assert.ok(prompt.includes('SEARCH SEED'));
  assert.ok(/Never report a seed value as a\s*\n?\s*verified result/i.test(prompt));
  assert.ok(prompt.includes('Insight'));
  assert.ok(prompt.includes('Chandler, Arizona, USA'));
});

test('credentials and internal fields never reach the prompt', () => {
  const prompt = buildPartnerBioPrompt({ partner: PARTNER, today: TODAY });
  assert.ok(!prompt.includes('SECRETHASH1'));
  assert.ok(!prompt.includes('password'));
  assert.ok(!prompt.includes('username'));
});

test('the strict JSON schema and the NA rule are stated', () => {
  const prompt = buildPartnerBioPrompt({ partner: PARTNER, today: TODAY });
  for (const field of [
    'company_name', 'company_industry', 'company_website', 'company_linkedin_url',
    'headquarters', 'number_of_employees', 'partner_fit_category',
    'what_they_do', 'how_recast_brings_value', 'why_partner',
    'research_competency_rating', 'verification_level',
  ]) {
    assert.ok(prompt.includes(field), `missing schema field ${field}`);
  }
  assert.ok(prompt.includes('ONE JSON object and nothing else'));
  assert.ok(prompt.includes('"NA"'));
});

test('today anchors recency when supplied, and is simply absent when not', () => {
  assert.ok(buildPartnerBioPrompt({ partner: PARTNER, today: TODAY }).includes(TODAY));
  const undated = buildPartnerBioPrompt({ partner: PARTNER });
  assert.ok(!undated.includes("Today's date is"));
});

test('a partner with almost nothing recorded still yields a usable prompt', () => {
  const prompt = buildPartnerBioPrompt({ partner: { partner_id: 'p9', display_name: 'Acme' } });
  assert.ok(prompt.includes('Acme'));
  assert.ok(prompt.includes('(not recorded)'));
  assert.ok(prompt.includes('company_linkedin_url'));
});
