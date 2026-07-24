// ============================================================
// Event analyzer API client — calls the Anthropic Messages API
// ============================================================
// Follows forecast-client.js conventions exactly: same headers, same
// timeout helper, same error-code style, the SAME configured Anthropic key
// and model string used everywhere else in the app. It builds the event
// prompt, calls Claude, and hands the raw text to the strict parser —
// passing the real note ids/dates/texts AND the deterministic/structured
// facts so the parser can reject unsupported claims and overlay the hard
// CRM facts itself.
//
// No second authentication mechanism is introduced — the key comes from
// getRuntimeConfig('ANTHROPIC_API_KEY') like every other AI call.
// ============================================================

import { getRuntimeConfig } from '../config.js';
import { buildEventAnalyzerPrompt } from './event-analyzer-prompts.js';
import { parseEventAnalysisResponse } from './event-analyzer-schema.js';
import { stripHtml } from './forecast-prompts.js';
import {
  buildContactAggregates,
  buildLinkedOppFacts,
  parseSavedPlaybook,
  buildEventFacts,
} from './event-analyzer-evidence.js';

const EVENT_MODEL = 'claude-opus-4-8';
const EVENT_MAX_TOKENS = 16000;
const EVENT_TIMEOUT_MS = 120_000;

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

// The ids/dates the model is allowed to cite for event_description evidence.
// Mirrors exactly what buildEventAnalyzerPrompt shows per note.
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

// Note prose keyed by id and by date so the parser can ground each quote
// against the exact text the model was shown (same stripHtml normalization).
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
 * Ask Claude to score the event lifecycle board for one event.
 *
 * @param {object} event          Events row.
 * @param {Array}  descriptions   Event_Descriptions rows for this event.
 * @param {Array}  contacts       Event_Contacts rows for this event (aggregated; PII never sent).
 * @param {Array}  opportunities  All Opportunities rows (linked-opp facts derived here).
 * @param {Array|string|object|null} savedPlaybookRaw  Saved Event_Playbook state (optional).
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} Parsed + validated event-analysis JSON.
 */
export async function requestEventAnalysisJson(event, descriptions, contacts, opportunities, savedPlaybookRaw, signal) {
  const apiKey = requireApiKey();

  const contactsAgg = buildContactAggregates(contacts);
  const linkedOpps = buildLinkedOppFacts(opportunities, event?.event_id);
  const savedPlaybook = parseSavedPlaybook(savedPlaybookRaw);
  const promptFacts = { contacts: contactsAgg, linkedOpps, savedPlaybook };

  const prompt = buildEventAnalyzerPrompt(event, descriptions, promptFacts);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({
      model: EVENT_MODEL,
      max_tokens: EVENT_MAX_TOKENS,
      // Output-neutral prompt caching: a single text block with the same text
      // tokenizes identically to the bare string, so scoring is unchanged — but
      // re-analyzing the same event within the cache window reads the prompt
      // from Anthropic's cache instead of reprocessing it, cutting
      // time-to-first-token. Below the model's minimum cacheable size the
      // marker silently no-ops.
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] }],
    }),
    signal: makeTimeoutSignal(signal, EVENT_TIMEOUT_MS),
  });

  if (!response.ok) {
    let errBody = {};
    try { errBody = await response.json(); } catch { /* ignore */ }
    const msg = errBody.error?.message || `API error: ${response.status}`;
    console.error('[Event Analyzer] API error', { status: response.status, body: errBody });
    const err = new Error(msg);
    err.status = response.status;
    err.code = 'EVENT_JSON_API_ERROR';
    throw err;
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');

  const sourceTexts = collectSourceTexts(descriptions);
  const facts = buildEventFacts({ event, contacts: contactsAgg, linkedOpps, savedPlaybook });

  return parseEventAnalysisResponse(text, {
    eventId: String(event?.event_id || '').trim(),
    eventTitle: String(event?.title || '').trim(),
    validSourceIds: collectSourceIds(descriptions),
    validSourceDates: collectSourceDates(descriptions),
    sourceTextById: sourceTexts.byId,
    sourceTextByDate: sourceTexts.byDate,
    facts,
  });
}
