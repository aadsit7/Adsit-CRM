// ============================================================
// requestLeadCheckAnalysis — the row Analyze button's actual code path
// ============================================================
// The client is thin on purpose (the transport lives in
// anthropic-research-stream.js), so what is pinned here is the wiring the
// Analyze button depends on: the request shape, the progress the pill is drawn
// from, and the two stop_reasons that must become plain-English errors rather
// than a mangled parse.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setRuntimeConfig } from '../js/config.js';
import {
  requestLeadCheckAnalysis,
  LEADCHECK_MAX_ROUNDS,
  LEADCHECK_STALL_MS,
  LEADCHECK_IDLE_TIMEOUT_MS,
} from '../js/utils/partner-contact-leadcheck-client.js';

const REAL_FETCH = globalThis.fetch;

const CONTACT = { contact_id: 'c1', name: 'Kris Huff', company: 'Insight', email: 'kris.huff@insight.com' };
const NOW = '2026-08-10T00:00:00Z';
// The parser is exercised in full by partner-contact-leadcheck.test.mjs; here
// it only has to prove the streamed text reached it intact.
const REPORT = JSON.stringify({ state: 'COMPLETE', identity: { full_name: 'Kris Huff' } });

function sseResponse(events) {
  const bytes = new TextEncoder().encode(
    events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
  );
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (sent ? { value: undefined, done: true } : (sent = true, { value: bytes, done: false })),
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}

function searchRound() {
  return sseResponse([
    { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"Kris Huff Insight"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ url: 'https://a' }, { url: 'https://b' }] } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' } },
  ]);
}

function answerRound(stopReason = 'end_turn', text = REPORT) {
  return sseResponse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason } },
  ]);
}

async function withFetch(responses, fn) {
  setRuntimeConfig('ANTHROPIC_API_KEY', 'test-key');
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return next;
  };
  try { return await fn(calls); } finally { globalThis.fetch = REAL_FETCH; }
}

const args = (extra = {}) => ({
  contact: CONTACT,
  snapshot: { name: 'Kris Huff', company: 'Insight' },
  sourceMaterial: [],
  nowIso: NOW,
  ...extra,
});

test('the analysis streams, keeps web_search on, and returns the parsed report', async () => {
  await withFetch([searchRound(), answerRound()], async (calls) => {
    const report = await requestLeadCheckAnalysis(args());
    assert.equal(calls.length, 2, 'pause_turn continued the same research turn');
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].body.model, 'claude-opus-4-8');
    assert.equal(calls[0].body.tools[0].type, 'web_search_20250305');
    assert.equal(calls[0].body.tools[0].max_uses, 25);
    assert.ok(report.state, 'the streamed JSON reached the parser');
  });
});

test('progress reaches the caller as both round starts and per-step events', async () => {
  await withFetch([searchRound(), answerRound()], async () => {
    const rounds = [];
    const events = [];
    await requestLeadCheckAnalysis(args({
      onProgress: r => rounds.push(r),
      onEvent: e => events.push(e),
    }));

    // Back-compat: round starts still arrive on onProgress alone.
    assert.deepEqual(rounds, [1, 2]);

    const search = events.find(e => e.type === 'search');
    assert.equal(search.query, 'Kris Huff Insight');
    assert.equal(events.find(e => e.type === 'results').sources, 2);
    assert.ok(events.some(e => e.type === 'writing'), 'writing the verdict is reported');
  });
});

test('a refusal and a cut-off answer become plain-English errors', async () => {
  await withFetch([answerRound('refusal', '')], async () => {
    await assert.rejects(() => requestLeadCheckAnalysis(args()), /declined to research/);
  });
  await withFetch([answerRound('max_tokens', '{"state":"COMPL')], async () => {
    await assert.rejects(() => requestLeadCheckAnalysis(args()), /cut off/);
  });
});

test('a missing API key is refused before any request is made', async () => {
  setRuntimeConfig('ANTHROPIC_API_KEY', '');
  let called = false;
  globalThis.fetch = async () => { called = true; };
  try {
    await assert.rejects(() => requestLeadCheckAnalysis(args()), /API key not set/);
    assert.equal(called, false);
  } finally { globalThis.fetch = REAL_FETCH; }
});

test('the budgets the pill is sized from are exported and sane', () => {
  assert.equal(LEADCHECK_MAX_ROUNDS, 6);
  // Both are SILENCE budgets now, not durations. The give-up budget has to
  // clear one idle timeout plus its retry backoff and reconnect, with room to
  // spare — and nothing like the 24 minutes a black-box round used to need.
  assert.ok(LEADCHECK_STALL_MS > LEADCHECK_IDLE_TIMEOUT_MS * 2);
  assert.ok(LEADCHECK_STALL_MS <= 10 * 60_000);
});
