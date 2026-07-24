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

const CONTACTS_MODEL = 'claude-opus-4-8';
const CONTACTS_MAX_TOKENS = 16000;
const CONTACTS_TIMEOUT_MS = 120_000;
// When a reply is cut off at CONTACTS_MAX_TOKENS (stop_reason "max_tokens"),
// the tail of the roster is lost. Rather than raising max_tokens (16k is
// already the safe ceiling for a non-streaming browser request), the sources
// are split in half and re-extracted as two smaller requests. Depth 2 allows
// up to a 4-way split; past that the parser salvages what it can.
const CONTACTS_MAX_SPLIT_DEPTH = 2;

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
 * A reply that hits the output-token limit is retried as two half-size
 * requests (see CONTACTS_MAX_SPLIT_DEPTH) so a big partner record yields
 * the full roster instead of a truncated one; duplicates across halves are
 * folded by the caller's merge. `partial: true` on the result means some
 * contacts may still be missing (split depth exhausted or JSON salvaged).
 *
 * @param {object} params
 * @param {string} params.partnerName
 * @param {Array}  params.sources  collectPartnerContactSources() items
 *   (plus any attachment-text fallback sources).
 * @param {string} [params.today]  YYYY-MM-DD.
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ contacts, note, dropped, partial }>}
 */
export async function requestPartnerContactsExtraction({ partnerName, sources = [], today, signal } = {}) {
  const apiKey = requireApiKey();
  if (!sources.length) return { contacts: [], note: '', dropped: [], partial: false };
  return extractFromSources({ apiKey, partnerName, sources, today, signal, depth: 0 });
}

async function extractFromSources({ apiKey, partnerName, sources, today, signal, depth }) {
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
  const truncated = data.stop_reason === 'max_tokens';
  const text = (data.content || [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');

  // Cut-off reply and room to split: discard it and re-extract each half in
  // its own request. Sequential on purpose — two half-size prompts, no
  // parallel burst against the org's rate limits.
  if (truncated && sources.length > 1 && depth < CONTACTS_MAX_SPLIT_DEPTH) {
    console.warn(`[Partner Contacts] reply hit the ${CONTACTS_MAX_TOKENS}-token output limit; splitting ${sources.length} sources and retrying`);
    const mid = Math.ceil(sources.length / 2);
    const firstHalf = await extractFromSources({ apiKey, partnerName, sources: sources.slice(0, mid), today, signal, depth: depth + 1 });
    const secondHalf = await extractFromSources({ apiKey, partnerName, sources: sources.slice(mid), today, signal, depth: depth + 1 });
    return {
      contacts: [...firstHalf.contacts, ...secondHalf.contacts],
      note: [firstHalf.note, secondHalf.note].filter(Boolean).join(' · '),
      dropped: [...firstHalf.dropped, ...secondHalf.dropped],
      partial: firstHalf.partial || secondHalf.partial,
    };
  }

  // partnerName arms the validator's affiliation checks: people the model
  // flags as working for another company, and people whose verified company
  // isn't the partner's, are dropped instead of saved. `truncated` lets the
  // parser salvage a cut-off contacts array and flag the result partial.
  try {
    return parsePartnerContactsResponse(text, { sources, partnerName, truncated });
  } catch (err) {
    console.error('[Partner Contacts] parse failed', { stop_reason: data.stop_reason, tail: text.slice(-300) });
    throw err;
  }
}
