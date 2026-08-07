// ============================================================
// Partner Bio API client — Anthropic Messages API + restricted web search
// ============================================================
// Same conventions as the sibling analyzer clients (headers, configured key,
// timeout helper, error-code style, pause_turn continuation loop). Two things
// are specific to this one:
//
//   • the server-side web_search tool is pinned to the authoritative domains
//     from the research brief via allowed_domains, so "search exclusively
//     these websites" is enforced by the API rather than by asking the model
//     nicely. A query outside that set simply returns nothing, which is what
//     turns an unverifiable field into an honest "NA";
//   • research turns are long and run over many rounds, so the loop is
//     generous — the caller drives a progress pill from onProgress.
//
// The strict JSON answer is in the LAST text block; earlier blocks are
// pre-search narration. Validation lives in partner-bio-schema.js.
// ============================================================

import { getRuntimeConfig } from '../config.js';
import { buildPartnerBioPrompt, AUTHORITATIVE_DOMAINS } from './partner-bio-prompts.js';
import { parsePartnerBioResponse } from './partner-bio-schema.js';

// The current Opus, which is also what the web_search_20260209 tool version
// (search results filtered before they reach the context window) requires.
const BIO_MODEL = 'claude-opus-5';
const BIO_MAX_TOKENS = 16000;
const BIO_REQUEST_TIMEOUT_MS = 240_000; // per round — research turns are long
// Exported so a caller's progress bar is sized by the SAME number the loop
// runs on, instead of a copy that can drift out of step with it.
export const BIO_MAX_ROUNDS = 8;        // pause_turn continuations
const BIO_MAX_SEARCHES = 30;            // web_search max_uses per round

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
 * Research one partner company on the authoritative sources and return the
 * validated bio.
 *
 * @param {object} params
 * @param {object} params.partner    The CRM partner row (search seed only).
 * @param {string} [params.today]    YYYY-MM-DD.
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.onProgress] (roundNumber) => void
 * @returns {Promise<object>} the validated bio
 */
export async function requestPartnerBio({ partner, today = '', signal, onProgress } = {}) {
  const apiKey = requireApiKey();
  const prompt = buildPartnerBioPrompt({ partner, today });

  // Prompt caching (output-neutral): the research runs as a pause_turn loop
  // that re-POSTs the whole message array every round, and the first user turn
  // — the brief, the source list, the protocols and the schema — is
  // byte-identical each time. Marking it lets rounds 2..N read it from
  // Anthropic's cache instead of reprocessing it. A single text block with the
  // same text tokenizes identically to the bare string, so results are
  // unchanged; only per-round time-to-first-token drops. Below the model's
  // minimum cacheable size the marker silently no-ops.
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
  }];

  for (let round = 1; round <= BIO_MAX_ROUNDS; round += 1) {
    if (typeof onProgress === 'function') onProgress(round);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model: BIO_MODEL,
        max_tokens: BIO_MAX_TOKENS,
        tools: [{
          type: 'web_search_20260209',
          name: 'web_search',
          max_uses: BIO_MAX_SEARCHES,
          // The research brief's "search exclusively these websites", enforced
          // by the API. Anything else is simply unreachable for this call.
          allowed_domains: AUTHORITATIVE_DOMAINS,
        }],
        messages,
      }),
      signal: makeTimeoutSignal(signal, BIO_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      let errBody = {};
      try { errBody = await response.json(); } catch { /* ignore */ }
      const msg = errBody.error?.message || `API error: ${response.status}`;
      console.error('[Partner Bio] API error', { status: response.status, body: errBody });
      const err = new Error(msg);
      err.status = response.status;
      err.code = 'PARTNER_BIO_API_ERROR';
      throw err;
    }

    const data = await response.json();

    if (data.stop_reason === 'refusal') {
      throw new Error('The model declined to research this company.');
    }
    if (data.stop_reason === 'pause_turn') {
      // Continue the same research turn with the partial content appended.
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }

    // Final (or cut-off) answer: the strict JSON is in the LAST text block.
    let text = '';
    for (const block of data.content || []) {
      if (block?.type === 'text' && typeof block.text === 'string') text = block.text;
    }
    // On max_tokens the JSON tail is cut off; the parser repairs a truncated
    // object rather than discarding a mostly-complete profile.
    return parsePartnerBioResponse(text, {
      partnerName: String(partner && partner.display_name || '').trim(),
    });
  }

  throw new Error('The research did not finish within the allowed number of rounds — try again.');
}
