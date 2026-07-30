// ============================================================
// Partner Next Steps API client — Anthropic Messages API, extended thinking
// ============================================================
// Same conventions as the sibling analyzer clients (headers, configured key,
// timeout helper, error-code style). Two things are specific to this one:
//
//   • adaptive thinking at high effort — the same request shape the AI
//     Assistant's "complex" tier uses (see TIER_CONFIG in js/utils/ai.js).
//     Deciding what is still OPEN across several dated notes — where a newer
//     note may close out what an older one promised — is genuine
//     multi-document reasoning, so the model reasons privately before it
//     commits to the strict JSON;
//   • no tools. The selected notes are the only material, so there is
//     nothing to search — a step that is not in the notes has nowhere to
//     come from.
//
// The strict JSON answer is in the last text block (thinking blocks are
// filtered out). Validation — including the verbatim evidence gate — lives
// in partner-next-steps-schema.js.
// ============================================================

import { getRuntimeConfig } from '../config.js';
import { buildPartnerNextStepsPrompt } from './partner-next-steps-prompts.js';
import { parsePartnerNextStepsResponse } from './partner-next-steps-schema.js';

// The current Opus — the same model string the Partner Bio analyzer uses.
const NEXT_STEPS_MODEL = 'claude-opus-5';
// max_tokens is the shared ceiling for thinking + the visible answer.
const NEXT_STEPS_MAX_TOKENS = 16000;
// Thinking turns run longer than plain extraction turns.
const NEXT_STEPS_TIMEOUT_MS = 240_000;

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
 * Ask Claude to reason over the selected description notes and propose the
 * next-steps agenda, then strictly validate every proposal against those
 * same notes (verbatim evidence gate — see partner-next-steps-schema.js).
 *
 * @param {object} params
 * @param {string} params.partnerName
 * @param {Array}  params.sources  [{ source_id, date, label, text }] — the
 *   notes the user selected, HTML already stripped.
 * @param {string} [params.today]  YYYY-MM-DD.
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ steps, note, dropped, partial }>}
 */
export async function requestPartnerNextSteps({ partnerName, sources = [], today, signal } = {}) {
  const apiKey = requireApiKey();
  if (!sources.length) return { steps: [], note: '', dropped: [], partial: false };

  const prompt = buildPartnerNextStepsPrompt({ partnerName, sources, today });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({
      model: NEXT_STEPS_MODEL,
      max_tokens: NEXT_STEPS_MAX_TOKENS,
      // Adaptive thinking + high effort — the valid "reason hard" shape on
      // this model family, mirrored from ai.js's complex tier.
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: makeTimeoutSignal(signal, NEXT_STEPS_TIMEOUT_MS),
  });

  if (!response.ok) {
    let errBody = {};
    try { errBody = await response.json(); } catch { /* ignore */ }
    const msg = errBody.error?.message || `API error: ${response.status}`;
    console.error('[Partner Next Steps] API error', { status: response.status, body: errBody });
    const err = new Error(msg);
    err.status = response.status;
    err.code = 'PARTNER_NEXT_STEPS_API_ERROR';
    throw err;
  }

  const data = await response.json();

  if (data.stop_reason === 'refusal') {
    throw new Error('The model declined to analyze these notes.');
  }

  // The strict JSON is in the LAST text block; thinking blocks (and any
  // pre-answer narration) are not part of the answer.
  let text = '';
  for (const block of data.content || []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) text = block.text;
  }

  const truncated = data.stop_reason === 'max_tokens';
  try {
    return parsePartnerNextStepsResponse(text, { sources, truncated });
  } catch (err) {
    console.error('[Partner Next Steps] parse failed', { stop_reason: data.stop_reason, tail: String(text).slice(-300) });
    throw err;
  }
}
