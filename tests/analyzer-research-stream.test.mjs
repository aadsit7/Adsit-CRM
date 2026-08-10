// ============================================================
// anthropic-research-stream — transport, reconstruction, progress, retry
// ============================================================
// This module is what makes the analyze progress bar honest, so the contracts
// worth pinning are the ones a broken bar would come from:
//
//   1. The stream is parsed regardless of how the bytes are chunked (an SSE
//      frame split mid-JSON must not be dropped).
//   2. The `content` array is reconstructed EXACTLY as a non-streaming
//      response would have returned it — on pause_turn it is posted straight
//      back as the assistant turn, so a mangled tool-input here silently
//      changes what the model continues from.
//   3. Every real step is reported: each search (with its query), each result
//      set (with its source count), and the answer being written.
//   4. A round that fails transiently is retried without losing the rounds
//      already done; a round that fails permanently is not retried at all.
//   5. A stream that ends without a stop_reason is an error, not an empty
//      success — silently accepting one is how a run "completes" with nothing.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runResearchStream, isRetryableResearchError } from '../js/utils/anthropic-research-stream.js';

const REAL_FETCH = globalThis.fetch;

// ── SSE plumbing ────────────────────────────────────────────────────
function sseBody(events, chunkSize) {
  const text = events
    .map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
  const bytes = new TextEncoder().encode(text);
  const size = chunkSize || bytes.length;
  let offset = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (offset >= bytes.length) return { value: undefined, done: true };
        const value = bytes.slice(offset, offset + size);
        offset += size;
        return { value, done: false };
      },
      cancel: async () => {},
      releaseLock: () => {},
    }),
  };
}

function streamResponse(events, chunkSize) {
  return { ok: true, status: 200, body: sseBody(events, chunkSize) };
}

function errorResponse(status, message = 'boom') {
  return { ok: false, status, json: async () => ({ error: { message } }) };
}

// ── Canned rounds ───────────────────────────────────────────────────
const SEARCH_RESULTS = [
  { type: 'web_search_result', url: 'https://a.example', title: 'A' },
  { type: 'web_search_result', url: 'https://b.example', title: 'B' },
  { type: 'web_search_result', url: 'https://c.example', title: 'C' },
];

const NARRATION = `I'll verify this contact against public professional sources before answering. ${'Checking. '.repeat(30)}`;
const ANSWER = `{"state":"COMPLETE","identity":${JSON.stringify('x'.repeat(600))}}`;

// Round that runs one web search and then asks to be continued.
function searchRoundEvents() {
  return [
    { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: NARRATION } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"Kris ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'Huff Insight"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: SEARCH_RESULTS } },
    { type: 'content_block_stop', index: 2 },
    { type: 'ping' },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' } },
    { type: 'message_stop' },
  ];
}

// Round that writes the strict JSON answer and finishes.
function answerRoundEvents() {
  return [
    { type: 'message_start', message: { id: 'msg_2', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER.slice(0, 300) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER.slice(300) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://a.example' } } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

// Queue a scripted sequence of fetch outcomes and record what was sent.
function stubFetch(outcomes) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), init });
    const next = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : next;
  };
  return calls;
}

async function withFetch(outcomes, fn) {
  const calls = stubFetch(outcomes);
  try { return await fn(calls); } finally { globalThis.fetch = REAL_FETCH; }
}

function baseArgs(extra = {}) {
  return {
    apiKey: 'test-key',
    model: 'claude-opus-4-8',
    maxTokens: 16000,
    messages: [{ role: 'user', content: 'verify this contact' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 25 }],
    maxRounds: 6,
    backoffMs: [1],
    ...extra,
  };
}

// ── 1. Streaming request shape ──────────────────────────────────────

test('the research call streams and carries the web_search tool', async () => {
  await withFetch([streamResponse(answerRoundEvents())], async (calls) => {
    await runResearchStream(baseArgs());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].body.stream, true, 'stream must be on — the whole progress model depends on it');
    assert.equal(calls[0].body.tools[0].name, 'web_search');
    assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
    assert.equal(calls[0].init.headers['x-api-key'], 'test-key');
  });
});

// ── 2. Framing survives arbitrary chunk boundaries ──────────────────

test('SSE frames split across read() boundaries are still parsed', async () => {
  // 7 bytes per read guarantees frames are cut mid-JSON, mid-key and mid-value.
  await withFetch([streamResponse(answerRoundEvents(), 7)], async () => {
    const result = await runResearchStream(baseArgs());
    assert.equal(result.text, ANSWER);
    assert.equal(result.stopReason, 'end_turn');
  });
});

// ── 3. Reconstruction + continuation ────────────────────────────────

test('a pause_turn round is echoed back as a faithfully rebuilt assistant turn', async () => {
  await withFetch(
    [streamResponse(searchRoundEvents(), 11), streamResponse(answerRoundEvents(), 11)],
    async (calls) => {
      const result = await runResearchStream(baseArgs());

      assert.equal(result.rounds, 2);
      assert.equal(result.searches, 1);
      assert.equal(result.text, ANSWER, 'the answer is the LAST text block');

      // Round 2 must carry the original user turn plus the rebuilt assistant turn.
      assert.equal(calls.length, 2);
      const sent = calls[1].body.messages;
      assert.equal(sent.length, 2);
      assert.equal(sent[0].role, 'user');
      assert.equal(sent[1].role, 'assistant');

      const [narration, toolUse, toolResult] = sent[1].content;
      assert.equal(narration.type, 'text');
      assert.equal(narration.text, NARRATION);
      assert.equal(toolUse.type, 'server_tool_use');
      assert.equal(toolUse.id, 'srvtoolu_1');
      // The query streamed in two fragments and must be reassembled — this is
      // the payload the model continues its research from.
      assert.deepEqual(toolUse.input, { query: 'Kris Huff Insight' });
      assert.equal(toolResult.type, 'web_search_tool_result');
      assert.equal(toolResult.tool_use_id, 'srvtoolu_1');
      assert.equal(toolResult.content.length, 3);

      // The caller's own array is never mutated.
      assert.equal(calls[0].body.messages.length, 1);
    },
  );
});

test('citations streamed onto a text block are kept', async () => {
  await withFetch([streamResponse(answerRoundEvents())], async () => {
    const result = await runResearchStream(baseArgs());
    const [block] = result.content;
    assert.equal(block.citations.length, 1);
    assert.equal(block.citations[0].url, 'https://a.example');
  });
});

// ── 4. Progress events ──────────────────────────────────────────────

test('every real step of the research is reported', async () => {
  await withFetch(
    [streamResponse(searchRoundEvents()), streamResponse(answerRoundEvents())],
    async () => {
      const events = [];
      await runResearchStream(baseArgs({ onEvent: e => events.push(e) }));
      const byType = t => events.filter(e => e.type === t);

      assert.deepEqual(byType('round').map(e => e.round), [1, 2]);

      const search = byType('search');
      assert.equal(search.length, 1);
      assert.equal(search[0].query, 'Kris Huff Insight', 'the stage line shows what is being searched for');
      assert.equal(search[0].search, 1);

      const results = byType('results');
      assert.equal(results.length, 1);
      assert.equal(results[0].sources, 3);

      assert.ok(byType('narration').length >= 1, 'pre-search reasoning is reported');
      assert.ok(byType('writing').length >= 1, 'writing the JSON answer is reported');
      assert.equal(byType('pause').length, 1);
      assert.equal(byType('heartbeat').length, 1, 'a ping is liveness, and is labelled as such');

      // Reported character counts only ever grow.
      const chars = byType('writing').map(e => e.chars);
      assert.deepEqual(chars, [...chars].sort((a, b) => a - b));
    },
  );
});

test('search numbering continues across rounds rather than restarting', async () => {
  await withFetch(
    [streamResponse(searchRoundEvents()), streamResponse(searchRoundEvents()), streamResponse(answerRoundEvents())],
    async () => {
      const events = [];
      const result = await runResearchStream(baseArgs({ onEvent: e => events.push(e) }));
      assert.equal(result.searches, 2);
      assert.deepEqual(events.filter(e => e.type === 'search').map(e => e.search), [1, 2]);
    },
  );
});

test('a throwing progress listener cannot kill the run', async () => {
  await withFetch([streamResponse(answerRoundEvents())], async () => {
    const result = await runResearchStream(baseArgs({
      onEvent: () => { throw new Error('listener blew up'); },
    }));
    assert.equal(result.text, ANSWER);
  });
});

// ── 5. Retry ────────────────────────────────────────────────────────

test('an overloaded round is retried, and the retry is announced', async () => {
  await withFetch(
    [errorResponse(529, 'Overloaded'), streamResponse(answerRoundEvents())],
    async (calls) => {
      const events = [];
      const result = await runResearchStream(baseArgs({ onEvent: e => events.push(e) }));
      assert.equal(calls.length, 2, 'the round was retried');
      assert.equal(result.text, ANSWER);
      const retry = events.filter(e => e.type === 'retry');
      assert.equal(retry.length, 1);
      assert.equal(retry[0].status, 529);
      assert.equal(retry[0].round, 1);
    },
  );
});

test('a mid-stream overloaded_error event is retried like an HTTP 529', async () => {
  const broken = [
    { type: 'message_start', message: { id: 'm', content: [] } },
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  ];
  await withFetch([streamResponse(broken), streamResponse(answerRoundEvents())], async (calls) => {
    const result = await runResearchStream(baseArgs());
    assert.equal(calls.length, 2);
    assert.equal(result.text, ANSWER);
  });
});

test('a stream that ends without a stop_reason is an error, not an empty success', async () => {
  const cut = [
    { type: 'message_start', message: { id: 'm', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"state":' } },
  ];
  // Retried once, then succeeds — a dropped connection costs a round, not the run.
  await withFetch([streamResponse(cut), streamResponse(answerRoundEvents())], async (calls) => {
    const result = await runResearchStream(baseArgs());
    assert.equal(calls.length, 2);
    assert.equal(result.text, ANSWER);
  });
});

test('a permanent error is surfaced immediately without burning retries', async () => {
  await withFetch([errorResponse(400, 'invalid request')], async (calls) => {
    await assert.rejects(
      () => runResearchStream(baseArgs()),
      err => err.message === 'invalid request' && err.status === 400,
    );
    assert.equal(calls.length, 1, 'a 400 is a bug, not a blip');
  });
});

test('retries are bounded and the last error is what surfaces', async () => {
  await withFetch([errorResponse(529, 'Overloaded')], async (calls) => {
    await assert.rejects(() => runResearchStream(baseArgs({ maxAttempts: 3 })), /Overloaded/);
    assert.equal(calls.length, 3);
  });
});

test('a caller abort is never retried', async () => {
  const controller = new AbortController();
  await withFetch([() => { controller.abort(); return errorResponse(529, 'Overloaded'); }], async (calls) => {
    await assert.rejects(() => runResearchStream(baseArgs({ signal: controller.signal })));
    assert.equal(calls.length, 1);
  });
});

test('isRetryableResearchError separates blips from bugs', () => {
  assert.equal(isRetryableResearchError({ status: 429 }), true);
  assert.equal(isRetryableResearchError({ status: 529 }), true);
  assert.equal(isRetryableResearchError({ status: 503 }), true);
  assert.equal(isRetryableResearchError({ status: 400 }), false);
  assert.equal(isRetryableResearchError({ status: 401 }), false);
  assert.equal(isRetryableResearchError({ name: 'AbortError' }), false);
  assert.equal(isRetryableResearchError({ name: 'TimeoutError' }), true);
  // No status at all = a network-level failure.
  assert.equal(isRetryableResearchError(new TypeError('Failed to fetch')), true);
});

// ── 6. Round budget ─────────────────────────────────────────────────

test('the round budget is enforced and reported as such', async () => {
  const alwaysPause = () => streamResponse(searchRoundEvents());
  await withFetch([alwaysPause], async (calls) => {
    await assert.rejects(
      () => runResearchStream(baseArgs({ maxRounds: 3 })),
      err => err.code === 'RESEARCH_ROUNDS_EXHAUSTED',
    );
    assert.equal(calls.length, 3);
  });
});

// ── 7. Non-streaming fallback ───────────────────────────────────────

test('a response body without a reader falls back to the JSON shape', async () => {
  const plain = {
    ok: true,
    status: 200,
    json: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: ANSWER }],
    }),
  };
  await withFetch([plain], async () => {
    const result = await runResearchStream(baseArgs());
    assert.equal(result.text, ANSWER);
    assert.equal(result.stopReason, 'end_turn');
  });
});
