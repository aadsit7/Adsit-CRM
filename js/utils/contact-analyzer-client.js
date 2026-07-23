// ============================================================
// Contact Analyzer API client — Anthropic Messages API + web search
// ============================================================
// Produces the Account Intelligence Brief for one contact. Same conventions
// as the sibling analyzer clients (headers, key, timeout helper, error-code
// style) and the SAME web-search + pause_turn continuation loop the LeadCheck
// client uses — the brief needs live public research to verify the person and
// discover the surrounding buying group.
//
// Two-part design, mirroring partner-analyzer-client.js:
//   • prepareContactBrief() — PURE. Assembles every evidence input (identity
//     snapshot, the contact's own CRM sources, any prior LeadCheck, and the
//     bounded partner/deal context). Exported so the view and tests can build
//     the exact payload without a network call.
//   • requestContactBriefJson() — runs the research call and hands the final
//     text to the strict structural parser.
// ============================================================

import { getRuntimeConfig } from '../config.js';
import { stripHtml } from './forecast-prompts.js';
import {
  buildLeadCheckSnapshot,
  parseAnalysisRecord,
  leadCheckReportToPlainText,
} from './partner-contact-leadcheck.js';
import {
  selectPartnerOpportunities,
  collectOpportunityIds,
  selectOpportunityDescriptions,
  selectPartnerTranscripts,
  selectPartnerMeetings,
} from './partner-analyzer-evidence.js';
import { buildContactBriefPrompt, buildPartnerContextBlock } from './contact-analyzer-prompts.js';
import { parseContactBriefResponse } from './contact-analyzer-schema.js';

const CONTACT_MODEL = 'claude-opus-4-7';
const CONTACT_MAX_TOKENS = 16000;
const CONTACT_REQUEST_TIMEOUT_MS = 240_000; // per round — research turns are long
const CONTACT_MAX_ROUNDS = 6;               // pause_turn continuations
const CONTACT_MAX_SEARCHES = 25;            // web_search max_uses

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

// ── Partner note collection (bounded, newest-first) ─────────────────
// Turn the partner's scoped transcripts, meetings and opportunity notes into
// the { label, date, text } rows buildPartnerContextBlock formats. This is
// deal-level context (who was named where, commercial terms) that the
// contact's own linked sources may not carry.
function firstNonEmpty(...vals) {
  for (const v of vals) { const s = String(v || '').trim(); if (s) return s; }
  return '';
}

function collectPartnerNotes({ transcripts = [], meetings = [], opportunityDescriptions = [] } = {}) {
  const notes = [];

  for (const t of transcripts) {
    const text = stripHtml(t.transcript_text || '');
    if (!text.trim()) continue;
    notes.push({ label: 'Partner note', date: firstNonEmpty(t.conversation_date, t.created_at).slice(0, 10), text });
  }
  for (const m of meetings) {
    const text = [
      m.meeting_title ? `Title: ${stripHtml(m.meeting_title)}` : '',
      m.attendees ? `Attendees: ${stripHtml(m.attendees)}` : '',
      m.summary ? `Summary: ${stripHtml(m.summary)}` : '',
      m.key_decisions ? `Decisions: ${stripHtml(m.key_decisions)}` : '',
      m.topics_discussed ? `Topics: ${stripHtml(m.topics_discussed)}` : '',
    ].filter(Boolean).join('\n');
    if (!text.trim()) continue;
    notes.push({ label: String(m.meeting_title || 'Meeting').trim() || 'Meeting', date: String(m.meeting_date || '').slice(0, 10), text });
  }
  for (const d of opportunityDescriptions) {
    const text = stripHtml(d.description_text || d.text || '');
    if (!text.trim()) continue;
    notes.push({ label: `Deal note${d.deal_name ? ` — ${String(d.deal_name).trim()}` : ''}`, date: String(d.description_date || d.created_at || '').slice(0, 10), text });
  }

  // Newest first so the bounded context keeps the most relevant material.
  notes.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return notes;
}

/**
 * Assemble every evidence input for one contact's brief. PURE — no network.
 *
 * @param {object} params
 * @param {object} params.contact                The selected Partner_Contacts row (partnerContactFromRow shape).
 * @param {object} [params.partner]              The partner row (for tier/status/name context).
 * @param {Array}  [params.transcripts]          Raw Transcripts rows (scoped here by partner_id).
 * @param {Array}  [params.meetings]             Raw Meeting_Index rows.
 * @param {Array}  [params.documents]            Raw Partner_Documents rows.
 * @param {Array}  [params.opportunities]        Raw Opportunities rows.
 * @param {Array}  [params.opportunityDescriptions] Raw Opportunity_Descriptions rows.
 * @returns {{ snapshot, sourceMaterial, leadCheckSummary, partnerContext, hasLeadCheck }}
 */
export function prepareContactBrief({
  contact = {},
  partner = null,
  transcripts = [],
  meetings = [],
  documents = [],
  opportunities = [],
  opportunityDescriptions = [],
} = {}) {
  const partnerId = String(contact.partner_id || (partner && partner.partner_id) || '').trim();

  // The contact's own identity snapshot + linked CRM source text (reused,
  // tested LeadCheck assembler — phone-free by construction).
  const { snapshot, sourceMaterial } = buildLeadCheckSnapshot({ contact, transcripts, meetings, documents });

  // Prior LeadCheck verification, if any, rendered to plain text as evidence.
  let leadCheckSummary = '';
  const record = parseAnalysisRecord(contact.analysis_json);
  if (record && record.report) {
    try { leadCheckSummary = leadCheckReportToPlainText(record.report, contact); } catch { leadCheckSummary = ''; }
  }

  // Partner/deal context — strictly scoped to this contact's partner.
  const pOpps = selectPartnerOpportunities(opportunities, partnerId);
  const oppIds = collectOpportunityIds(pOpps);
  const pOppDesc = selectOpportunityDescriptions(opportunityDescriptions, oppIds);
  const pTranscripts = selectPartnerTranscripts(transcripts, partnerId);
  const pMeetings = selectPartnerMeetings(meetings, partnerId);
  const notes = collectPartnerNotes({ transcripts: pTranscripts, meetings: pMeetings, opportunityDescriptions: pOppDesc });
  const partnerContext = buildPartnerContextBlock({
    partner: partner || { partner_name: contact.partner_name },
    opportunities: pOpps,
    notes,
  });

  return { snapshot, sourceMaterial, leadCheckSummary, partnerContext, hasLeadCheck: !!leadCheckSummary };
}

/**
 * Research and synthesize the Account Intelligence Brief for one contact.
 *
 * @param {object} params  See prepareContactBrief(), plus:
 * @param {string} [params.presetInstructions]  The "Lead Search" preset instructions.
 * @param {string} [params.nowIso]
 * @param {string} [params.timezone]
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.onProgress]  (roundNumber) => void
 * @returns {Promise<object>} the validated brief
 */
export async function requestContactBriefJson(params = {}) {
  const {
    contact = {}, presetInstructions = '', nowIso = '', timezone = 'UTC', signal, onProgress,
  } = params;
  const apiKey = requireApiKey();

  const prep = prepareContactBrief(params);
  const prompt = buildContactBriefPrompt({
    presetInstructions,
    snapshot: prep.snapshot,
    sourceMaterial: prep.sourceMaterial,
    leadCheckSummary: prep.leadCheckSummary,
    partnerContext: prep.partnerContext,
    today: String(nowIso || '').slice(0, 10),
    timezone,
  });

  const messages = [{ role: 'user', content: prompt }];

  for (let round = 1; round <= CONTACT_MAX_ROUNDS; round += 1) {
    if (typeof onProgress === 'function') onProgress(round);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model: CONTACT_MODEL,
        max_tokens: CONTACT_MAX_TOKENS,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: CONTACT_MAX_SEARCHES }],
        messages,
      }),
      signal: makeTimeoutSignal(signal, CONTACT_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      let errBody = {};
      try { errBody = await response.json(); } catch { /* ignore */ }
      const msg = errBody.error?.message || `API error: ${response.status}`;
      console.error('[Contact Analyzer] API error', { status: response.status, body: errBody });
      const err = new Error(msg);
      err.status = response.status;
      err.code = 'CONTACT_BRIEF_API_ERROR';
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

    // Final (or cut-off) answer: the strict JSON is in the LAST text block.
    let text = '';
    for (const block of data.content || []) {
      if (block?.type === 'text' && typeof block.text === 'string') text = block.text;
    }
    const truncated = data.stop_reason === 'max_tokens';
    // On max_tokens the JSON tail is cut off; the parser repairs a truncated
    // object rather than discarding a mostly-complete brief.
    return parseContactBriefResponse(text, { contact, truncated });
  }

  throw new Error('The research did not finish within the allowed number of rounds — try again.');
}
