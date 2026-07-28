// Tests for requestPartnerBio (js/utils/partner-bio-client.js) with a stubbed
// fetch. The point of this client is that the "search exclusively these
// websites" rule is enforced by the API rather than by trusting the model, so
// the request shape is the contract worth pinning: the pinned web_search tool
// version, the allowed_domains allowlist, and the pause_turn continuation loop
// that lets a long research turn finish.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setRuntimeConfig } from '../js/config.js';
import { requestPartnerBio } from '../js/utils/partner-bio-client.js';
import { AUTHORITATIVE_DOMAINS } from '../js/utils/partner-bio-prompts.js';

const PARTNER = { partner_id: 'p1', display_name: 'Insight', hq_location: 'Chandler, Arizona, USA' };

const BIO_JSON = JSON.stringify({
  company_name: 'Insight Enterprises, Inc.',
  company_industry: 'IT solutions and services',
  company_website: 'https://www.insight.com',
  company_linkedin_url: 'https://www.linkedin.com/company/insight',
  headquarters: 'Chandler, Arizona, USA',
  number_of_employees: '13,000 (LinkedIn, March 2026)',
  partner_fit_category: 'SI/MSP Hybrid',
  what_they_do: ['Reseller and services provider'],
  how_recast_brings_value: ['Packaging backlog'],
  why_partner: ['Services mix is growing'],
  research_competency_rating: 9,
  verification_level: 3,
});

function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      json: async () => next.body,
    };
  };
  return calls;
}

function withKey(fn) {
  setRuntimeConfig('ANTHROPIC_API_KEY', 'test-key');
  const original = globalThis.fetch;
  return (async () => {
    try { return await fn(); } finally { globalThis.fetch = original; }
  })();
}

test('the search tool is pinned to the authoritative domains', async () => {
  await withKey(async () => {
    const calls = stubFetch([{ body: { stop_reason: 'end_turn', content: [{ type: 'text', text: BIO_JSON }] } }]);
    await requestPartnerBio({ partner: PARTNER, today: '2026-07-28' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    const [tool] = calls[0].body.tools;
    assert.equal(tool.type, 'web_search_20260209');
    assert.equal(tool.name, 'web_search');
    assert.deepEqual(tool.allowed_domains, AUTHORITATIVE_DOMAINS);
    assert.ok(tool.max_uses > 0);
    // The research brief itself travels as the single cached user turn.
    assert.equal(calls[0].body.messages.length, 1);
    assert.ok(calls[0].body.messages[0].content[0].text.includes('crunchbase.com'));
  });
});

test('a paused research turn is continued, and the final answer parsed', async () => {
  await withKey(async () => {
    const rounds = [];
    const calls = stubFetch([
      { body: { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'searching…' }] } },
      { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'notes' }, { type: 'text', text: BIO_JSON }] } },
    ]);

    const bio = await requestPartnerBio({
      partner: PARTNER,
      onProgress: (round) => rounds.push(round),
    });

    assert.equal(calls.length, 2);
    // The paused turn is appended, so the second call continues the same turn.
    assert.equal(calls[1].body.messages.length, 2);
    assert.equal(calls[1].body.messages[1].role, 'assistant');
    assert.deepEqual(rounds, [1, 2]);
    // The strict JSON is read from the LAST text block, not the narration.
    assert.equal(bio.company_name, 'Insight Enterprises, Inc.');
    assert.equal(bio.partner_fit_category, 'SI/MSP Hybrid');
  });
});

test('a refusal is surfaced as a clear error', async () => {
  await withKey(async () => {
    stubFetch([{ body: { stop_reason: 'refusal', content: [] } }]);
    await assert.rejects(requestPartnerBio({ partner: PARTNER }), /declined to research/i);
  });
});

test('an API error carries its status and code', async () => {
  await withKey(async () => {
    stubFetch([{ ok: false, status: 429, body: { error: { message: 'rate limited' } } }]);
    await assert.rejects(requestPartnerBio({ partner: PARTNER }), (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.code, 'PARTNER_BIO_API_ERROR');
      return true;
    });
  });
});

test('a missing API key fails before any network call', async () => {
  setRuntimeConfig('ANTHROPIC_API_KEY', '');
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('should not be reached'); };
  try {
    await assert.rejects(requestPartnerBio({ partner: PARTNER }), /API key not set/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});
