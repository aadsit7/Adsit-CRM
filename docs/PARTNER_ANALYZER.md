# Partner Analyzer (Partner Maturity mode)

The Analyzer tab (`/admin/forecast`) now supports **three** entity modes:

| Mode | Board | Source of truth |
| --- | --- | --- |
| Opportunity | Sales forecast stages | `js/utils/forecast-stages.js` |
| Event | Event lifecycle | `js/utils/event-analyzer-stages.js` |
| **Partner** | **Partner Maturity** | **`js/utils/partner-analyzer-stages.js`** |

Partner mode lets an administrator pick a partner and generate an
evidence‑grounded assessment of that partner's **maturity**, **relationship
health**, enablement, joint activity, pipeline and revenue progress — using the
same methodology as the other two analyzers: collect CRM evidence, separate
deterministic facts from AI interpretation, score every criterion, require
traceable evidence, strictly parse/validate the model output, and derive stage
status from the validated criteria.

> **This framework is new.** It does **not** exist as a persisted playbook in
> the CRM. There is no Google Sheet and no Apps Script that stores these
> definitions — they live in a pure, tested JavaScript module, exactly like the
> Opportunity and Event stage modules. **No Google Sheet or Apps Script change
> is required for this feature.**

---

## Partner Maturity framework — 7 stages × 3 criteria (21 total)

Every stage and criterion has a stable, globally‑unique machine id. **Do not
rename the ids** — the model contract, the parser, the view, the PDF and the
tests are all keyed on them.

| # | Stage (`stage_id`) | Criteria (`criterion_id`) |
| --- | --- | --- |
| 1 | Profile & Fit (`profile_fit`) | `partner_profile_complete`, `strategic_fit_defined`, `key_stakeholders_identified` |
| 2 | Relationship & Alignment (`relationship_alignment`) | `relationship_established`, `goals_priorities_aligned`, `cadence_next_steps` |
| 3 | Enablement & Readiness (`enablement_readiness`) | `solution_enablement`, `technical_readiness`, `sales_readiness` |
| 4 | Joint Go‑to‑Market Planning (`joint_gtm`) | `target_market_defined`, `joint_value_proposition`, `gtm_plan_owned` |
| 5 | Market Engagement (`market_engagement`) | `joint_activity_launched`, `audience_engaged`, `follow_up_executed` |
| 6 | Pipeline Execution (`pipeline_execution`) | `opportunities_created`, `active_pipeline`, `deal_progression` |
| 7 | Revenue & Growth (`revenue_growth`) | `revenue_won`, `repeatable_motion`, `growth_plan` |

### Stage derivation rules

- A criterion counts as **complete** only when its validated status is `met`.
- `partial` shows progress but never counts as complete.
- A stage is `complete` only when **all three** criteria are `met`;
  `in_progress` when ≥1 is `met`/`partial` but not all `met`; otherwise
  `not_started`.
- **Operational maturity stage** = the first ordered stage that is not complete
  (the headline). If every stage is complete → **Revenue & Growth — Mature**.
- **Furthest demonstrated stage** = the furthest stage with ≥1 validated `met`
  criterion — computed independently, so a partner can demonstrate later‑stage
  behavior despite earlier gaps. Later evidence never conceals an unfinished
  earlier stage.
- **Completion %** = validated met criteria ÷ 21 × 100.
- The model is never allowed to self‑award its stage — it is recomputed from the
  validated criteria.

### Tier / status are NOT maturity

The Partners sheet's `tier` (Registered · Value/Preferred · Premier/Strategic)
and `status` (engaged · active · inactive) are **CRM classifications**, not the
maturity stage. Nothing derives a maturity criterion from tier, status, account
age, or the mere existence of later‑stage activity. The summary surfaces a
deterministic discrepancy note when a high tier is not yet backed by evidence,
e.g. *"CRM tier is Premier/Strategic, but the available evidence only supports
Profile & Fit maturity so far."* The Analyzer never modifies `tier` or `status`.

---

## Relationship health (separate from maturity)

Health is derived **deterministically** (never by the model) in
`js/utils/partner-analyzer-health.js`, with named, tunable thresholds:

- **Healthy** — meaningful activity within `HEALTH_HEALTHY_MAX_DAYS` (45) **and**
  a concrete active signal (active opportunity, upcoming partner event, recent
  meeting/next step).
- **Watch** — no meaningful activity for 46–90 days, or relationship evidence
  with no concrete next step / active motion.
- **At Risk** — no meaningful activity for >90 days, or a **recent** source that
  explicitly documents disengagement / blocked progress / cancellation.
- **Insufficient history** — a new partner (created within
  `NEW_PARTNER_GRACE_DAYS`, 90) with little/no activity is treated fairly, not
  automatically At Risk.

An inactive CRM `status` is shown separately; it never silently becomes a health
label. Boundary dates (exactly 45 / 90) are tested exactly.

---

## Deterministic vs AI‑derived

| Computed in application code (deterministic) | Interpreted by the model (then validated) |
| --- | --- |
| Transcript / meeting / document / event counts | Which criteria are met / partial / not_met |
| Total / active / won opportunity counts | Evidence quotes & narrative reasoning |
| **Active pipeline value**, **won revenue** | Summary, next actions, gaps, questions, risks, momentum |
| Stage distribution, nearest expected close | Confidence label |
| Most recent meaningful activity date | — |
| Relationship health label | *(never — the model must not invent it)* |
| Operational + furthest stage, completion % | *(never — recomputed from validated criteria)* |

The model is **never** trusted for CRM metrics, the health label, tier, status,
pipeline, revenue, event count or opportunity count.

---

## Evidence sources (all strictly partner‑scoped)

1. **Partners** — profile context; `tier`/`status` are context only. Auth fields
   (`password_hash`, `username`, `is_admin`) are never sent.
2. **Transcripts** — `transcript.partner_id === partner_id`; primary narrative
   evidence (HTML stripped).
3. **Meeting_Index** — `partner_id`; structured meeting metadata. A row whose
   `transcript_id` matches a transcript is treated as the same interaction (not
   double‑counted).
4. **Partner_Documents** — `partner_id`; `html_content` stripped to prose.
5. **Opportunities** — `opportunity.partner_id === partner_id`; deterministic
   won/active/pipeline/revenue facts (real status semantics: `Won` / `Lost` /
   everything‑else‑active).
6. **Opportunity_Descriptions** — restricted to the partner's opportunity ids;
   each note keeps its `opportunity_id` so a link opens the right deal.
7. **Events** — **strict** `event.partner_id === partner_id`. Unassigned events
   (`!event.partner_id`) are **never** counted as this partner's activity.
8. **Event_Descriptions / Event_Contacts** — restricted to the partner's event
   ids; contacts are aggregated to **counts only** (no names/emails/PII).
9. **Event_Playbook** (optional) — reuses the tested loader; only rows for the
   partner's strictly‑assigned events; labelled `saved_event_playbook`.

### Privacy & size control

- Never sent: password hashes, auth fields, event passwords, contact
  names/emails, API keys, or any other partner's data.
- Bounded evidence assembly (`assemblePartnerEvidence`): newest‑first selection,
  explicit per‑source and overall caps, mid‑source truncation is **labelled**
  `[truncated]`, and a **coverage object** reports sources found / included /
  omitted / read‑failures. The UI shows a non‑fatal coverage banner when
  material evidence was omitted or could not be loaded. Deterministic aggregates
  always cover the complete history.

---

## Strict JSON contract

The parser (`js/utils/partner-analyzer-schema.js`) enforces correctness — the
model only proposes. It drops unknown/duplicate/wrong‑stage ids, validates every
cited source id/date against the evidence package, **grounds** narrative quotes
against the cited source text, requires structured claims to be backed by a
supplied fact, **overlays deterministic CRM facts** (a real won opportunity
overrides a "no wins" note), downgrades unsupported `met`/`partial` to
`no_evidence`, and recomputes stage statuses, the operational + furthest stages
and the completion percentage.

The Partner prompt (`partner-analyzer-prompts.js`) carries the exact
stage/criterion definitions, profile context, deterministic KPI facts, the
selected evidence, coverage info, today's date, the exact JSON shape, and the
anti‑hallucination Golden Rule:

> *Every met or partial criterion must be supported by a supplied source. Use
> no_evidence whenever the available CRM records are silent. Partner tier,
> status, longevity, reputation, or typical channel behavior are not evidence.*

---

## Modules & tests

| Module | Responsibility |
| --- | --- |
| `js/utils/partner-analyzer-stages.js` | Framework definitions + board derivation |
| `js/utils/partner-analyzer-health.js` | Deterministic relationship health |
| `js/utils/partner-analyzer-evidence.js` | Strict scoping, KPIs, criteria facts, bounded evidence, coverage, anchors, health signals |
| `js/utils/partner-analyzer-schema.js` | Strict parser / validator |
| `js/utils/partner-analyzer-prompts.js` | Prompt builder |
| `js/utils/partner-analyzer-client.js` | Anthropic client + orchestration (`preparePartnerAnalysis`, `requestPartnerAnalysisJson`) |
| `js/utils/partner-analyzer-pdf-builder.js` | Recast‑branded PDF (`Partner_Analysis_{slug}_{YYYY-MM-DD}.pdf`) |
| `js/utils/analyzer-job-key.js` | `{ entityType, entityId, runId }` background‑job key |
| `js/views/admin-forecast.js` | Analyzer view — adds Partner mode (isolated state/job) |

Tests: `tests/partner-analyzer-{stages,health,evidence,schema,prompts,integration,pdf-builder}.test.mjs`.
Run with `npm test`.

### Background‑job & mode isolation

Each mode owns its own selection and background job; a partner run survives
navigation and a new run supersedes the stale one. Before any async response is
applied, the handler verifies its typed job key (`entityType` + `entityId` +
`runId`) still matches the active job — so a stale result for Partner A can never
render under Partner B, and one mode's result can never overwrite another's.
Opportunity and Event behavior is unchanged.
