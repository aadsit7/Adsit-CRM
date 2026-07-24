// ============================================================
// Partner analyzer API client — calls the Anthropic Messages API
// ============================================================
// Follows event-analyzer-client.js / forecast-client.js conventions exactly:
// same headers, same timeout helper, same error-code style, the SAME
// configured Anthropic key and model string used everywhere else in the app.
//
// This is the single orchestration point for a partner analysis. It:
//   1. strictly scopes every source to the selected partner,
//   2. computes deterministic KPIs + relationship health in APP CODE,
//   3. assembles bounded, privacy-safe evidence + a coverage report,
//   4. builds the deterministic/structured criteria facts,
//   5. builds the prompt, calls Claude, and hands the raw text to the STRICT
//      parser together with the anchors + facts so the parser can reject
//      unsupported claims and overlay the hard CRM facts itself.
//
// The KPIs and health returned here are the SAME ones fed into the prompt, so
// the board the view renders can never disagree with what the model was shown.
// ============================================================

import { getRuntimeConfig } from '../config.js';
import { buildPartnerAnalyzerPrompt } from './partner-analyzer-prompts.js';
import { parsePartnerAnalysisResponse } from './partner-analyzer-schema.js';
import { parseSavedPlaybook, buildContactAggregates } from './event-analyzer-evidence.js';
import { derivePartnerHealth } from './partner-analyzer-health.js';
import {
  selectPartnerTranscripts, selectPartnerMeetings, selectPartnerDocuments,
  selectPartnerOpportunities, collectOpportunityIds, selectOpportunityDescriptions,
  selectPartnerEvents, collectEventIds, selectEventDescriptionsForPartner, selectEventContactsForPartner,
  buildPartnerKpis, assemblePartnerEvidence, withCoverageFailures,
  buildPartnerCriteriaFacts, collectPartnerAnchors, computeHealthSignals,
} from './partner-analyzer-evidence.js';

const PARTNER_MODEL = 'claude-opus-4-8';
const PARTNER_MAX_TOKENS = 16000;
const PARTNER_TIMEOUT_MS = 120_000;

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

// Merge the saved event-playbook state for ONLY this partner's strictly
// assigned events. Rows for other partners' events are ignored entirely.
function aggregatePartnerSavedPlaybook(rows, eventIds) {
  const merged = { found: false, checked: {}, notes: {} };
  for (const row of rows || []) {
    const eid = String(row && row.event_id || '').trim();
    if (!eid || !eventIds.has(eid)) continue;
    const parsed = parseSavedPlaybook(row.stages_json || '');
    if (parsed.found) merged.found = true;
    Object.assign(merged.checked, parsed.checked);
  }
  return merged;
}

/**
 * Scope, aggregate, and deterministically evaluate everything for one partner.
 * Pure (no network) — exported so the view can render the KPI strip / health
 * even before wiring the AI call, and so tests can assert scoping.
 *
 * @returns {{ scoped, kpis, health, contactsAgg, savedPlaybook, evidence,
 *   coverage, facts, anchors }}
 */
export function preparePartnerAnalysis({
  partner,
  transcripts = [], meetings = [], documents = [],
  opportunities = [], opportunityDescriptions = [],
  events = [], eventDescriptions = [], eventContacts = [],
  savedPlaybookRows = [], readFailures = [], today,
} = {}) {
  const id = String(partner && partner.partner_id || '').trim();

  const pTranscripts = selectPartnerTranscripts(transcripts, id);
  const pMeetings = selectPartnerMeetings(meetings, id);
  const pDocuments = selectPartnerDocuments(documents, id);
  const pOpps = selectPartnerOpportunities(opportunities, id);
  const oppIds = collectOpportunityIds(pOpps);
  const pOppDesc = selectOpportunityDescriptions(opportunityDescriptions, oppIds);
  const pEvents = selectPartnerEvents(events, id);
  const eventIds = collectEventIds(pEvents);
  const pEventDesc = selectEventDescriptionsForPartner(eventDescriptions, eventIds);
  const pEventContacts = selectEventContactsForPartner(eventContacts, eventIds);
  const savedPlaybook = aggregatePartnerSavedPlaybook(savedPlaybookRows, eventIds);

  const kpis = buildPartnerKpis({
    partner, transcripts: pTranscripts, meetings: pMeetings, documents: pDocuments,
    events: pEvents, opportunities: pOpps, opportunityDescriptions: pOppDesc, eventDescriptions: pEventDesc, today,
  });
  const contactsAgg = buildContactAggregates(pEventContacts);

  const evidence = assemblePartnerEvidence({
    transcripts: pTranscripts, meetings: pMeetings, documents: pDocuments,
    opportunityDescriptions: pOppDesc, eventDescriptions: pEventDesc,
  });
  const coverage = withCoverageFailures(evidence.coverage, readFailures);
  evidence.coverage = coverage;

  const facts = buildPartnerCriteriaFacts({ partner, kpis, contactsAgg, savedPlaybook });
  const anchors = collectPartnerAnchors(evidence, { opportunityIds: oppIds, eventIds, partnerId: id });

  const healthSignals = computeHealthSignals({
    partner, kpis, transcripts: pTranscripts, opportunityDescriptions: pOppDesc,
    eventDescriptions: pEventDesc, opportunities: pOpps, events: pEvents, today,
  });
  const health = derivePartnerHealth(healthSignals, { today });

  return {
    scoped: {
      transcripts: pTranscripts, meetings: pMeetings, documents: pDocuments,
      opportunities: pOpps, opportunityDescriptions: pOppDesc,
      events: pEvents, eventDescriptions: pEventDesc, eventContacts: pEventContacts,
      oppIds, eventIds,
    },
    kpis, health, contactsAgg, savedPlaybook, evidence, coverage, facts, anchors,
  };
}

/**
 * Ask Claude to score the Partner Maturity board for one partner.
 *
 * @param {object} params  See preparePartnerAnalysis(), plus:
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ analysis, kpis, health, coverage }>}
 */
export async function requestPartnerAnalysisJson(params = {}) {
  const apiKey = requireApiKey();
  const { partner, today, signal } = params;

  const prep = preparePartnerAnalysis(params);
  const { kpis, health, contactsAgg, savedPlaybook, evidence, coverage, facts, anchors } = prep;

  const prompt = buildPartnerAnalyzerPrompt({ partner, kpis, evidence, contactsAgg, savedPlaybook, today });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({
      model: PARTNER_MODEL,
      max_tokens: PARTNER_MAX_TOKENS,
      // Output-neutral prompt caching: a single text block with the same text
      // tokenizes identically to the bare string, so scoring is unchanged — but
      // re-analyzing the same partner within the cache window reads the prompt
      // from Anthropic's cache instead of reprocessing it, cutting
      // time-to-first-token. Below the model's minimum cacheable size the
      // marker silently no-ops.
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] }],
    }),
    signal: makeTimeoutSignal(signal, PARTNER_TIMEOUT_MS),
  });

  if (!response.ok) {
    let errBody = {};
    try { errBody = await response.json(); } catch { /* ignore */ }
    const msg = errBody.error?.message || `API error: ${response.status}`;
    console.error('[Partner Analyzer] API error', { status: response.status, body: errBody });
    const err = new Error(msg);
    err.status = response.status;
    err.code = 'PARTNER_JSON_API_ERROR';
    throw err;
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');

  const analysis = parsePartnerAnalysisResponse(text, {
    partnerId: String(partner?.partner_id || '').trim(),
    partnerName: String(partner?.display_name || '').trim(),
    anchors,
    facts,
  });

  return { analysis, kpis, health, coverage };
}
