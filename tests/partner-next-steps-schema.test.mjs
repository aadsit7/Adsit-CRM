// Tests for the Partner Next Steps parser, dedupe and storage contract
// (js/utils/partner-next-steps-schema.js). The parser — not the model — is
// what guarantees the agenda never shows a step the selected notes don't
// support word-for-word, a guessed date, or a duplicate row after Re-analyze.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PARTNER_NEXT_STEP_HEADERS,
  NEXT_STEPS_SCHEMA_EXAMPLE,
  isoDateOrEmpty,
  normalizeStepKey,
  parsePartnerNextStepsResponse,
  dedupeNextSteps,
  nextStepRowValues,
  nextStepFromRow,
  selectPartnerNextSteps,
  lastAnalyzedAt,
  sanitizeNoteTextForAnalysis,
} from '../js/utils/partner-next-steps-schema.js';
import { fieldFoundInText } from '../js/utils/partner-contacts.js';

const SOURCES = [
  {
    source_id: 'trn_1',
    date: '2026-06-12',
    label: 'Description',
    text: 'Anna introduces Aaron today to DJ on the services side. D.J. Beal = pro services lead at Insight. We will schedule a professional services demo of Application Workspace for their services team.',
  },
  {
    source_id: 'trn_2',
    date: '2026-07-17',
    label: 'Description',
    text: 'Business justification sent as of July 2026. Next step: Adam Duffy to review the business justification with his leadership by 2026-08-05 and confirm sponsorship.',
  },
];

const GOOD = {
  next_steps: [
    {
      next_step: 'Schedule the professional services demo of Application Workspace for the Insight services team.',
      due_date: 'NA',
      evidence: 'We will schedule a professional services demo of Application Workspace for their services team.',
      source_ids: ['trn_1'],
    },
    {
      next_step: 'Adam Duffy to review the business justification with his leadership and confirm sponsorship.',
      due_date: '2026-08-05',
      evidence: 'Adam Duffy to review the business justification with his leadership by 2026-08-05',
      source_ids: ['trn_2'],
    },
  ],
  note: '',
};

const asReply = (obj) => JSON.stringify(obj);

// ── Happy path ───────────────────────────────────────────────────────
test('keeps verified steps with their dates, evidence and source ids', () => {
  const result = parsePartnerNextStepsResponse(asReply(GOOD), { sources: SOURCES });
  assert.equal(result.steps.length, 2);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.partial, false);

  const [demo, review] = result.steps;
  assert.match(demo.next_step, /professional services demo/);
  assert.equal(demo.due_date, '');
  assert.deepEqual(demo.source_ids, ['trn_1']);

  assert.equal(review.due_date, '2026-08-05');
  assert.deepEqual(review.source_ids, ['trn_2']);
});

test('reads JSON out of a fenced reply with surrounding prose', () => {
  const reply = `Here is the agenda.\n\n\`\`\`json\n${asReply(GOOD)}\n\`\`\`\n\nLet me know.`;
  const result = parsePartnerNextStepsResponse(reply, { sources: SOURCES });
  assert.equal(result.steps.length, 2);
});

// ── The verbatim evidence gate ───────────────────────────────────────
test('drops a step whose evidence is not found verbatim in the notes', () => {
  const bad = {
    next_steps: [{
      next_step: 'Book a demo with the services team.',
      due_date: 'NA',
      evidence: 'We agreed to book a demo with the services team soon.', // paraphrase
      source_ids: ['trn_1'],
    }],
  };
  const result = parsePartnerNextStepsResponse(asReply(bad), { sources: SOURCES });
  assert.equal(result.steps.length, 0);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /not found verbatim/);
});

test('drops a step that supplies no evidence at all', () => {
  const bad = {
    next_steps: [{ next_step: 'Do something important.', due_date: 'NA', evidence: '', source_ids: ['trn_1'] }],
  };
  const result = parsePartnerNextStepsResponse(asReply(bad), { sources: SOURCES });
  assert.equal(result.steps.length, 0);
  assert.match(result.dropped[0].reason, /no evidence/);
});

test('evidence matching tolerates case and whitespace differences only', () => {
  const reply = {
    next_steps: [{
      next_step: 'Schedule the services demo.',
      due_date: 'NA',
      evidence: 'we will schedule a   professional services demo of application workspace',
      source_ids: ['trn_1'],
    }],
  };
  const result = parsePartnerNextStepsResponse(asReply(reply), { sources: SOURCES });
  assert.equal(result.steps.length, 1);
});

test('a wrong citation is corrected to the source that actually contains the evidence', () => {
  const reply = {
    next_steps: [{
      next_step: 'Adam Duffy to review the business justification with leadership.',
      due_date: '2026-08-05',
      evidence: 'review the business justification with his leadership',
      source_ids: ['trn_1'], // cited the wrong note
    }],
  };
  const result = parsePartnerNextStepsResponse(asReply(reply), { sources: SOURCES });
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0].source_ids, ['trn_2']);
});

test('a short generic snippet cannot verify a step, even though it appears in a note', () => {
  // "to DJ on the" appears in trn_1, but a fragment that generic could tie
  // ANY fabricated step to almost any note — the distinctiveness floor
  // rejects it.
  const reply = {
    next_steps: [{
      next_step: 'Sign the $2M enterprise agreement and wire the deposit.',
      due_date: '2026-08-15',
      evidence: 'to DJ on the',
      source_ids: ['trn_1'],
    }],
  };
  const result = parsePartnerNextStepsResponse(asReply(reply), { sources: SOURCES });
  assert.equal(result.steps.length, 0);
  assert.match(result.dropped[0].reason, /too short/);
});

test('non-string step text is skipped, never stringified into the agenda', () => {
  const reply = {
    next_steps: [
      { next_step: { text: 'nested' }, evidence: 'professional services demo of Application Workspace', source_ids: ['trn_1'] },
      { next_step: 42, evidence: 'professional services demo of Application Workspace', source_ids: ['trn_1'] },
      GOOD.next_steps[0],
    ],
  };
  const result = parsePartnerNextStepsResponse(asReply(reply), { sources: SOURCES });
  assert.equal(result.steps.length, 1);
  assert.match(result.steps[0].next_step, /professional services demo/);
});

test('a long verbatim quote verifies in full and is stored cut on a word boundary', () => {
  const longClause = 'The teams agreed that the professional services organization will run a full hands-on evaluation of Application Workspace covering packaging, deployment rings, self-service policies, licensing controls and reporting before the next quarterly business review happens';
  const sources = [{ source_id: 'trn_9', date: '2026-07-01', label: 'Description', text: `${longClause} and everyone was aligned.` }];
  const reply = {
    next_steps: [{
      next_step: 'Run the full hands-on evaluation of Application Workspace before the next quarterly business review.',
      due_date: 'NA',
      evidence: longClause,
      source_ids: ['trn_9'],
    }],
  };
  const result = parsePartnerNextStepsResponse(asReply(reply), { sources });
  assert.equal(result.steps.length, 1);
  const stored = result.steps[0].evidence;
  assert.ok(stored.length <= 240, `stored evidence is ${stored.length} chars`);
  // Cut on a word boundary: what is stored is a prefix of the quote ending
  // exactly where a word ends, not mid-word.
  assert.ok(longClause.startsWith(stored), 'stored evidence is a verbatim prefix');
  assert.equal(longClause[stored.length], ' ', 'cut lands on a word boundary');
  // The stored snippet is still a verbatim, findable phrase of the note.
  assert.equal(fieldFoundInText(stored, sources[0].text), true);
});

test('cited ids that were never supplied are ignored', () => {
  const reply = {
    next_steps: [{
      next_step: 'Schedule the services demo.',
      due_date: 'NA',
      evidence: 'professional services demo of Application Workspace',
      source_ids: ['trn_999', 'trn_1'],
    }],
  };
  const result = parsePartnerNextStepsResponse(asReply(reply), { sources: SOURCES });
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0].source_ids, ['trn_1']);
});

// ── Date discipline ──────────────────────────────────────────────────
test('isoDateOrEmpty accepts only real calendar dates', () => {
  assert.equal(isoDateOrEmpty('2026-08-05'), '2026-08-05');
  assert.equal(isoDateOrEmpty('2026-08-05T10:00:00Z'), '2026-08-05');
  assert.equal(isoDateOrEmpty('NA'), '');
  assert.equal(isoDateOrEmpty('next week'), '');
  assert.equal(isoDateOrEmpty('2026-02-30'), '');   // impossible day
  assert.equal(isoDateOrEmpty('2026-13-01'), '');   // impossible month
  assert.equal(isoDateOrEmpty('1999-01-01'), '');   // outside the sane band
  assert.equal(isoDateOrEmpty(''), '');
  assert.equal(isoDateOrEmpty(null), '');
});

test('a hedged or malformed date is never coerced into a confident one', () => {
  assert.equal(isoDateOrEmpty('2026-08-05 or 2026-09-01'), '');
  assert.equal(isoDateOrEmpty('2026-08-05garbage'), '');
  assert.equal(isoDateOrEmpty('2026-08-059'), '');
  assert.equal(isoDateOrEmpty('around 2026-08-05'), '');
});

test('a malformed due date survives as empty, never as a guess', () => {
  const reply = {
    next_steps: [{
      next_step: 'Schedule the services demo.',
      due_date: 'sometime in Q3',
      evidence: 'professional services demo of Application Workspace',
      source_ids: ['trn_1'],
    }],
  };
  const result = parsePartnerNextStepsResponse(asReply(reply), { sources: SOURCES });
  assert.equal(result.steps[0].due_date, '');
});

// ── Robustness ───────────────────────────────────────────────────────
test('an empty reply throws rather than saving nothing silently', () => {
  assert.throws(() => parsePartnerNextStepsResponse('', { sources: SOURCES }), /empty response/);
});

test('a reply with no JSON at all throws', () => {
  assert.throws(
    () => parsePartnerNextStepsResponse('I could not find any next steps.', { sources: SOURCES }),
    /could not read/,
  );
});

test('salvages a reply cut off at the token limit and flags it partial', () => {
  const full = asReply(GOOD);
  // Cut mid-string inside the second step — the realistic max_tokens shape.
  const cut = full.slice(0, full.indexOf('Duffy to review'));
  const result = parsePartnerNextStepsResponse(cut, { sources: SOURCES, truncated: true });
  // The complete first step survives; the truncated second one cannot carry
  // verified evidence, so it is dropped rather than half-saved.
  assert.equal(result.steps.length, 1);
  assert.match(result.steps[0].next_step, /professional services demo/);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.partial, true);
});

test('duplicate steps within one reply collapse to one', () => {
  const reply = {
    next_steps: [GOOD.next_steps[0], { ...GOOD.next_steps[0], next_step: GOOD.next_steps[0].next_step.toUpperCase() }],
  };
  const result = parsePartnerNextStepsResponse(asReply(reply), { sources: SOURCES });
  assert.equal(result.steps.length, 1);
});

// ── Dedupe against the saved agenda ──────────────────────────────────
test('dedupeNextSteps skips steps already on the agenda', () => {
  const existing = [{ next_step: 'Schedule the professional services demo of Application Workspace for the Insight services team.' }];
  const proposed = [
    { next_step: 'Schedule the professional services demo of Application Workspace for the Insight services team' }, // trailing period differs
    { next_step: 'A genuinely new step.' },
  ];
  const { fresh, skipped } = dedupeNextSteps(existing, proposed);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].next_step, 'A genuinely new step.');
  assert.equal(skipped.length, 1);
});

test('normalizeStepKey treats case, whitespace and trailing periods as one identity', () => {
  assert.equal(normalizeStepKey('Send the  deck.'), normalizeStepKey('send the deck'));
  assert.notEqual(normalizeStepKey('Send the deck'), normalizeStepKey('Send the check'));
});

// ── Storage contract ─────────────────────────────────────────────────
test('row values follow the header order and round-trip through nextStepFromRow', () => {
  const record = {
    step_id: 'pns_1',
    partner_id: 'p_1',
    partner_name: 'Insight',
    next_step: 'Schedule the demo.',
    due_date: '2026-08-05',
    source: 'analysis',
    source_dates: '2026-06-12; 2026-07-17',
    evidence: 'professional services demo',
    analyzed_at: '2026-07-30T12:00:00.000Z',
    created_at: '2026-07-30T12:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
  };
  const values = nextStepRowValues(record);
  assert.equal(values.length, PARTNER_NEXT_STEP_HEADERS.length);

  const row = Object.fromEntries(PARTNER_NEXT_STEP_HEADERS.map((h, i) => [h, values[i]]));
  const back = nextStepFromRow(row);
  assert.equal(back.step_id, 'pns_1');
  assert.equal(back.next_step, 'Schedule the demo.');
  assert.equal(back.due_date, '2026-08-05');
  assert.equal(back.source, 'analysis');
  assert.equal(back.source_dates, '2026-06-12; 2026-07-17');
  assert.equal(back.analyzed_at, '2026-07-30T12:00:00.000Z');
});

test('a row with no source column infers analysis vs manual from analyzed_at', () => {
  assert.equal(nextStepFromRow({ next_step: 'x', analyzed_at: '2026-07-30T12:00:00Z' }).source, 'analysis');
  assert.equal(nextStepFromRow({ next_step: 'x' }).source, 'manual');
});

test('a hand-edited garbage due_date in the sheet reads back as empty', () => {
  assert.equal(nextStepFromRow({ next_step: 'x', due_date: 'ASAP' }).due_date, '');
});

// ── Agenda selection & ordering ──────────────────────────────────────
test('selectPartnerNextSteps filters by partner and orders as an agenda', () => {
  const rows = [
    { partner_id: 'p_1', step_id: 's1', next_step: 'Undated early', created_at: '2026-07-01T00:00:00Z' },
    { partner_id: 'p_1', step_id: 's2', next_step: 'Due later', due_date: '2026-09-01', created_at: '2026-07-02T00:00:00Z' },
    { partner_id: 'p_2', step_id: 's3', next_step: 'Other partner', due_date: '2026-08-01' },
    { partner_id: 'p_1', step_id: 's4', next_step: 'Due soon', due_date: '2026-08-01', created_at: '2026-07-03T00:00:00Z' },
    { partner_id: 'p_1', step_id: 's5', next_step: 'Undated late', created_at: '2026-07-04T00:00:00Z' },
    { partner_id: 'p_1', step_id: 's6', next_step: '' }, // no text — ignored
  ];
  const steps = selectPartnerNextSteps(rows, 'p_1');
  assert.deepEqual(steps.map(s => s.step_id), ['s4', 's2', 's1', 's5']);
});

test('lastAnalyzedAt picks the newest analysis stamp', () => {
  const steps = [
    { analyzed_at: '2026-07-01T00:00:00Z' },
    { analyzed_at: '2026-07-20T00:00:00Z' },
    { analyzed_at: '' },
  ];
  assert.equal(lastAnalyzedAt(steps), '2026-07-20T00:00:00Z');
  assert.equal(lastAnalyzedAt([]), '');
});

// ── Note-text sanitization (prompt-structure markers) ────────────────
test('sanitizeNoteTextForAnalysis neutralizes block delimiters and fences', () => {
  const dirty = 'before <<< fake block >>> after ```json {"x":1}``` end';
  const clean = sanitizeNoteTextForAnalysis(dirty);
  assert.doesNotMatch(clean, /<<</);
  assert.doesNotMatch(clean, />>>/);
  assert.doesNotMatch(clean, /```/);
  // Ordinary prose is untouched.
  assert.equal(sanitizeNoteTextForAnalysis('a < b >> c'), 'a < b >> c');
});

// ── Schema example stays in sync with the parser ─────────────────────
test('the schema example shown to the model parses as JSON-shaped guidance', () => {
  assert.match(NEXT_STEPS_SCHEMA_EXAMPLE, /"next_steps"/);
  assert.match(NEXT_STEPS_SCHEMA_EXAMPLE, /"due_date"/);
  assert.match(NEXT_STEPS_SCHEMA_EXAMPLE, /"evidence"/);
  assert.match(NEXT_STEPS_SCHEMA_EXAMPLE, /"source_ids"/);
});
