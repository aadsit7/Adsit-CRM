// ============================================================
// Anthropic research stream — the shared runner for web-search research
// ============================================================
// Every "Randy is researching this for you" feature (LeadCheck on a contact
// row, the Account Intelligence Brief on the Forecast tab) runs the same
// Messages call: server-side `web_search` enabled, and a bounded pause_turn
// continuation loop because a long research turn comes back asking to be
// resumed. This module owns that loop once, so the two clients above are left
// holding only their own prompt and their own parser.
//
// ── Why it streams ──────────────────────────────────────────────────
// The loop used to POST without `stream`, which made every round a black box:
// one request, up to four minutes, zero output until it landed. That has two
// costs, and the visible one is the progress bar.
//
// The only progress fact a non-streaming loop has is "round N started", so a
// bar could only ever be drawn in sixths — and since a healthy run finishes in
// one or two rounds, the bar spent the entire analysis in its bottom sixth and
// then jumped to done. It looked stuck because it WAS stuck: there was nothing
// to report. Worse, a silent four-minute round trips the pill's "taking longer
// than expected" warning at 2:30 on a run that is perfectly healthy.
//
// Streaming replaces the guess with observation. Every search the model runs,
// every result set it reads, and every character of the answer it writes
// arrives as an event, so the bar moves on things that actually happened and
// the stage line can say which one. The same event flow is what proves the job
// is alive, which is what the pill's give-up timer measures.
//
// The second cost is reliability, and it is why the round has a retry and an
// IDLE timeout rather than a total one. A four-minute wall clock cannot tell a
// wedged request from a thorough one, so it had to be set long enough for the
// worst case — by which point it no longer catches anything. Bytes arriving is
// the real signal: this runner gives up on a round that has said nothing for
// two minutes, then retries it, so a dropped connection or an overloaded
// window costs one round instead of the whole analysis.
//
// Pure transport + progress. No DOM, no prompt knowledge, no schema knowledge.
// ============================================================

const API_URL = 'https://api.anthropic.com/v1/messages';

// No data at all for this long means the round is wedged, not thorough. A
// server-side search round-trip is seconds and the answer streams continuously,
// so two minutes of true silence is already far outside normal.
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
// Backstop for a round that keeps trickling bytes forever.
export const DEFAULT_ROUND_TIMEOUT_MS = 600_000;
// Attempts per round, not per run: the conversation built up so far is kept, so
// a retry re-runs the current round only.
export const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [2_000, 6_000, 15_000];

// Worth another go: rate limits, overload, gateway noise, and anything that
// never produced an HTTP status at all (a dropped connection). A 400/401/403
// is a bug or a bad key — retrying just delays the error the user needs.
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

// Mid-stream error events carry a type instead of a status; map them onto the
// equivalent status so the one retry rule above covers both shapes.
const STREAM_ERROR_STATUS = {
  overloaded_error: 529,
  api_error: 500,
  rate_limit_error: 429,
  timeout_error: 408,
};

// Text arrives a few characters at a time. Reporting every delta would fire
// thousands of DOM writes per answer, so progress is announced in chunks —
// small enough that the bar still moves visibly while the answer is written.
const TEXT_EVENT_CHARS = 200;

function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

// A progress callback is decoration; the research is the work. A throwing
// listener must never take down a run that is minutes deep.
function emit(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try { onEvent(event); } catch (err) { console.error('[research-stream] progress listener threw', err); }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(signal.reason || new DOMException('Aborted', 'AbortError')); return; }
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    function cleanup() {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function isRetryableResearchError(err) {
  if (!err) return false;
  // The caller cancelled — never fight a deliberate abort.
  if (err.name === 'AbortError') return false;
  if (err.retryable === true) return true;
  // Our own idle / round budget fired: the round is wedged, a fresh one may not be.
  if (err.name === 'TimeoutError') return true;
  if (Number.isFinite(err.status) && err.status > 0) return RETRYABLE_STATUS.has(err.status);
  // No status at all — a network-level failure. Worth one more go.
  return true;
}

// ── Per-round abort budget ──────────────────────────────────────────
// Composed by hand rather than with AbortSignal.any so the idle clock can be
// restarted on every chunk: the round is killed for saying nothing, not for
// taking a while. The caller's own signal still aborts immediately, and its
// reason is preserved so a user cancel stays distinguishable from a timeout.
function makeRoundAbort({ signal, idleTimeoutMs, roundTimeoutMs }) {
  const controller = new AbortController();
  let idleTimer = null;
  let capTimer = null;

  const failWith = (message) => {
    if (controller.signal.aborted) return;
    controller.abort(new DOMException(message, 'TimeoutError'));
  };

  const onOuterAbort = () => {
    if (controller.signal.aborted) return;
    controller.abort((signal && signal.reason) || new DOMException('Aborted', 'AbortError'));
  };

  const bump = () => {
    if (controller.signal.aborted) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => failWith('The research stream went quiet — nothing received'), idleTimeoutMs);
  };

  const dispose = () => {
    clearTimeout(idleTimer);
    clearTimeout(capTimer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  };

  capTimer = setTimeout(() => failWith('The research round ran past its time budget'), roundTimeoutMs);
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  bump();

  return { signal: controller.signal, bump, dispose };
}

// ── SSE framing ─────────────────────────────────────────────────────
// One event per blank-line-delimited frame; per the SSE spec a frame may carry
// several `data:` lines that concatenate. Anthropic sends one, but honouring
// the spec costs two lines and removes a whole class of "worked until it
// didn't" parsing bugs.
function parseSseFrame(raw) {
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return null;
  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') return null;
  try { return JSON.parse(payload); } catch { return null; }
}

// The answer is JSON. Once a text block opens with `{` (or a fenced block) the
// model has stopped narrating and started writing the thing we asked for —
// which is a different stage to the user, and a different part of the bar.
function looksLikeAnswer(text) {
  const head = String(text || '').replace(/^\s+/, '').slice(0, 8);
  return head.startsWith('{') || head.startsWith('```');
}

function cloneBlock(block) {
  if (!block || typeof block !== 'object') return { type: 'text', text: '' };
  // Structured-clone semantics without depending on structuredClone: the
  // blocks are plain JSON by construction.
  try { return JSON.parse(JSON.stringify(block)); } catch { return { ...block }; }
}

// The strict JSON answer is in the LAST text block — everything before it is
// pre-search narration. Same rule the non-streaming path used.
function lastTextOf(content) {
  let text = '';
  for (const block of content || []) {
    if (block && block.type === 'text' && typeof block.text === 'string') text = block.text;
  }
  return text;
}

function countSearches(content) {
  let n = 0;
  for (const block of content || []) if (block && block.type === 'server_tool_use') n += 1;
  return n;
}

// ── Stream → content blocks ─────────────────────────────────────────
// Rebuilds exactly the `content` array a non-streaming response would have
// returned. That fidelity is not cosmetic: on `pause_turn` the array is posted
// straight back as the assistant turn, so a block dropped or malformed here
// would silently change what the model is continuing from.
async function consumeStream(response, { abort, onEvent, round, searchOffset }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const blocks = [];      // index → reconstructed content block
  const partialJson = []; // index → accumulated tool-input JSON text
  const announced = [];   // index → text length already reported as progress
  let searches = 0;
  let stopReason = null;
  let drained = false;

  const flushText = (i) => {
    const block = blocks[i];
    if (!block || block.type !== 'text') return;
    const chars = (block.text || '').length;
    if (chars <= (announced[i] || 0)) return;
    announced[i] = chars;
    emit(onEvent, {
      type: looksLikeAnswer(block.text) ? 'writing' : 'narration',
      round,
      chars,
    });
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { drained = true; break; }
      // Bytes arrived — whatever they are, the round is alive.
      abort.bump();
      // Normalize on the buffer rather than per chunk, so a CRLF split across
      // a read boundary still collapses.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const evt = parseSseFrame(frame);
        if (!evt) continue;

        switch (evt.type) {
          case 'ping':
            // Liveness only. Deliberately NOT reported as progress: the
            // connection being open says nothing about the work moving, and a
            // give-up timer fed by pings would never fire.
            emit(onEvent, { type: 'heartbeat', round });
            break;

          case 'error': {
            const err = new Error(evt.error?.message || 'The research stream failed.');
            // Unknown error types map to 400, not 0: a status of 0 reads as
            // "network-level, worth another go" to isRetryableResearchError,
            // but an unrecognized mid-stream error (invalid_request_error,
            // say) is deterministic — retrying re-POSTs the same bad payload
            // and just delays the message the user needs.
            err.status = STREAM_ERROR_STATUS[evt.error?.type] || 400;
            err.code = 'RESEARCH_STREAM_ERROR';
            throw err;
          }

          case 'content_block_start': {
            const i = Number.isInteger(evt.index) ? evt.index : blocks.length;
            blocks[i] = cloneBlock(evt.content_block);
            partialJson[i] = '';
            announced[i] = 0;
            // Search results are not model-generated, so the whole block
            // arrives here — the one moment we can count sources.
            if (blocks[i].type === 'web_search_tool_result') {
              emit(onEvent, {
                type: 'results',
                round,
                search: searchOffset + searches,
                sources: Array.isArray(blocks[i].content) ? blocks[i].content.length : 0,
              });
            }
            break;
          }

          case 'content_block_delta': {
            const i = Number.isInteger(evt.index) ? evt.index : 0;
            if (!blocks[i]) { blocks[i] = { type: 'text', text: '' }; announced[i] = 0; }
            const block = blocks[i];
            const delta = evt.delta || {};
            if (delta.type === 'text_delta') {
              block.text = (block.text || '') + (delta.text || '');
              if ((block.text.length - (announced[i] || 0)) >= TEXT_EVENT_CHARS) flushText(i);
            } else if (delta.type === 'input_json_delta') {
              partialJson[i] = (partialJson[i] || '') + (delta.partial_json || '');
            } else if (delta.type === 'citations_delta' && delta.citation) {
              (block.citations || (block.citations = [])).push(delta.citation);
            } else if (delta.type === 'thinking_delta') {
              block.thinking = (block.thinking || '') + (delta.thinking || '');
            } else if (delta.type === 'signature_delta') {
              block.signature = (block.signature || '') + (delta.signature || '');
            }
            break;
          }

          case 'content_block_stop': {
            const i = Number.isInteger(evt.index) ? evt.index : 0;
            const block = blocks[i];
            if (!block) break;
            if (partialJson[i]) {
              // A tool input that fails to parse keeps the `{}` the start event
              // gave us rather than poisoning the continuation payload.
              try { block.input = JSON.parse(partialJson[i]); } catch { /* keep {} */ }
            }
            if (block.type === 'server_tool_use') {
              searches += 1;
              emit(onEvent, {
                type: 'search',
                round,
                search: searchOffset + searches,
                query: String(block.input?.query || '').trim(),
              });
            }
            flushText(i);
            break;
          }

          case 'message_delta':
            if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
            break;

          default:
            break;
        }
      }
    }
  } finally {
    // Bailing out mid-stream (an error frame, a retryable break) leaves the
    // body unconsumed. Cancel it before letting go, or the socket lingers while
    // the retry opens another one.
    if (!drained) { try { await reader.cancel(); } catch { /* already gone */ } }
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  // No stop_reason means the connection ended mid-answer. Silently treating a
  // truncated stream as a finished one is how a run "completes" with nothing in
  // it, so this is an error — and a retryable one, because it usually isn't ours.
  if (!stopReason) {
    const err = new Error('The research stream ended before the model finished.');
    err.code = 'RESEARCH_STREAM_TRUNCATED';
    err.retryable = true;
    throw err;
  }

  const content = blocks.filter(Boolean);
  return { content, text: lastTextOf(content), stopReason, searches };
}

async function runRoundOnce({
  apiKey, body, idleTimeoutMs, roundTimeoutMs, signal, onEvent, round, searchOffset, logTag,
}) {
  const abort = makeRoundAbort({ signal, idleTimeoutMs, roundTimeoutMs });
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: abort.signal,
    });

    if (!response.ok) {
      let errBody = {};
      try { errBody = await response.json(); } catch { /* non-JSON error body */ }
      const message = errBody.error?.message || `API error: ${response.status}`;
      console.error(`[${logTag}] API error`, { status: response.status, body: errBody });
      const err = new Error(message);
      err.status = response.status;
      err.code = 'RESEARCH_API_ERROR';
      throw err;
    }

    // Defensive: an environment whose fetch has no readable body (a proxy or a
    // test double) still returns the same message shape, so fall back to it
    // rather than failing a run over the transport.
    if (!response.body || typeof response.body.getReader !== 'function') {
      const data = await response.json();
      const content = Array.isArray(data.content) ? data.content : [];
      return { content, text: lastTextOf(content), stopReason: data.stop_reason || null, searches: countSearches(content) };
    }

    return await consumeStream(response, { abort, onEvent, round, searchOffset });
  } finally {
    abort.dispose();
  }
}

async function runRoundWithRetry(opts) {
  const { maxAttempts, onEvent, round, signal, logTag, backoffMs } = opts;
  const backoff = Array.isArray(backoffMs) && backoffMs.length ? backoffMs : RETRY_BACKOFF_MS;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runRoundOnce({ ...opts, attempt });
    } catch (err) {
      lastErr = err;
      const cancelled = (signal && signal.aborted) || err?.name === 'AbortError';
      if (cancelled || attempt >= maxAttempts || !isRetryableResearchError(err)) throw err;
      const delayMs = backoff[Math.min(attempt - 1, backoff.length - 1)];
      console.warn(`[${logTag}] round ${round} attempt ${attempt} failed: ${err.message} — retrying in ${delayMs}ms`);
      // Announced, not swallowed: a user watching a bar deserves to know the
      // pause is a retry rather than a hang.
      emit(onEvent, {
        type: 'retry', round, attempt, delayMs,
        status: Number(err.status) || 0,
        message: err.message || '',
      });
      await sleep(delayMs, signal);
    }
  }

  throw lastErr;
}

/**
 * Run a bounded web-search research conversation and return its final text.
 *
 * Progress is reported through `onEvent`, which receives (in rough order):
 *   { type: 'round',     round, maxRounds }
 *   { type: 'search',    round, search, query }    — a web search was issued
 *   { type: 'results',   round, search, sources }  — its results came back
 *   { type: 'narration', round, chars }            — model is reasoning aloud
 *   { type: 'writing',   round, chars }            — model is writing the JSON
 *   { type: 'retry',     round, attempt, delayMs, status, message }
 *   { type: 'pause',     round, searches }         — pause_turn continuation
 *   { type: 'heartbeat', round }                   — connection alive only
 *
 * @returns {Promise<{ text: string, stopReason: string, content: Array, rounds: number, searches: number }>}
 */
export async function runResearchStream({
  apiKey,
  model,
  maxTokens,
  messages = [],
  tools = [],
  maxRounds = 6,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  roundTimeoutMs = DEFAULT_ROUND_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = RETRY_BACKOFF_MS,
  signal,
  onEvent,
  logTag = 'Research',
} = {}) {
  // The caller's array is theirs; continuations are appended to our copy.
  const convo = [...messages];
  let searches = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    emit(onEvent, { type: 'round', round, maxRounds });

    const result = await runRoundWithRetry({
      apiKey,
      body: {
        model,
        max_tokens: maxTokens,
        ...(tools && tools.length ? { tools } : {}),
        messages: convo,
        stream: true,
      },
      idleTimeoutMs,
      roundTimeoutMs,
      maxAttempts,
      backoffMs,
      signal,
      onEvent,
      round,
      searchOffset: searches,
      logTag,
    });

    searches += result.searches;

    if (result.stopReason === 'pause_turn') {
      // Continue the same research turn with the partial content appended.
      convo.push({ role: 'assistant', content: result.content });
      emit(onEvent, { type: 'pause', round, searches });
      continue;
    }

    return {
      text: result.text,
      stopReason: result.stopReason,
      content: result.content,
      rounds: round,
      searches,
    };
  }

  const err = new Error('The research did not finish within the allowed number of rounds — try again.');
  err.code = 'RESEARCH_ROUNDS_EXHAUSTED';
  throw err;
}
