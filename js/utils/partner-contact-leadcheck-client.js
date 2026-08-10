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
//
// The transport for both of those — the SSE stream, the continuation loop,
// the per-round idle budget and retry — lives in anthropic-research-stream.js
// and is shared with the contact-brief client. What is left here is this
// analysis's own prompt, its own budgets, and its own parser.
// ============================================================

import { getRuntimeConfig } from '../config.js';
import { buildLeadCheckPrompt, parseLeadCheckResponse } from './partner-contact-leadcheck.js';
import { runResearchStream } from './anthropic-research-stream.js';

const LEADCHECK_MODEL = 'claude-opus-4-8';
const LEADCHECK_MAX_TOKENS = 16000;
const LEADCHECK_MAX_SEARCHES = 25;            // web_search max_uses per round

// Exported so the progress pill can size its bar from the SAME number the loop
// runs on. A view that hard-coded its own "6" would silently misreport the
// moment this budget changed — round 7 of 6, or a bar that stops at 75%.
export const LEADCHECK_MAX_ROUNDS = 6;        // pause_turn continuations

// How long the run may say NOTHING before a round is abandoned and retried.
// The research streams: searches, their results, and every character of the
// answer all arrive as events, so silence here is a wedged connection rather
// than a thorough analysis.
export const LEADCHECK_IDLE_TIMEOUT_MS = 120_000;

// The give-up budget the caller hands its pill. It measures silence too, so it
// only has to clear the longest legitimate quiet stretch — one idle timeout,
// its retry backoff, and the reconnect — with room to spare. It used to be
// 6 rounds x 4 minutes (24 min) because a non-streaming round was a black box
// for its whole duration; with real events there is no reason to wait that long
// before telling the user something is wrong.
export const LEADCHECK_STALL_MS = 300_000;

function requireApiKey() {
  const key = getRuntimeConfig('ANTHROPIC_API_KEY');
  if (!key) throw new Error('API key not set. Configure it on the Setup page or click the 🔑 icon in AI Assistant.');
  return key;
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
 * @param {Function} [params.onProgress] (roundNumber) => void — round starts only.
 * @param {Function} [params.onEvent]    (event) => void — every research event;
 *                                       see runResearchStream for the shapes.
 * @returns {Promise<object>} validated LeadCheck report
 */
export async function requestLeadCheckAnalysis({
  contact, snapshot, sourceMaterial, nowIso, timezone = 'UTC', signal, onProgress, onEvent,
} = {}) {
  const apiKey = requireApiKey();
  const prompt = buildLeadCheckPrompt({ snapshot, sourceMaterial, nowIso, timezone });

  const { text, stopReason } = await runResearchStream({
    apiKey,
    model: LEADCHECK_MODEL,
    maxTokens: LEADCHECK_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: LEADCHECK_MAX_SEARCHES }],
    maxRounds: LEADCHECK_MAX_ROUNDS,
    idleTimeoutMs: LEADCHECK_IDLE_TIMEOUT_MS,
    signal,
    logTag: 'LeadCheck',
    onEvent: (event) => {
      // Round starts are still forwarded to onProgress so existing callers
      // (and their round-shaped bars) keep working unchanged.
      if (event.type === 'round' && typeof onProgress === 'function') onProgress(event.round);
      if (typeof onEvent === 'function') onEvent(event);
    },
  });

  if (stopReason === 'refusal') {
    throw new Error('The model declined to research this contact.');
  }
  if (stopReason === 'max_tokens') {
    throw new Error('The analysis output was cut off before completing — try again.');
  }

  return parseLeadCheckResponse(text, { contact, nowIso });
}
