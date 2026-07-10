// ============================================================
// Timeline PDF API client — calls Anthropic Messages API
// ============================================================

import { getRuntimeConfig } from '../config.js';
import { buildTimelinePrompt } from './timeline-pdf-prompts.js';
import { parseTimelineJsonResponse } from './timeline-pdf-schema.js';

const TIMELINE_MODEL      = 'claude-opus-4-7';
const TIMELINE_MAX_TOKENS = 16000;
const TIMELINE_TIMEOUT_MS = 120_000;

function requireApiKey() {
  const key = getRuntimeConfig('ANTHROPIC_API_KEY');
  if (!key) throw new Error('API key not set. Configure it on the Setup page or click the 🔑 icon in AI Assistant.');
  return key;
}

function buildHeaders(apiKey) {
  return {
    'Content-Type':  'application/json',
    'x-api-key':     apiKey,
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
 * Ask Claude to produce a timeline JSON from opportunity description entries.
 *
 * @param {object} opportunity        { name / customerName, ... }
 * @param {Array}  descriptionEntries Array of { date, content } (or text / description_text)
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} Parsed + validated timeline JSON.
 */
export async function requestTimelineJsonPdf(opportunity, descriptionEntries, signal) {
  const apiKey = requireApiKey();
  const prompt = buildTimelinePrompt(opportunity, descriptionEntries);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({
      model:      TIMELINE_MODEL,
      max_tokens: TIMELINE_MAX_TOKENS,
      messages:   [{ role: 'user', content: prompt }],
    }),
    signal: makeTimeoutSignal(signal, TIMELINE_TIMEOUT_MS),
  });

  if (!response.ok) {
    let errBody = {};
    try { errBody = await response.json(); } catch { /* ignore */ }
    const msg = errBody.error?.message || `API error: ${response.status}`;
    console.error('[Timeline JSON] API error', { status: response.status, body: errBody });
    const err = new Error(msg);
    err.status = response.status;
    err.code   = 'TIMELINE_JSON_API_ERROR';
    throw err;
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');

  return parseTimelineJsonResponse(text);
}
