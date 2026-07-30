# Partner Next Steps

The **Next Steps** section on the Partner Detail page — between the Partner
Bio and Upcoming Joint Events — holds the partnership's **mutual action
plan**: one row per milestone, with a check-off box, the milestone itself
(major gates bold), its owner, its target timing and a one-word status,
ordered top-to-bottom as the plan runs. It is a living checklist rendered as
visual text in the section — designed to be read (or screen-shared) in a
working session, not exported.

## How it works

1. **Analyze** (the section's default action) opens a selection modal listing
   the partner's description notes (the Descriptions section's entries,
   newest first). The user ticks one or many — or Select all — and clicks
   Analyze.
2. The selected notes, and only those notes, are sent to the AI
   (`js/utils/partner-next-steps-client.js`) with **adaptive thinking at
   high effort**. Working out a plan across several dated notes — what has
   completed, what is in motion, which approval gate comes next, and in what
   sequence — is genuine multi-document reasoning. The model gets no tools
   and no outside knowledge; the notes are the entire universe.
3. The reply is strictly validated (`js/utils/partner-next-steps-schema.js`)
   and applied as a **living plan**: verified new steps are appended in plan
   order, and steps already on the plan whose state the newest notes moved
   forward (status progressed, a date firmed up) are **updated in place**.
   Nothing is ever deleted by an analysis — completed rows stay permanently
   as the visual record of momentum.
4. **Add Step** appends a manual row (step text + optional owner, status and
   target date); the **check-off box** on every row marks it Complete (or
   reopens it) live, without a re-analysis; **Delete** removes a row after
   confirmation. Analysis rows and manual rows live side by side, each
   labeled with its provenance.

## What the analysis extracts (the MAP protocols)

Beyond finding the actions, the prompt
(`js/utils/partner-next-steps-prompts.js`) applies the mutual-action-plan
standard:

- **Plan sequencing** — the rows come back in the order of the plan itself:
  every approval gate the notes describe is its own row in exactly the
  sequence the partner described it (never two gates merged into one);
  budget/pricing approval and a POC are separate rows with budget first;
  where the notes contain them, the tail runs budget approval → POC kickoff
  → POC validation → final decision → production rollout → onboarding.
  Sequencing is an *ordering* rule only — it never invents a row the notes
  don't support. Confirmed recurring meetings are rows too; a scheduling
  constraint is mentioned only when it collides with a step's timing.
- **Owner attribution** — every row names who is responsible, exactly as far
  as the notes support it: `Recast`, `<Partner> (Name)`, or `Both teams`.
  Unstated means empty, never guessed.
- **Fixed status vocabulary** — exactly one of `Complete`, `In Progress`,
  `Next` (at most one row), `Scheduled`, `Pending`. No other words, and no
  alarm language: a waiting row is Pending with neutral step text
  ("Awaiting Risk Management review"), never "stalled" or "blocked".
- **Gate weighting** — `kind` marks approval gates and major milestones
  (`gate`, rendered bold) apart from supporting sub-steps (`step`).
- **The plan, not a diary** — milestones of the plan the notes show as
  finished are rows with status Complete; past chatter that was never part
  of the path is not a row. The newest note decides the current state.
- **Target timing** — a hard `due_date` only when the notes state one;
  otherwise `timing` carries the notes' stated relative timing ("Post-ARB
  approval"); with neither, the row renders "To be scheduled". No date is
  ever invented to fill the column.
- **Client-safe wording** — every step is written as if it will be
  screen-shared with the partner: the partner's exact terminology (product
  and tool names spelled as the notes spell them, current-state tools never
  mixed with future plans), no sales vocabulary (prospect / lead / pipeline
  / close / deal / objection / blocker), no seller/buyer framing, and
  nothing internal — deal-stage assessments, org politics, off-record
  approvals, competitive intelligence. Whatever those rules filtered out or
  reworded is summarized in the reply's `note`, which the view surfaces to
  the account owner as an **internal** toast after the run (along with any
  ambiguous name, owner or date the model flagged) — so internal
  intelligence is tracked, just never on the plan itself.

## Accuracy contract

The model only *proposes* steps; the parser verifies every proposal before
anything is saved:

- **Verbatim evidence gate** — every proposed step must carry an `evidence`
  snippet copied character-for-character from one of the selected notes. The
  parser checks the snippet against the exact text the model saw (normalized
  only for case/whitespace/curly quotes, via the shared snippet matcher —
  deliberately no word-boundary guard, because HTML-stripped notes can glue a
  heading onto the first word of the clause being quoted, and a clause-length
  snippet cannot occur inside another word anyway). The snippet must also
  clear a distinctiveness floor (at least 20 characters / 3 words) — a
  generic fragment like "follow up" occurs in almost any note, so matching
  one proves nothing. A step whose snippet is not literally in the notes, or is
  too generic to tie the step to a note, is dropped and reported — never
  saved. Long quotes are verified in full and stored cut on a word boundary,
  so the stored snippet stays a findable verbatim phrase. The gate applies
  to every row, Complete ones included.
- **Injection resistance** — note text is data, never instructions: the
  prompt says so explicitly, and the source builder neutralizes the prompt's
  own structural markers (`<<<`/`>>>` delimiters, markdown fences) in note
  text before the model or the evidence gate sees it, so a note cannot break
  out of its block or corrupt the reply's JSON extraction.
- **Date discipline** — a target date survives only as a well-formed real
  calendar date (`YYYY-MM-DD`) that the notes stated; "next week", "TBD" or
  a malformed value is stored as empty, never guessed. Relative references
  are resolved against the date of the note that states them, never against
  today. Stated relative timing survives as text in `timing`, displayed in
  the Target column — it is never coerced into a date.
- **Vocabulary gates** — a status survives only as one of the five fixed
  words (case/spacing-forgiving; "Completed" canonicalizes to `Complete`);
  anything else — "Blocked", "On track", prose — reads back as empty rather
  than becoming a made-up state. Same for `kind` (`gate`/`step`). These
  gates also apply when re-reading rows hand-edited in the spreadsheet.
- **Checkable provenance** — each analysis row records which note(s) it came
  from (their dates), the verbatim snippet (shown as the row's tooltip), and
  when the analysis ran (in the provenance chip's tooltip).

## The living-plan rule (dedupe + merge)

A re-analysis matches proposals against the saved plan by normalized step
text (`dedupeNextSteps`), splitting them three ways:

- **fresh** — not on the plan yet → appended at the end, in plan order (the
  plan grows as notes reveal new gates);
- **updates** — already on the plan and *progressed* (`nextStepProgressed`:
  a different non-empty status, or a non-empty date that differs) → the
  saved row is updated in place via `mergeNextStepUpdate`, which is
  deliberately conservative: identity fields are untouched, an empty
  proposal never blanks a stored value, `gate` is sticky, and evidence /
  source dates / the analysis stamp refresh to the newest run. A mere
  rewording of owner or timing text is *not* progression — it would churn
  the sheet on every re-analysis;
- **skipped** — already on the plan and unchanged → nothing to do.

Rows are never removed by an analysis. Ordering
(`selectPartnerNextSteps`) preserves the stored row order — the plan's
sequence — with no date re-sort: "Contract signature — post-POC" has no
calendar date yet belongs after the POC rows.

## Storage

One row per step in the `Partner_Next_Steps` tab (created on first use;
older spreadsheets simply don't have it until then):

| column | meaning |
| --- | --- |
| `step_id` | `pns_…` record id (all writes/deletes are id-addressed) |
| `partner_id`, `partner_name` | owning partner |
| `next_step` | the milestone/action, plain client-safe language |
| `due_date` | `YYYY-MM-DD` or empty |
| `source` | `analysis` or `manual` |
| `source_dates` | dates of the notes the step came from, `; `-separated |
| `evidence` | the verbatim note snippet the step was verified against |
| `analyzed_at` | ISO datetime of the Analyze run that created/last touched it |
| `created_at`, `updated_at` | row timestamps |
| `owner` | `Recast`, `<Partner> (Name)`, `Both teams`, or empty |
| `status` | one of the five fixed words, or empty |
| `timing` | stated relative timing ("Post-ARB approval"), or empty |
| `kind` | `gate` or `step` |

The four plan columns are **appended after** the original schema so
`ensureSheetWithHeaders` can extend an existing tab's header row in place —
data columns keep their positions, and older rows read back with empty plan
fields. The tab is registered in `SHEET_HEADERS`, `initializeSheet` and
`syncHeaders` (js/sheets.js), so Setup → Initialize Sheet creates it and
keeps its header row in sync.

## Files

- `js/utils/partner-next-steps-schema.js` — sheet contract, strict parser
  (evidence gate, date/status/kind validation), living-plan dedupe + merge,
  plan ordering. Pure; tested in `tests/partner-next-steps-schema.test.mjs`.
- `js/utils/partner-next-steps-prompts.js` — the analysis prompt (grounding,
  verbatim evidence, plan sequencing, owner attribution, status vocabulary,
  date/timing discipline, client-safe wording, consolidation). Tested in
  `tests/partner-next-steps-prompts.test.mjs`.
- `js/utils/partner-next-steps-client.js` — the Anthropic Messages API hop
  (extended thinking, no tools), same conventions as the sibling clients.
- `js/views/admin-partner-detail.js` — the section, selection modal, run
  orchestration (global Randy pill progress), live check-off, Add Step and
  Delete.
- `css/partner-next-steps.css` — the plan table (status pills, completed
  tint, check-off box — and deliberately no red), section and modal styling.
