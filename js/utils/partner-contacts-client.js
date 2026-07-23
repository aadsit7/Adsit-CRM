// ============================================================
// Partner Contacts API client — calls the Anthropic Messages API
// ============================================================
// Follows partner-analyzer-client.js conventions exactly: same headers,
// same timeout helper, same error-code style, the SAME configured Anthropic
// key and model string used everywhere else in the app.
//
// The heavy lifting — source scoping, the prompt, and the strict verbatim
// validation of every returned contact — lives in the pure module
// (partner-contacts.js). This file only owns the network hop.
// ============================================================

import { getRuntimeConfig } from '../config.js';
import { buildPartnerContactsPrompt, parsePartnerContactsResponse } from './partner-contacts.js';

const CONTACTS_MODEL = 'claude-opus-4-7';
const CONTACTS_MAX_TOKENS = 16000;
const CONTACTS_TIMEOUT_MS = 120_000;

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
 * Ask Claude to propose the contact roster found in the supplied sources,
 * then strictly validate every proposal against those same sources.
 *
 * @param {object} params
 * @param {string} params.partnerName
 * @param {Array}  params.sources  collectPartnerContactSources() items
 *   (plus any attachment-text fallback sources).
 * @param {string} [params.today]  YYYY-MM-DD.
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ contacts, note, dropped }>}
 */
export async function requestPartnerContactsExtraction({ partnerName, sources = [], today, signal } = {}) {
  const apiKey = requireApiKey();
  if (!sources.length) return { contacts: [], note: '', dropped: [] };

  const prompt = buildPartnerContactsPrompt({ partnerName, sources, today });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({
      model: CONTACTS_MODEL,
      max_tokens: CONTACTS_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: makeTimeoutSignal(signal, CONTACTS_TIMEOUT_MS),
  });

  if (!response.ok) {
    let errBody = {};
    try { errBody = await response.json(); } catch { /* ignore */ }
    const msg = errBody.error?.message || `API error: ${response.status}`;
    console.error('[Partner Contacts] API error', { status: response.status, body: errBody });
    const err = new Error(msg);
    err.status = response.status;
    err.code = 'PARTNER_CONTACTS_API_ERROR';
    throw err;
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');

  return parsePartnerContactsResponse(text, { sources });
}
