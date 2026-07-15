// ============================================================
// Forecast API client — calls the Anthropic Messages API
// ============================================================
// Copied from timeline-pdf-client.js: same headers, same timeout helper,
// same error-code style. Builds the prompt, calls Claude, and hands the
// raw text to the strict parser — passing the real note ids so the parser
// can reject evidence that cites a note which doesn't exist.
//
// The model string matches the value used everywhere else in this app
// (timeline-pdf-client.js, ai.js). No `temperature` is sent — it is not a
// valid parameter on this model (see the comment at js/utils/ai.js:901).
// ============================================================

import { getRuntimeConfig } from '../config.js';
import { buildForecastPrompt, stripHtml } from './forecast-prompts.js';
import { parseForecastJsonResponse } from './forecast-schema.js';

const FORECAST_MODEL      = 'claude-opus-4-7';
const FORECAST_MAX_TOKENS = 16000;
const FORECAST_TIMEOUT_MS = 120_000;

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

// The ids and dates the model is actually allowed to cite. Anything the
// model cites outside these sets is a fabrication the parser strips (and
// an otherwise-unanchored claim gets downgraded to no_evidence). The date
// set mirrors exactly what buildForecastPrompt shows the model per note
// (description_date, falling back to created_at).
function collectSourceIds(descriptions) {
  const ids = new Set();
  (descriptions || []).forEach(d => {
    const id = String(d?.description_id || '').trim();
    if (id) ids.add(id);
  });
  return ids;
}

function collectSourceDates(descriptions) {
  const dates = new Set();
  (descriptions || []).forEach(d => {
    const date = String(d?.description_date || d?.created_at || '').trim();
    if (date) dates.add(date);
  });
  return dates;
}

// The note prose the model was shown, keyed by id and by date, so the parser
// can ground each evidence quote against the exact text it quoted from
// (guard #3). Text is stripped to plain prose the same way buildForecastPrompt
// strips it, so a match reflects what the model actually read. Notes sharing a
// date are concatenated — a quote grounded in ANY note on that date passes.
function collectSourceTexts(descriptions) {
  const byId = {};
  const byDate = {};
  (descriptions || []).forEach(d => {
    const text = stripHtml(d?.description_text || d?.text || '');
    if (!text) return;
    const id = String(d?.description_id || '').trim();
    const date = String(d?.description_date || d?.created_at || '').trim();
    if (id) byId[id] = byId[id] ? `${byId[id]}\n${text}` : text;
    if (date) byDate[date] = byDate[date] ? `${byDate[date]}\n${text}` : text;
  });
  return { byId, byDate };
}

/**
 * Ask Claude to score the forecast board for one opportunity.
 *
 * @param {object} opportunity   Opportunities row
 * @param {Array}  descriptions  Opportunity_Descriptions rows for this opp
 * @param {Array}  documents     Drive doc metadata ({ file_name, analyzed }) — weak context
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} Parsed + validated forecast JSON.
 */
export async function requestForecastJson(opportunity, descriptions, documents, signal) {
  const apiKey = requireApiKey();
  const prompt = buildForecastPrompt(opportunity, descriptions, documents);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({
      model:      FORECAST_MODEL,
      max_tokens: FORECAST_MAX_TOKENS,
      messages:   [{ role: 'user', content: prompt }],
    }),
    signal: makeTimeoutSignal(signal, FORECAST_TIMEOUT_MS),
  });

  if (!response.ok) {
    let errBody = {};
    try { errBody = await response.json(); } catch { /* ignore */ }
    const msg = errBody.error?.message || `API error: ${response.status}`;
    console.error('[Forecast JSON] API error', { status: response.status, body: errBody });
    const err = new Error(msg);
    err.status = response.status;
    err.code   = 'FORECAST_JSON_API_ERROR';
    throw err;
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');

  const sourceTexts = collectSourceTexts(descriptions);
  return parseForecastJsonResponse(text, {
    validSourceIds:    collectSourceIds(descriptions),
    validSourceDates:  collectSourceDates(descriptions),
    sourceTextById:    sourceTexts.byId,
    sourceTextByDate:  sourceTexts.byDate,
  });
}
