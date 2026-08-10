# LeadCheck — row-level individual contact analysis

Every row in the Partner Contacts table has an **Analyze** action (Actions
column: **Analyze · Edit · Delete**). Clicking it verifies that ONE
individual from public professional web sources (Anthropic's server-side
`web_search` tool) plus the contact's own CRM source material, and stores a
structured verification report on the record.

The workflow follows the LeadCheck row-level analysis specification:
individual-focused (never a company profile), source-first, phone-free,
evidence-URL-gated, conflict-preserving, and confidence-scored — with the
enforcement done **in application code**, not by trusting the model.

## Selection & duplicate-run control

- The button passes the row's **`contact_id`** — the selected record is
  never determined by row position, displayed name, or table order, and
  results are written back **only** to the row found by that id on a fresh
  read. If the contact was deleted mid-run, the result is discarded.
- One analysis per contact at a time (`contact_id`-keyed in-flight map);
  other rows stay analyzable in parallel. Re-render-safe.

## Row states → button behavior

| Persisted state | Button | On click |
| --- | --- | --- |
| *(none)* / `FAILED` | **Analyze** | runs the workflow |
| in flight | **Analyzing…** (disabled) | — |
| `COMPLETE` / `COMPLETE_WITH_GAPS` | **View Analysis** | opens the report (tooltip shows last-verified date; stale/changed analyses get a banner + Re-analyze) |
| `NEEDS_REVIEW` / `CONFLICT_FOUND` | **Review** | opens the report with the conflict flags |
| `NEEDS_MORE_INFORMATION` | **Add Info** | shows the exact missing fields + opens Edit Contact; returns to **Analyze** automatically once the row gains enough identity data |

Re-analysis triggers: the **Re-analyze** button, a changed identity
fingerprint (name/role/company/email), or an analysis older than the
freshness period (`LEADCHECK_FRESH_DAYS` = 30 — surfaced, never auto-run).

**Non-blocking progress.** A run is fire-and-forget: it drives a floating
Randy pill in the global body-fixed stack (`createPill`, bottom-right,
persists across route changes), so the user can switch tabs or open another
partner while the analysis continues. The row button still mirrors the
`Analyzing…` state locally (restored on re-render from the `leadCheckRuns`
map), and the result is written back by `contact_id` regardless of where the
user navigated. Each row analyzes independently, so several pills can run at
once — one labelled row per contact, each with its own progress bar and clock.
The pill settles green on `COMPLETE` / `COMPLETE_WITH_GAPS`, amber on
`NEEDS_REVIEW` / `CONFLICT_FOUND` / `NEEDS_MORE_INFORMATION`, and on failure.

**Progress is measured in work actually done.** The research runs as a
**streamed** Messages call (`js/utils/anthropic-research-stream.js`), so every
step it takes arrives as an event while it happens: each web search it issues
(with the query), each result set that comes back (with the source count), and
each chunk of the verdict it writes. `js/utils/research-progress.js` maps those
onto the stage line and the bar; the row button carries a compact
`Analyzing… 42%` so a long stage line never widens the table.

Before that, the pill names the local phases too — `Checking the contact
record…`, `Collecting CRM sources…` — so it is informative from the first
second rather than a bar that has not moved since the click.

The bar can never claim more than happened. Searching fills it along a decaying
curve toward a ceiling it never reaches (every real search is a visible step,
and no number of them finishes the bar); only the answer being written takes it
to the top, and only the saved result settles it. That is deliberate: the
number of searches an analysis needs is decided while it runs, so any fixed
denominator would be a guess in one direction or the other.

*Why this replaced round-counting.* Rounds were the only fact a non-streaming
loop had — one request, up to four minutes, nothing until it landed — and a bar
drawn in sixths was wrong in both directions. A healthy run finishes in one or
two rounds, so it spent the whole analysis inside its first sixth and then
jumped to done: it looked stuck because there was genuinely nothing to report.
And because nothing was heard for minutes at a time, the pill's own
"taking longer than expected" warning fired *on a healthy run*.

**Budgets measure silence, not duration.** With a streaming run, saying nothing
is diagnostic: a round that has gone quiet for `LEADCHECK_IDLE_TIMEOUT_MS`
(2 min) is abandoned and retried, and the pill's give-up budget
(`LEADCHECK_STALL_MS`, 5 min) only has to clear one such cycle. It used to be
24 minutes — 6 rounds × the 4-minute request budget — because a black-box round
could not be distinguished from a wedged one. A pill that does give up is still
revived and corrected by whatever the run finally reports.

**A transient failure costs a round, not the run.** Each round gets up to three
attempts with backoff. A rate limit, an overloaded window, a dropped
connection, or a stream that ends without a `stop_reason` is retried, and the
retry is *announced* on the pill (`Rate limited — retrying in 6s…`) rather than
looking like a hang. Genuine faults — a bad request, a rejected key — surface
immediately instead of burning retries. When a run does fail, the pill names
the kind of failure (`Claude was busy — try again`), because the toast carrying
the full message is gone in seconds and the pill is what the user is still
looking at.

## Deterministic pre-analysis validation

Research never starts unless the row can identify a professional
individual: full name + company · full name + title · full name +
company-domain email · a corporate email alone · full name + linked CRM
source text. Otherwise the run pauses with
*"Analysis paused: the selected contact does not contain enough
professional identity information to distinguish the individual
reliably."* and lists the missing fields. Free-mail domains (gmail,
outlook, …) never count as identifying.

## Source-first & privacy

- The snapshot resolves the row's provenance (`sources_json`) into actual
  CRM text — description notes, meeting records, partner documents — and
  supplies it to the model **before** web research; attachments contribute
  their filename only (their content was already extracted at scan time and
  does not count toward the sufficiency gate).
- **The phone number is never included in the research payload** — the spec
  forbids phone-based discovery, and omitting the field entirely is the
  strongest enforcement.
- CRM material and web content are declared UNTRUSTED DATA in the prompt:
  evidence only, never instructions.

## What the validator enforces (js/utils/partner-contact-leadcheck.js)

- **Evidence URLs are mandatory for every named claim.** A named manager
  without a public evidence URL is removed and the label downgraded to
  UNKNOWN; `GENERIC_INFERENCE` can never carry a person's name; peers,
  direct reports (max 5), upward-mapping levels (max 3), content items,
  timing signals, colleagues, and identity sources without valid `http(s)`
  URLs are dropped. No verifiable direct reports → the exact sentence
  *"No publicly verifiable direct reports found."*
- **Identity gating.** `CONFIRMED` requires at least one source URL; with
  no public URLs at all the identity is `NOT_VERIFIED`. When identity ends
  `AMBIGUOUS`/`NOT_VERIFIED`, ALL organizational conclusions (reporting,
  peers, direct reports, buying role) are stripped and the state forced to
  `NEEDS_REVIEW`.
- **Email rules.** Only the supplied row address (or a public-exact
  finding) is ever evaluated; an address the model invents is discarded and
  the status reset to `NOT_EVALUATED`. Pattern matches are never labeled
  verified; the mailbox-existence limitation is always present.
- **Buying role.** `DECISION_MAKER` without evidence URLs downgrades to
  `INFLUENCER` with an explicit limitation note.
- **Coverage & confidence are recomputed** — the 22-item checklist is
  canonicalized (missing items = `NOT_FOUND`, unknown keys dropped,
  `email_evaluated` becomes `NOT_APPLICABLE` when no email was supplied),
  coverage uses the spec formula `(PASS + 0.5×PARTIAL) ÷ applicable × 100`,
  the 0–10 score is clamped, and the HIGH/MEDIUM/LOW label derives from the
  bands with `FLAGGED` forced by any unresolved conflict.
- **Conflicts are preserved** (`CONFLICT_FOUND` state, flagged notes,
  loop-check result strings) — never silently resolved.
- **The compliance note is forced verbatim.**

## Write-back (existing values are never overwritten)

Results live in three columns appended to `Partner_Contacts`
(`analysis_state`, `analysis_last_verified`, `analysis_json` — the full
validated report + identity fingerprint, shrunk in stages to fit the 50k
cell cap). The user-entered row fields are never overwritten; the report's
**On file vs Verified** table shows both side by side (e.g. Original Role
"Director of IT" vs Verified "Senior Director, Enterprise Technology").
`ensureSheetWithHeaders` extends existing sheets' header rows in place when
they match the old 14-column prefix.

### Verified-role backfill (the one narrow row write)

When the analysis identified the person's role and the row's own **Role**
field is EMPTY, the verified title is written into the Role column of the
partner table. All gates must hold (`verifiedRoleFromAnalysis` /
`applyAnalysisRoleToContact`):

- final state `COMPLETE` or `COMPLETE_WITH_GAPS` — never `NEEDS_REVIEW`,
  `CONFLICT_FOUND`, `FAILED`, or a paused run;
- identity match `CONFIRMED` — a `PROBABLE` match could be a different
  person with the same name;
- `title_status` `CONFIRMED` or `CORROBORATED` — multiple credible
  sources agree (`SINGLE_SOURCE`, `UNKNOWN`, `CONFLICTING` never write);
- the record's identity fingerprint still matches the row on name,
  company, and email — an analysis of a since-edited contact never fills
  it;
- the Role field is blank — a role already on file is **never** replaced
  (checked on the fresh row at save time, so a role typed while the
  analysis ran survives).

The fill happens in the same write that stores the analysis; rows whose
analysis ran before this write-back existed are backfilled once on the
next Partner Detail load (same background-persist pattern as the company
default). The stored fingerprint is updated with the written role so the
fill never raises a false "fields changed — re-analyze" flag.

## Modules & tests

| Module | Responsibility |
| --- | --- |
| `js/utils/partner-contact-leadcheck.js` | Sufficiency gate, snapshot (phone-free), prompt, strict validator, coverage math, record persistence, shrink-to-fit, plain-text report |
| `js/utils/partner-contact-leadcheck-client.js` | Messages API call with `web_search` + `pause_turn` continuation loop |
| `js/views/admin-partner-detail.js` | Row button state machine, run orchestration, report / add-info modals, write-back by contact id |

Tests: `tests/partner-contact-leadcheck.test.mjs` — adversarial (unevidenced
managers, invented emails, fabricated reports, unsupported decision-maker
claims, ambiguous identities, checklist canonicalization, header
extension). Run with `npm test`.
