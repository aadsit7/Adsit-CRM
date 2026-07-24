// ============================================================
// LeadCheck API client — Anthropic Messages API with server-side web search
// ============================================================
// Same conventions as the other analyzer clients (headers, key, model,
// timeout style). Two differences, both required by the research workflow:
//   • the server-side web_search tool is enabled — Anthropic executes the
//     searches, the browser only makes the Messages call;
//   • long research turns can return stop_reason "pause_turn" — the API
//     asks us to send the partial content back and let it continue, so the
//     call loops (bounded) until a final text answer arrives.
// The strict JSON answer is in the LAST text block; earlier text blocks are
// pre-search narration. Validation lives in partner-contact-leadcheck.js.
// ============================================================

import { getRuntimeConfig } from '../config.js';
import { buildLeadCheckPrompt, parseLeadCheckResponse } from './partner-contact-leadcheck.js';

const LEADCHECK_MODEL = 'claude-opus-4-8';
const LEADCHECK_MAX_TOKENS = 16000;
const LEADCHECK_REQUEST_TIMEOUT_MS = 240_000; // per round — research turns are long
const LEADCHECK_MAX_ROUNDS = 6;               // pause_turn continuations
const LEADCHECK_MAX_SEARCHES = 25;            // web_search max_uses per round

function requireApiKey() {
  const key = getRuntimeConfig('ANTHROPIC_API_KEY');
  if (!key) throw new Error('API key not set. Configure it on the Setup page or click the 🔑 icon in AI Assistant.');
  return key;
}

function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

function makeTimeoutSignal(signal, ms) {
  const ts = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : (() => {
        const c = new AbortController();
        setTimeout(() => c.abort(new DOMException('Request timed out', 'TimeoutError')), ms);
        return c.signal;
      })();
  if (!signal) return ts;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, ts]) : signal;
}

/**
 * Run the LeadCheck research for ONE contact snapshot and return the
 * validated report.
 *
 * @param {object} params
 * @param {object} params.contact        The selected contact (for validation context).
 * @param {object} params.snapshot       buildLeadCheckSnapshot().snapshot
 * @param {Array}  params.sourceMaterial buildLeadCheckSnapshot().sourceMaterial
 * @param {string} params.nowIso         Timestamp used for the loop check.
 * @param {string} [params.timezone]
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.onProgress] (roundNumber) => void
 * @returns {Promise<object>} validated LeadCheck report
 */
export async function requestLeadCheckAnalysis({
  contact, snapshot, sourceMaterial, nowIso, timezone = 'UTC', signal, onProgress,
} = {}) {
  const apiKey = requireApiKey();
  const prompt = buildLeadCheckPrompt({ snapshot, sourceMaterial, nowIso, timezone });
  const messages = [{ role: 'user', content: prompt }];

  for (let round = 1; round <= LEADCHECK_MAX_ROUNDS; round++) {
    if (typeof onProgress === 'function') onProgress(round);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model: LEADCHECK_MODEL,
        max_tokens: LEADCHECK_MAX_TOKENS,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: LEADCHECK_MAX_SEARCHES }],
        messages,
      }),
      signal: makeTimeoutSignal(signal, LEADCHECK_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      let errBody = {};
      try { errBody = await response.json(); } catch { /* ignore */ }
      const msg = errBody.error?.message || `API error: ${response.status}`;
      console.error('[LeadCheck] API error', { status: response.status, body: errBody });
      const err = new Error(msg);
      err.status = response.status;
      err.code = 'LEADCHECK_API_ERROR';
      throw err;
    }

    const data = await response.json();

    if (data.stop_reason === 'refusal') {
      throw new Error('The model declined to research this contact.');
    }
    if (data.stop_reason === 'pause_turn') {
      // Continue the same research turn with the partial content appended.
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    if (data.stop_reason === 'max_tokens') {
      throw new Error('The analysis output was cut off before completing — try again.');
    }

    // Final answer: the strict JSON is in the LAST text block.
    let text = '';
    for (const block of data.content || []) {
      if (block?.type === 'text' && typeof block.text === 'string') text = block.text;
    }
    return parseLeadCheckResponse(text, { contact, nowIso });
  }

  throw new Error('The research did not finish within the allowed number of rounds — try again.');
}
