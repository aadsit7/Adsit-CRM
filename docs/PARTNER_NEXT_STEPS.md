# Partner Next Steps

The **Next Steps** section on the Partner Detail page — between the Partner
Bio and Upcoming Joint Events — holds the partner's forward agenda: the
concrete actions the description notes call for, each with its applicable
date and provenance.

## How it works

1. **Analyze** (the section's default action) opens a selection modal listing
   the partner's description notes (the Descriptions section's entries,
   newest first). The user ticks one or many — or Select all — and clicks
   Analyze.
2. The selected notes, and only those notes, are sent to the AI
   (`js/utils/partner-next-steps-client.js`) with **adaptive thinking at
   high effort** — the same "reason hard" request shape the AI Assistant's
   complex tier uses: deciding what is still open across several dated notes
   — where a newer note may close out what an older one promised — is
   genuine multi-document reasoning. The model gets no tools and no outside
   knowledge; the notes are the entire universe.
3. The reply is strictly validated (`js/utils/partner-next-steps-schema.js`)
   and the verified steps are **appended** to the agenda table. Re-analyzing
   later (same notes or new ones) appends again; steps already on the agenda
   are deduplicated by normalized text, never duplicated.
4. **Add Step** appends a manual row (step text + optional applicable date);
   **Delete** removes a row after confirmation. Analysis rows and manual rows
   live side by side, each labeled with its provenance.

## Accuracy contract

The model only *proposes* steps; the parser verifies every proposal before
anything is saved:

- **Verbatim evidence gate** — every proposed step must carry an `evidence`
  snippet copied character-for-character from one of the selected notes. The
  parser checks the snippet against the exact text the model saw (normalized
  only for case/whitespace/curly quotes, boundary-clean, via the same tested
  matcher Partner Contacts uses). The snippet must also clear a
  distinctiveness floor (at least 20 characters / 3 words) — a generic
  fragment like "follow up" occurs in almost any note, so matching one
  proves nothing. A step whose snippet is not literally in the notes, or is
  too generic to tie the step to a note, is dropped and reported — never
  saved. Long quotes are verified in full and stored cut on a word boundary,
  so the stored snippet stays a findable verbatim phrase.
- **Injection resistance** — note text is data, never instructions: the
  prompt says so explicitly, and the source builder neutralizes the prompt's
  own structural markers (`<<<`/`>>>` delimiters, markdown fences) in note
  text before the model or the evidence gate sees it, so a note cannot break
  out of its block or corrupt the reply's JSON extraction.
- **Date discipline** — an applicable date survives only as a well-formed
  real calendar date (`YYYY-MM-DD`) that the notes stated; "next week",
  "TBD" or a malformed value is stored as empty, never guessed. Relative
  references are resolved against the date of the note that states them,
  never against today.
- **Checkable provenance** — each analysis row records which note(s) it came
  from (their dates), the verbatim snippet (shown as the row's tooltip), and
  when the analysis ran. The table shows Analyzed/Added dates so re-analyses
  are distinguishable.
- **Forward-looking only** — completed work described in the notes is
  context, not a next step; the newest note wins when notes disagree.

## Storage

One row per step in the `Partner_Next_Steps` tab (created on first use;
older spreadsheets simply don't have it until then):

| column | meaning |
| --- | --- |
| `step_id` | `pns_…` record id (all writes/deletes are id-addressed) |
| `partner_id`, `partner_name` | owning partner |
| `next_step` | the action, plain language |
| `due_date` | `YYYY-MM-DD` or empty |
| `source` | `analysis` or `manual` |
| `source_dates` | dates of the notes the step came from, `; `-separated |
| `evidence` | the verbatim note snippet the step was verified against |
| `analyzed_at` | ISO datetime of the Analyze run (empty for manual rows) |
| `created_at`, `updated_at` | row timestamps |

The tab is registered in `SHEET_HEADERS`, `initializeSheet` and
`syncHeaders` (js/sheets.js), so Setup → Initialize Sheet creates it and
keeps its header row in sync.

## Files

- `js/utils/partner-next-steps-schema.js` — sheet contract, strict parser
  (evidence gate, date validation), dedupe, agenda ordering. Pure; tested in
  `tests/partner-next-steps-schema.test.mjs`.
- `js/utils/partner-next-steps-prompts.js` — the analysis prompt (grounding,
  verbatim evidence, date discipline, consolidation, plain language). Tested
  in `tests/partner-next-steps-prompts.test.mjs`.
- `js/utils/partner-next-steps-client.js` — the Anthropic Messages API hop
  (extended thinking, no tools), same conventions as the sibling clients.
- `js/views/admin-partner-detail.js` — the section, selection modal, run
  orchestration (global Randy pill progress), Add Step and Delete.
- `css/partner-next-steps.css` — section, table and modal styling.
