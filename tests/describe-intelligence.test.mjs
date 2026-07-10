// Tests for Describe Intelligence V1 — standardizeDescription() and
// applyStandardizedDescription() in js/utils/ai.js.
//
// Two preservation-specific tests (tests 4 and 5) verify that the AI
// prompt carries every required clause of the Preservation Rule.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }));

const { standardizeDescription, applyStandardizedDescription, __standardizeInternals } = await import('../js/utils/ai.js');
const { buildStandardizePrompt } = __standardizeInternals;

// ── Helpers ────────────────────────────────────────────────────────

function messagesResponse(text) {
  // standardizeDescription() uses SSE streaming (response.body.getReader()),
  // so the mock must provide a ReadableStream that emits the text as a
  // content_block_delta event.
  const encoder = new TextEncoder();
  const sseChunk = `data: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })}\n\n`;

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseChunk));
      controller.close();
    },
  });

  return { ok: true, status: 200, body };
}

function fileApiResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, descriptionId: 'desc_abc123' }),
  };
}

const VALID_MEETING_RECAP_RESPONSE = `<result>
<category>meeting_recap</category>
<standardized_text>
**Meeting Recap — March 15, 2026**

**Attendees:** Gerard Smith (Contoso), Aaron

**Discussion Points:**
- Gerard was really excited about the migration timeline
- He committed to looping in his VP by Thursday
- Pricing was discussed: $150k by end of Q2
- Gerard seemed hesitant but might be open to a pilot

**Action Items / Next Steps:**
- Gerard to loop in VP by Thursday

**Notes:**
Gerard was really excited overall. Good meeting.
</standardized_text>
<confidence>high</confidence>
<preservation_check>All input information preserved.</preservation_check>
</result>`;

const VALID_OPP_NOTE_RESPONSE = `<result>
<category>opportunity_note</category>
<standardized_text>
**April 1, 2026 — Internal Note**

Followed up on the Q2 pricing proposal. Deal is stalled waiting on legal review.

**Facts / Commitments:**
- Q2 pricing proposal outstanding
- Deal stalled: waiting on legal review

**Notes / Observations:**
This guy is going to be a pain to work with.
</standardized_text>
<confidence>medium</confidence>
<preservation_check>All input information preserved.</preservation_check>
</result>`;

// ── Test 1: request shape — headers, model, no Skills/code-execution betas ──

test('standardizeDescription() builds correct request — headers, model, no Skills betas', async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return messagesResponse(VALID_MEETING_RECAP_RESPONSE);
  };

  await standardizeDescription('Quick call with Gerard. He was excited. $150k by Q2.');

  assert.ok(captured.url.endsWith('/v1/messages'));
  const h = captured.opts.headers;
  assert.equal(h['x-api-key'], 'sk-ant-test-key');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(!h['anthropic-beta'] || !/code-execution|skills-2025/.test(h['anthropic-beta']),
    'request must not include Skills or code_execution betas');

  const body = JSON.parse(captured.opts.body);
  assert.equal(body.model, 'claude-opus-4-7');
  assert.ok(typeof body.max_tokens === 'number' && body.max_tokens >= 2048);
  assert.ok(!body.tools, 'no tools');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.match(body.messages[0].content, /Gerard/);
  assert.match(body.messages[0].content, /\$150k/);
});

// ── Test 2: parses meeting_recap response correctly ────────────────

test('standardizeDescription() parses meeting_recap response and returns correct shape', async () => {
  globalThis.fetch = async () => messagesResponse(VALID_MEETING_RECAP_RESPONSE);
  const result = await standardizeDescription('Call with Gerard about timeline.');
  assert.equal(result.category, 'meeting_recap');
  assert.ok(typeof result.standardizedText === 'string' && result.standardizedText.length > 0);
  assert.ok(['high', 'medium', 'low'].includes(result.confidence));
  // standardizeDescription should NOT expose preservation_check — it's logged to console only.
  assert.equal(result.preservation_check, undefined);
});

// ── Test 3: parses opportunity_note response correctly ─────────────

test('standardizeDescription() parses opportunity_note response and returns correct shape', async () => {
  globalThis.fetch = async () => messagesResponse(VALID_OPP_NOTE_RESPONSE);
  const result = await standardizeDescription('Deal stalled. Legal review. This guy is going to be a pain.');
  assert.equal(result.category, 'opportunity_note');
  assert.ok(typeof result.standardizedText === 'string' && result.standardizedText.length > 0);
  // Subjective commentary must survive in the standardized text.
  assert.ok(result.standardizedText.includes('pain'), 'subjective commentary preserved in standardizedText');
  assert.ok(['high', 'medium', 'low'].includes(result.confidence));
});

// ── Test 4: PRESERVATION TEST 1 — multi-fact preservation instructions ──
//
// Verifies the prompt contains all the key multi-fact preservation clauses
// from the spec. If any clause is weakened or removed, this test fails.

test('buildStandardizePrompt() enforces multi-fact preservation instructions [PRESERVATION TEST 1]', () => {
  const prompt = buildStandardizePrompt('some raw description text');

  // The Preservation Rule block must be present.
  assert.match(prompt, /THE PRESERVATION RULE/i);
  assert.match(prompt, /MOST IMPORTANT INSTRUCTION/i);

  // Rule 1: no summarization.
  assert.match(prompt, /NO SUMMARIZATION/);
  assert.match(prompt, /three facts.*output must have all three/i);

  // Rule 2: no consolidation / repetition is signal.
  assert.match(prompt, /NO CONSOLIDATION/);
  assert.match(prompt, /Repetition is signal/i);

  // Rule 3: no shortening.
  assert.match(prompt, /NO SHORTENING/);
  assert.match(prompt, /materially shorter.*you have failed/i);

  // Rule 4: preserve specific wording — exact pricing example from spec.
  assert.match(prompt, /PRESERVE SPECIFIC WORDING/);
  assert.match(prompt, /\$150k by end of Q2/);

  // Rule 7: never invent.
  assert.match(prompt, /NEVER INVENT/);

  // The raw text must appear at the end of the prompt.
  assert.ok(prompt.endsWith('some raw description text'), 'raw text is the final content of the prompt');
});

// ── Test 5: PRESERVATION TEST 2 — subjective commentary preservation ──
//
// Verifies the prompt explicitly instructs the AI to preserve the user's
// voice in subjective commentary and gives the exact examples from the spec.

test('buildStandardizePrompt() enforces subjective commentary preservation [PRESERVATION TEST 2]', () => {
  const prompt = buildStandardizePrompt('notes with vibes');

  // Rule 6 must be present verbatim (key phrase and examples from spec).
  assert.match(prompt, /PRESERVE THE USER'S VOICE/i);
  assert.match(prompt, /subjective commentary/i);
  assert.match(prompt, /pain to work with/i, 'spec example "pain to work with" must be in prompt');
  assert.match(prompt, /great vibes/i, 'spec example "great vibes" must be in prompt');

  // The list of never-acceptable actions must include sanitizing content.
  assert.match(prompt, /Removing content.*off-topic.*informal/i);

  // JSON shape must specify preservation_check for auditability.
  assert.match(prompt, /preservation_check/);
  assert.match(prompt, /All input information preserved/i);
});

// ── Test 6: applyStandardizedDescription() — correct payload, no Content-Type ──

test('applyStandardizedDescription() sends correct updateDescription payload without Content-Type header', async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return fileApiResponse();
  };

  await applyStandardizedDescription('opp_001', 'desc_abc', 'meeting_recap', 'Standardized text here.');

  assert.ok(captured !== null, 'fetch was called');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.action, 'updateDescription');
  assert.equal(body.opportunityId, 'opp_001');
  assert.equal(body.descriptionId, 'desc_abc');
  assert.equal(body.category, 'meeting_recap');
  assert.equal(body.standardizedText, 'Standardized text here.');

  // Critical: no Content-Type header — keeps the call on the simple-CORS
  // path that the Apps Script endpoint can answer without a preflight.
  const headers = captured.opts.headers || {};
  assert.ok(!headers['Content-Type'] && !headers['content-type'],
    'fileApiRequest must NOT set Content-Type header');
});
