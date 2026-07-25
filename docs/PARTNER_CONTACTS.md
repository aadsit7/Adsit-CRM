# Partner Contacts (Partner Detail → Contacts section)

The Partner Detail page has a **Contacts** section between Opportunities and
Descriptions. It is expanded by default whenever a partner page opens —
the table matrix (the same Recast table chrome as the Events list) of every
person connected to that partner's record is immediately visible: **Name ·
Role · Company · Email · Analyzer PDF · Sources · Actions**. Clicking the header
collapses it, and that choice sticks for the session.

> **Analyzer PDF** replaced the old Phone column. Phone is still captured,
> stored on the `Partner_Contacts` row and edited in the contact modal — it just
> no longer costs a column on the roster, where the more useful question is
> "has this person been analyzed, and where is that brief?". The cell links to
> the contact's **Account Intelligence Brief** (the Analyzer's Contacts tab
> export) when one has been filed against that `contact_id`, dated so a stale
> brief is obvious, and shows `—` when there is none. Only a file the Analyzer
> generated counts: a PDF someone uploaded to the contact by hand is never
> presented as a brief. See
> [ANALYZER_PDF_AUTOATTACH.md](ANALYZER_PDF_AUTOATTACH.md) for how the link is
> resolved in a single sheet read.

Contacts are identified by analyzing the partner's **description notes and
attachments** — plus indexed meetings and partner documents — via the
**Scan Sources** action. They can also be added or corrected by hand
(**Add Contact** / Edit / Delete), and each row has an **Analyze** action
that verifies that individual from public professional sources — see
[PARTNER_CONTACT_LEADCHECK.md](PARTNER_CONTACT_LEADCHECK.md).

> **Accuracy is the design goal.** Nothing reaches the table unless it is
> literally present in this partner's own sources or was typed in manually.
> The model only *proposes*; application code *verifies* — the same
> philosophy as the Analyzer family. An empty cell means "not stated in the
> sources"; it is never a guess. One deliberate exception: **Company** —
> every row here is a partner-side person by the affiliation rule, so a
> blank company *is* the partner, and it is filled with the partner name
> (see "Company defaults to the partner name" below). Three further scan
> rules: a row must be a person on **the partner's side** of the
> relationship (the affiliation rule), one person must never become two
> rows (similar-name duplicate collapse), and a scan may only **create** a
> row for someone with a partner-domain email (the creation gate) — all
> below.

---

## Where contacts come from

| Source | Sheet / API | How it is read |
| --- | --- | --- |
| Description notes | `Transcripts` rows (`partner_id` match) | HTML stripped to prose, newest first |
| Indexed meetings | `Meeting_Index` rows (`partner_id` match) | Title/attendees/summary/decisions/topics combined |
| Partner documents | `Partner_Documents` rows (`partner_id` match) | `html_content` stripped to prose |
| Drive attachments | File API (`listFiles` keyed on `partner_id`) | Apps Script attendee pipeline (below) |

Scoping is **strict**: the selectors are the tested Partner Analyzer
selectors, so another partner's rows can never leak into a scan.

## The two extraction paths

**1. Attachments (deterministic-first).** Each attachment not yet marked
`analyzed` is sent to the existing Apps Script `analyzeDocument` action with
`analysisType: 'attendee_list'` — the same pipeline the Events modal uses.
Spreadsheets are read **deterministically** (Claude only maps columns; rows
are built in code and emails can't be hallucinated); PDFs/Word go through a
strict no-fabrication extraction. The returned HTML summary is appended to
the partner's Descriptions as a dated `📇` card (a durable, visible audit
trail, exactly like the Events flow), the file's `analyzed` flag is
persisted server-side so it is never re-processed, and the structured
contacts are saved with the file as provenance. If the deployed Apps Script
predates the attendee pipeline (no `contacts` array in the response), the
returned text is fed to path 2 instead — nothing breaks.

**2. Notes (propose → verify).** Descriptions, meetings and partner
documents are assembled into bounded, labelled sources
(`collectPartnerContactSources`) and sent to Claude with a strict-JSON
prompt whose Golden Rule mirrors the validator. Every returned contact is
then **verified verbatim** by `parsePartnerContactsResponse`:

- the **name** must be literally present in a cited source — exact phrase,
  or all name words within a 90-character window (accepts "Smith, John"
  for "John Smith"; rejects a name stitched together from two different
  people mentioned apart);
- **email** must appear exactly, boundary-checked (`an@b.co` can never
  match inside `ryan@b.com`);
- **phone** digits must equal a *complete* number as written in the source
  (a truncated or stitched number is rejected, `+1` country prefixes are
  understood);
- **role / company / evidence quote** must appear verbatim as a phrase —
  paraphrases ("IT Director" for "Director of IT") are blanked, not kept;
- cited source ids that don't exist or don't contain the person are
  dropped; a contact with no surviving source is discarded (and logged to
  the console as rejected).

**Truncation resilience.** A reply that hits the model's output-token
limit (`stop_reason: "max_tokens"`) used to fail the whole note scan with
`JSON Parse error: Expected ']'` — the JSON tail was cut off mid-array.
Now the client detects the stop reason and re-extracts the sources as two
half-size requests (up to a 4-way split); if a reply is still cut off or
otherwise malformed, the parser salvages every complete contact object
from the broken array (each still passes the full verbatim verification)
and flags the result `partial`, which the scan surfaces as a warning
("some people may be missing") instead of discarding everything.

## Non-blocking progress

A scan can run for minutes (attachment analysis alone is Apps-Script-capped
at ~6). It is therefore **fire-and-forget**: the moment it starts it drives a
floating Randy pill in the global body-fixed stack (`createPill`,
bottom-right, persists across route changes), so the user can leave the
partner page and keep working while it runs. Every stage (`Preparing…`,
`Attachment i/n…`, `Scanning notes…`, `Saving…`) updates the pill; the
in-page **Scan Sources** button mirrors the same state while it is on-screen
and is rebuilt in its `Scanning…` form if the view re-renders mid-scan
(tracked by `contactScanInFlight`, which now holds the partner id). Results
are persisted to the sheet regardless of where the user navigated, and the
Contacts list only re-renders if they are still on that partner's page. The
pill settles green with the merge summary (e.g. `2 added, 1 updated`), or
amber on failure.

## Who qualifies — the affiliation rule

A row in this table means "a person working for or representing **this
partner**" — not our own team, not a customer, not another vendor. The
scan enforces that in three layers:

- **Model reasoning.** The prompt asks the model to judge, for every
  person, whether the sources show them working for the partner
  (`works_for_partner: yes | no | unknown`), reasoning from the stated
  employer, email domain, title context and how they're referred to.
  Anyone marked `no` is excluded (an exclusion can only omit, never
  invent — so the model's judgment is safe to honor). `unknown` people
  are kept: partner notes rarely restate the employer.
- **Deterministic company check.** A contact whose *verified* company
  doesn't match the partner name is dropped. Matching is normalized —
  case, punctuation and legal suffixes ignored, short forms accepted
  ("Insight" ↔ "Insight Enterprises, Inc.", "CDW Canada" ↔ "CDW") — so a
  legal-name variant never reads as a different company.
- **Own-company backstop.** A verified company matching **Recast
  Software** (the CRM owner's own organization) is never saved as a
  partner contact, even if the model mislabels it `yes`, and with or
  without a partner name.

The same company filters apply to attendee rows from attachments, which
routinely mix in our own team and customer attendees. Every drop is
reported in the scan's `dropped` list (logged to the console).

## Company defaults to the partner name

Because the affiliation rule guarantees every row is a person on the
partner's side, the partner organization *is* their company — so no saved
contact is left with a blank Company. Extraction stays verbatim (a company
value from a scan still has to appear literally in a source); the default
applies at the moments a row is persisted or displayed:

- **Add Contact** opens with Company pre-filled with the partner's name —
  type over it for something more specific (a subsidiary, a legal name);
  a cleared field snaps back to the partner name on save. The row is
  written to the `Partner_Contacts` tab of the Google Sheet like every
  other contact, so it's there whenever the page is reopened.
- **Edit Contact** shows the same default when the saved row has no
  company.
- **Scan Sources** persists the partner name on any row it creates or
  touches whose company neither the sheet nor the verified sources state.
- **Opening the partner page** backfills older rows: any contact with a
  blank company is shown — and saved back to the sheet, in the background —
  with the partner name (`applyPartnerCompanyDefaults`). This is one-time
  per row; subsequent loads find nothing to fill.

The default only ever fills a blank. A manually entered company, or a
verbatim-verified richer form ("Insight Enterprises, Inc."), is never
overwritten by it.

## When a scan may create a row — the partner-email gate

A scan can **enrich** existing contacts freely, but it may **create** a
new row only for a person whose extracted email's domain aligns with the
partner company (`emailAlignsWithPartner`). Alignment is generous about
form but strict about identity: `dana@insight.com`, `us.insight.com`
subdomains, joined legal names (`insightenterprises.com`), a distinctive
token inside the label (`getnerdio.com` for Nerdio) and initialisms
(`wwt.com` for World Wide Technology) all count; free-mail and other
companies' domains never do. Everyone else the scan finds — no email, or
an email elsewhere — can only fill blanks / add provenance on rows that
already exist, and is reported in the merge's `skippedNew` list (shown in
the toast and logged to the console). Mentions of the same person with and
without an email still collapse: the emailed mention seeds the row and the
rest fold into it. **Add Contact** (manual) is unaffected by the gate.

## One person, one row — similar-name duplicate collapse

Duplicate mentions collapse into one contact: email first, then name —
exact first, then *similar-name reasoning*, so a spelling variant can
never mint a second row. Two names count as the same person when every
token of the shorter name accounts for a distinct token of the longer
one, where a token pair may differ by **one inserted/deleted character**
("Jack Smith" ↔ "Jack Smiths", "Jon" ↔ "John") or be an initial
("J. Smith" ↔ "Jack Smith"), and subset names fold into the fuller form
("Aaron" ↔ "Aaron Adsit"). Guard rails keep distinct people apart:

- substitutions never match — "Mark" / "Mary", "Dan" / "Don" stay two
  people;
- initials alone are never enough to link two names;
- a fuzzy match must be **unambiguous**: a bare "Aaron" with both
  "Aaron Adsit" and "Aaron Miller" on file stays separate rather than
  guessing;
- it never applies across two *different* emails, so two people sharing
  a name stay separate.

Source verification gets the same one-character tolerance per name word
("Jack Smith" verifies against a source that wrote "Jack Smiths") while
keeping the tight co-occurrence window that stops names being stitched
from two different people.

## Merge semantics (why manual edits survive)

Scan results merge into `Partner_Contacts` via `mergeExtractedContacts`:

- match by email (case-insensitive), else by name — exact first, then the
  similar-name reasoning above (unambiguous only, never when emails
  contradict) — so "Jack Smiths" updates the saved "Jack Smith" row
  instead of duplicating it;
- matches **fill blank fields only** and union `sources_json` — a saved
  value, including a manual correction, is never overwritten by a scan.
  One deliberate exception: a strictly *fuller* form of the same name
  upgrades the record ("Aaron" → "Aaron Adsit"); equal-length variants
  keep the saved spelling;
- unmatched people become new rows **only through the partner-email gate**
  (above) — no partner-domain email, no new row, reported in `skippedNew`;
  `first_seen`/`last_seen` track the source dates; re-running a scan with
  nothing new is a no-op.

Deleting a contact deletes its row; a later scan may re-add the person if
they still appear in the sources (the confirm dialog says so).

## Storage

New `Partner_Contacts` tab (created automatically on first scan / manual
add via `ensureSheetWithHeaders`, and by Setup → Initialize Sheet):

```
contact_id, partner_id, partner_name, name, role, company, email, phone,
evidence, sources_json, first_seen, last_seen, created_at, updated_at
```

`sources_json` is a JSON array of `{ type, id, label, date }` with
`type ∈ description | meeting | partner_document | attachment | manual` —
rendered as provenance chips in the table. `evidence` holds the verbatim
snippet backing the contact (shown as a tooltip on the name). Demo mode
persists the same rows in localStorage like every other sheet.

**No Apps Script change is required** — the attendee pipeline this reuses
is already deployed for Events, and the flow degrades to the verified
client-side path against older deployments.

## Modules & tests

| Module | Responsibility |
| --- | --- |
| `js/utils/partner-contacts.js` | Source collection, prompt, strict verbatim validation, attendee mapping, merge, company default, row (de)serialization |
| `js/utils/partner-contacts-client.js` | Anthropic call (same conventions/model as the other analyzers) |
| `js/views/admin-partner-detail.js` | Contacts section UI, table, add/edit/delete modals, scan orchestration |
| `js/sheets.js` | `Partner_Contacts` headers/init/demo + `ensureSheetWithHeaders` |

Tests: `tests/partner-contacts.test.mjs` — most are adversarial
(hallucinated people, invented emails, paraphrased titles, truncated
phones, cross-person stitching, name collisions, other-company and
own-company contacts, look-alike names that must NOT merge) plus scoping,
similar-name collapse, merge and round-trip coverage. Run with `npm test`.
