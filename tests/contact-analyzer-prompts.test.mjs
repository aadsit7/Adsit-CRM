// Tests for the Contact Analyzer prompt builder
// (js/utils/contact-analyzer-prompts.js). The prompt must layer the team's
// "Lead Search" preset instructions as the methodology, surface every evidence
// input as UNTRUSTED data, and end with the strict JSON output contract that
// overrides any conversational directive in the preset.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContactBriefPrompt, buildPartnerContextBlock } from '../js/utils/contact-analyzer-prompts.js';
import { INFLUENCE_DIMENSIONS } from '../js/utils/contact-analyzer-schema.js';

const SNAPSHOT = {
  name: 'Anna Donnelly', role: 'Product Manager, Services',
  company: 'Insight', email: 'anna.donnelly@insight.com',
  partner_name: 'Insight', evidence: 'Led commercial pushback on the 50K minimum',
};

test('includes the Lead Search preset instructions as the methodology', () => {
  const preset = 'SECRET-METHOD: classify into ICP buckets and score six influence dimensions.';
  const prompt = buildContactBriefPrompt({ presetInstructions: preset, snapshot: SNAPSHOT, today: '2026-07-23' });
  assert.ok(prompt.includes('SECRET-METHOD'));
  assert.ok(/METHODOLOGY/.test(prompt));
});

test('falls back to a built-in methodology when no preset is supplied', () => {
  const prompt = buildContactBriefPrompt({ presetInstructions: '', snapshot: SNAPSHOT });
  assert.ok(/account-intelligence analyst/i.test(prompt));
  assert.ok(/ICP bucket/i.test(prompt));
});

test('names all six influence dimensions', () => {
  const prompt = buildContactBriefPrompt({ snapshot: SNAPSHOT });
  for (const dim of INFLUENCE_DIMENSIONS) assert.ok(prompt.includes(dim), `missing dimension: ${dim}`);
});

test('ends with a strict JSON output contract that overrides formatting', () => {
  const prompt = buildContactBriefPrompt({ snapshot: SNAPSHOT });
  assert.ok(/OUTPUT CONTRACT/.test(prompt));
  assert.ok(/STRICT JSON ONLY/.test(prompt));
  assert.ok(/overrides any formatting instruction/i.test(prompt));
  // The contract lives at the very end so it wins over preset directives.
  assert.ok(prompt.lastIndexOf('OUTPUT CONTRACT') > prompt.indexOf('METHODOLOGY'));
});

test('surfaces the selected individual and marks evidence UNTRUSTED', () => {
  const prompt = buildContactBriefPrompt({ snapshot: SNAPSHOT });
  assert.ok(prompt.includes('Anna Donnelly'));
  assert.ok(prompt.includes('anna.donnelly@insight.com'));
  assert.ok(/UNTRUSTED DATA/.test(prompt));
});

test('includes CRM source material, prior LeadCheck, and partner context blocks', () => {
  const prompt = buildContactBriefPrompt({
    snapshot: SNAPSHOT,
    sourceMaterial: [{ label: 'CRM meeting record (2026-06-30)', text: 'Anna raised Legal / VMO concerns.' }],
    leadCheckSummary: 'LEADCHECK — Anna Donnelly\nState: COMPLETE',
    partnerContext: 'Partner: Insight\nCRM tier: Premier',
  });
  assert.ok(prompt.includes('Anna raised Legal / VMO concerns.'));
  assert.ok(prompt.includes('LEADCHECK — Anna Donnelly'));
  assert.ok(prompt.includes('CRM tier: Premier'));
});

test('notes when no prior LeadCheck exists', () => {
  const prompt = buildContactBriefPrompt({ snapshot: SNAPSHOT, leadCheckSummary: '' });
  assert.ok(/no prior LeadCheck/i.test(prompt));
});

// ── buildPartnerContextBlock ────────────────────────────────────────
test('partner context lists tier/status and opportunities', () => {
  const block = buildPartnerContextBlock({
    partner: { display_name: 'Insight', tier: 'Premier', status: 'active' },
    opportunities: [
      { deal_name: 'Managed Endpoint 2.0', stage: 'Negotiation', amount: '600000', status: 'Open' },
    ],
    notes: [],
  });
  assert.ok(block.includes('Partner: Insight'));
  assert.ok(block.includes('Premier'));
  assert.ok(block.includes('Managed Endpoint 2.0'));
  assert.ok(block.includes('600000'));
});

test('partner context includes notes and is bounded', () => {
  const notes = Array.from({ length: 50 }, (_, i) => ({
    label: `Note ${i}`, date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, text: 'X'.repeat(3000),
  }));
  const block = buildPartnerContextBlock({ partner: { display_name: 'Insight' }, opportunities: [], notes });
  assert.ok(block.includes('Recent partner & deal notes'));
  assert.ok(block.length < 15000); // capped
});

test('empty partner context yields a clear placeholder', () => {
  const block = buildPartnerContextBlock({ partner: {}, opportunities: [], notes: [] });
  assert.match(block, /no additional partner or deal context/i);
});
