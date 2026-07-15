// ============================================================
// Forecast prompt builder
// ============================================================
// Mirrors timeline-pdf-prompts.js: assemble a single prompt from the
// stage definitions + the opportunity's source notes, ending with the
// strict JSON schema example. The GOLDEN RULE block below is the
// anti-hallucination contract — it is included verbatim.
//
// Evidence base: Opportunity_Descriptions notes ONLY. The document list
// (names + analyzed flag) is passed as *weak* context so the model can
// acknowledge attachments it cannot read — it is explicitly forbidden
// from treating an un-analyzed document as evidence.
// ============================================================

import { FORECAST_STAGES, mapLegacyStage, getStageById } from './forecast-stages.js';
import { FORECAST_SCHEMA_EXAMPLE } from './forecast-schema.js';

// Minimal HTML → text. Description notes written via the Quill editor (and
// the analyze-document flow) are stored as HTML; the model should see clean
// prose so its quotes match what a human reads. Kept dependency-free (no
// DOM) so this module stays testable under Node. Exported so the client can
// normalize note text the same way when it grounds the model's evidence
// quotes against the exact prose the model was shown.
export function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeDescriptions(descriptions) {
  return (descriptions || [])
    .map(d => ({
      id:       String(d?.description_id || '').trim(),
      date:     String(d?.description_date || d?.created_at || '').trim(),
      category: String(d?.category || '').trim(),
      text:     stripHtml(d?.description_text || d?.text || ''),
    }))
    .filter(d => d.text.length > 0)
    .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0)); // oldest first
}

// The exit-criteria checklist, rendered so the model knows the exact
// stage ids and criterion ids it must score against.
function buildStageDefinitionsBlock() {
  return FORECAST_STAGES.map((stage, i) => {
    const header = `${i + 1}. ${stage.name}  [stage_id: ${stage.id}]  ·  ${stage.bucket} · ${stage.probability}%`;
    const rows = stage.criteria.map(c => `   - [${c.id}] ${c.label}`).join('\n');
    return `${header}\n${rows}`;
  }).join('\n\n');
}

function buildNotesBlock(entries) {
  if (entries.length === 0) {
    return '(No notes exist for this opportunity. Every criterion must be "no_evidence".)';
  }
  return entries.map(e => {
    const id = e.id || '(no id)';
    const date = e.date || 'Undated';
    const type = e.category || 'uncategorized';
    return `--- NOTE id: ${id} | date: ${date} | type: ${type} ---\n${e.text}`;
  }).join('\n\n');
}

function buildDocumentsBlock(documents) {
  const docs = Array.isArray(documents) ? documents : [];
  if (docs.length === 0) return '(No documents attached.)';
  return docs.map(d => {
    const name = String(d?.file_name || d?.name || 'Untitled').trim();
    const analyzed = String(d?.analyzed || '').toUpperCase() === 'TRUE';
    return analyzed
      ? `- "${name}"  (analyzed: YES — its contents already appear in the notes above)`
      : `- "${name}"  (analyzed: NO — you CANNOT read this file; its contents are unavailable)`;
  }).join('\n');
}

/**
 * Build the forecast prompt.
 *
 * @param {object} opportunity  Opportunities row (opportunity_id, customer_name, deal_name, stage, ...)
 * @param {Array}  descriptions Opportunity_Descriptions rows for this opp
 * @param {Array}  documents    Drive doc metadata ({ file_name, analyzed, ... }) — WEAK context only
 * @returns {string}
 */
export function buildForecastPrompt(opportunity, descriptions, documents) {
  const opp = opportunity || {};
  const opportunityId = String(opp.opportunity_id || opp.id || '').trim();
  const customer = String(opp.customer_name || opp.customerName || opp.name || '').trim() || 'the customer';
  const dealName = String(opp.deal_name || '').trim();

  const entries = normalizeDescriptions(descriptions);

  const legacyStage = String(opp.stage || '').trim();
  const legacyHintId = mapLegacyStage(legacyStage);
  const legacyHintStage = legacyHintId ? getStageById(legacyHintId) : null;
  const legacyHintLine = legacyStage
    ? `CRM stage field (a human's rough guess — NOT evidence): "${legacyStage}"`
      + (legacyHintStage ? ` → nearest forecast stage: ${legacyHintStage.id} (${legacyHintStage.name}).` : '.')
      + ` Use this ONLY to break ties when the notes are genuinely silent; never mark a criterion "met" because of it.`
    : 'CRM stage field: (blank).';

  return `You are scoring a sales-forecast board for the opportunity "${dealName || customer}" (customer: ${customer}). You will be given the stage definitions and the opportunity's source notes. Score each exit criterion using ONLY the notes.

GOLDEN RULE — THE MOST IMPORTANT INSTRUCTION:

Every criterion you mark as "met" or "partial" must be traceable to a specific
sentence in the source notes below, and you must quote or closely paraphrase that
sentence in the "evidence" field along with its date.

You are NOT allowed to:
- Mark a criterion "met" because it is typical for a deal at this stage
- Infer a criterion from the opportunity's stage field, deal value, or close date
- Generalize from common enterprise sales patterns
- Fill in a criterion because the surrounding criteria are met

You ARE expected to:
- Use "no_evidence" liberally. It is the correct answer whenever the notes are silent.
- Return an empty "evidence" string rather than inventing one
- Err toward less confidence, not more

A forecast board with honest gaps is useful. A forecast board with invented
checkmarks is worse than useless — it will cause a rep to skip a step.

---

STAGE DEFINITIONS (score criteria against these — use the exact stage_id and criterion_id strings):

${buildStageDefinitionsBlock()}

---

Opportunity ID: ${opportunityId || '(unknown)'}
Customer: ${customer}
${legacyHintLine}

SOURCE NOTES (the ONLY evidence you may use; each note carries the id you must cite in "source_id" and the date you must cite in "source_date"):

${buildNotesBlock(entries)}

---

ATTACHED DOCUMENTS (metadata only — this is NOT evidence):

${buildDocumentsBlock(documents)}

You may NOT treat an un-analyzed document's mere existence as evidence for any criterion. If a document has not been analyzed, its contents are invisible to you — score as if it did not exist.

---

NOTE WEIGHTING (how to read the notes — still subordinate to the Golden Rule; this never manufactures evidence, it only decides which real evidence wins):
- The notes are listed oldest first. When two notes disagree about the deal's CURRENT state, the more recent note wins; treat the older statement as historical context, not the present truth.
- A note typed "meeting_recap" is first-hand, customer-facing evidence. It outranks a note typed "opportunity_note" (internal/asynchronous) or an uncategorized legacy note when they conflict about the same fact.
- Recency decides the CURRENT stage, not whether a past step happened. A criterion a note shows was satisfied stays "met" unless a later note shows it regressed — do not downgrade a real, dated accomplishment just because it is old.

---

Scoring guidance (subordinate to the Golden Rule):
- For every criterion in every stage, choose one status: "met", "partial", "not_met", or "no_evidence".
- "met" = a note clearly states the criterion is satisfied. "partial" = a note shows it is underway but not finished. "not_met" = a note shows it was attempted and did NOT happen (rare). "no_evidence" = the notes say nothing either way (the common case).
- For "met" or "partial", fill "evidence" with a short quote/paraphrase from ONE note, and set "source_id" and "source_date" to that note's id and date. If a note is shown with id "(no id)" or date "Undated", leave that field empty rather than citing the placeholder — a claim you cannot tie to a real note id or date is "no_evidence". For "not_met" and "no_evidence", leave evidence and source fields as empty strings.
- A stage's "status" is "complete" only if every criterion is "met"; "in_progress" if at least one criterion is met or partial but not all; otherwise "not_started".
- "current_stage_id" is the id of the FURTHEST stage whose criteria are all met. If no stage is fully met, use the earliest stage or leave it as the best-supported stage; set "current_stage_confidence" to "low" when the notes are thin.
- "forecast_bucket" and "probability" will be recomputed from "current_stage_id" — you may leave them approximate.
- "gaps": what is missing to advance to the next stage. "open_questions": questions the notes leave unanswered. Return [] for either if you have nothing supported by the notes.
- Echo the given Opportunity ID back in "opportunity_id".

Return ONLY a single valid JSON object. No prose. No markdown. No code fences. The object must match this exact shape:

${FORECAST_SCHEMA_EXAMPLE}

Return the JSON object and nothing else.`;
}

// Exposed for tests — pure helpers with no network cost.
export const __forecastPromptInternals = { stripHtml, normalizeDescriptions };
