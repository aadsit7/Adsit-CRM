// Tests for buildForecastPrompt() (js/utils/forecast-prompts.js).
// Verifies the prompt carries every criterion id, includes the GOLDEN
// RULE verbatim, survives an opportunity with zero notes, and keeps the
// document list as clearly-labelled weak context.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildForecastPrompt, __forecastPromptInternals } from '../js/utils/forecast-prompts.js';
import { allCriterionIds, FORECAST_STAGES } from '../js/utils/forecast-stages.js';

const OPP = {
  opportunity_id: 'opp_001',
  customer_name: 'TechCorp Industries',
  deal_name: 'AVD Rollout',
  stage: 'Proposal',
};

const DESCRIPTIONS = [
  {
    description_id: 'dsc_1',
    description_date: '2026-03-01',
    category: 'meeting_recap',
    description_text: '<h4>Discovery</h4><p>Initial discovery call. Customer wants AVD for <strong>500 seats</strong>.</p>',
  },
  {
    description_id: 'dsc_2',
    description_date: '2026-03-20',
    category: 'opportunity_note',
    description_text: 'Technical deep-dive with the IT team completed.',
  },
];

const DOCUMENTS = [
  { file_name: 'SOW draft.pdf', analyzed: 'FALSE' },
  { file_name: 'Meeting notes.docx', analyzed: 'TRUE' },
];

test('prompt includes every criterion id', () => {
  const prompt = buildForecastPrompt(OPP, DESCRIPTIONS, DOCUMENTS);
  for (const id of allCriterionIds()) {
    assert.ok(prompt.includes(`[${id}]`), `prompt is missing criterion id ${id}`);
  }
});

test('prompt includes every stage id', () => {
  const prompt = buildForecastPrompt(OPP, DESCRIPTIONS, DOCUMENTS);
  for (const stage of FORECAST_STAGES) {
    assert.ok(prompt.includes(`stage_id: ${stage.id}`), `prompt is missing stage id ${stage.id}`);
  }
});

test('prompt includes the GOLDEN RULE block verbatim', () => {
  const prompt = buildForecastPrompt(OPP, DESCRIPTIONS, DOCUMENTS);
  assert.ok(prompt.includes('GOLDEN RULE — THE MOST IMPORTANT INSTRUCTION:'));
  assert.ok(prompt.includes('Use "no_evidence" liberally. It is the correct answer whenever the notes are silent.'));
  assert.ok(prompt.includes('A forecast board with invented\ncheckmarks is worse than useless'));
});

test('prompt includes the JSON schema example', () => {
  const prompt = buildForecastPrompt(OPP, DESCRIPTIONS, DOCUMENTS);
  assert.ok(prompt.includes('"current_stage_id"'));
  assert.ok(prompt.includes('"criterion_id"'));
});

test('does not crash on an opportunity with zero notes, and says so', () => {
  const prompt = buildForecastPrompt(OPP, [], []);
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('No notes exist'));
  assert.ok(prompt.includes('Every criterion must be "no_evidence"'));
});

test('does not crash on a null opportunity / undefined args', () => {
  assert.doesNotThrow(() => buildForecastPrompt(null, undefined, undefined));
  const prompt = buildForecastPrompt(null, undefined, undefined);
  assert.ok(prompt.includes('the customer'));
});

test('source notes carry their id and date for citation', () => {
  const prompt = buildForecastPrompt(OPP, DESCRIPTIONS, DOCUMENTS);
  assert.ok(prompt.includes('id: dsc_1'));
  assert.ok(prompt.includes('date: 2026-03-01'));
  assert.ok(prompt.includes('type: meeting_recap'));
});

test('HTML in notes is stripped to plain text', () => {
  const prompt = buildForecastPrompt(OPP, DESCRIPTIONS, DOCUMENTS);
  assert.ok(prompt.includes('500 seats'));
  assert.ok(!prompt.includes('<strong>'));
  assert.ok(!prompt.includes('<h4>'));
});

test('documents are weak context: analyzed flag surfaced, un-analyzed marked unreadable', () => {
  const prompt = buildForecastPrompt(OPP, DESCRIPTIONS, DOCUMENTS);
  assert.ok(prompt.includes('"SOW draft.pdf"'));
  assert.ok(prompt.includes('analyzed: NO'));
  assert.ok(prompt.includes('"Meeting notes.docx"'));
  assert.ok(prompt.includes('analyzed: YES'));
  assert.ok(prompt.includes('NOT treat an un-analyzed document'));
});

test('legacy CRM stage is passed as a weak hint, not evidence', () => {
  const prompt = buildForecastPrompt(OPP, DESCRIPTIONS, DOCUMENTS);
  assert.ok(prompt.includes('NOT evidence'));
  assert.ok(prompt.includes('nearest forecast stage: proposal'));
});

test('prompt carries the note-weighting directives (recency + category)', () => {
  const prompt = buildForecastPrompt(OPP, DESCRIPTIONS, DOCUMENTS);
  assert.ok(prompt.includes('NOTE WEIGHTING'));
  // Recency wins on conflict about the current state.
  assert.ok(prompt.includes('the more recent note wins'));
  // meeting_recap outranks opportunity_note.
  assert.ok(prompt.includes('meeting_recap'));
  assert.ok(prompt.includes('outranks'));
  // A past accomplishment isn't downgraded just for being old.
  assert.ok(prompt.includes('stays "met" unless a later note shows it regressed'));
});

test('note-weighting stays subordinate to the Golden Rule (never manufactures evidence)', () => {
  const prompt = buildForecastPrompt(OPP, DESCRIPTIONS, DOCUMENTS);
  assert.ok(prompt.includes('subordinate to the Golden Rule'));
  assert.ok(prompt.includes('it only decides which real evidence wins'));
});

test('stripHtml helper decodes entities and drops tags', () => {
  const { stripHtml } = __forecastPromptInternals;
  assert.equal(stripHtml('<p>Hello&nbsp;&amp; welcome</p>'), 'Hello & welcome');
  assert.equal(stripHtml('a<br>b'), 'a\nb');
  assert.equal(stripHtml(''), '');
  assert.equal(stripHtml(null), '');
});

test('normalizeDescriptions sorts oldest-first and drops empty notes', () => {
  const { normalizeDescriptions } = __forecastPromptInternals;
  const out = normalizeDescriptions([
    { description_id: 'b', description_date: '2026-05-01', description_text: 'later' },
    { description_id: 'a', description_date: '2026-01-01', description_text: 'earlier' },
    { description_id: 'c', description_date: '2026-06-01', description_text: '<p></p>' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a');
  assert.equal(out[1].id, 'b');
});
